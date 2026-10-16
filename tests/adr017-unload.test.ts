import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as settle} from 'node:timers/promises';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessFactory,Activity} from '../harness/contracts.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import type {IdleClock} from '../src/idle-workers.ts';
import {ControlledHarness} from './fixtures/harness.ts';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
class Clock implements IdleClock {
 time=0;tasks=new Map<()=>void,number>();now(){return this.time;}
 schedule(task:()=>void,delay:number){this.tasks.set(task,this.time+delay);return ()=>this.tasks.delete(task);}
 advance(ms:number){this.time+=ms;for(const [task,at]of [...this.tasks])if(at<=this.time){this.tasks.delete(task);task();}}
}
async function until(ready:()=>boolean){while(!ready())await settle();}
class Resident extends ControlledHarness {
 revision=0;blockers:Activity['blockers']=[];token:string|undefined;reserveGate:ReturnType<typeof gate>|undefined;closeGate:ReturnType<typeof gate>|undefined;reserveFailure=false;closeFailure=false;reserveEntered=gate();closeStarted=gate();
 constructor(id:string,permission:ConstructorParameters<typeof ControlledHarness>[1],model:string){super(id,permission,model);this.on('status',()=>this.changed());}
 snapshot():Activity{return {revision:this.revision,eligible:this.status==='idle'&&!this.blockers.length,blockers:this.status==='running'?[{kind:'running'}]:this.blockers,...this.token?{reservation:this.token}:{}};}
 changed(){this.revision++;this.emit('residency',{sessionId:this.id,...this.snapshot()});}
 override async close(){if(this.closeFailure)throw new Error('Process settlement failed');return super.close();}
 override async activity(){return this.snapshot();}
 override async suspend(sessionId:string,revision:number,canCommit:()=>boolean){
  this.reserveEntered.resolve();if(this.reserveGate)await this.reserveGate.promise;
  if(this.reserveFailure)throw new Error('Lost reserve response');
  if(!this.snapshot().eligible||revision!==this.revision||!canCommit())return {suspended:false,snapshot:this.snapshot()};
  this.token='reservation';this.emit('suspending');await this.closeSession(sessionId);await this.close();return {suspended:true,snapshot:this.snapshot()};
 }
 override async closeSession(sessionId:string){this.closeStarted.resolve();if(this.closeGate)await this.closeGate.promise;await super.closeSession(sessionId);}

}
async function fixture(t:TestContext,options:{idleMs?:number|null;initial?:boolean}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-idle-owner-'))),config={...await loadConfig(),stateRoot:root,verification:false,...options.idleMs!==undefined?{workerIdleUnloadMs:options.idleMs}:{}};
 const clock=new Clock(),tree=new ResearchTree(config);await tree.initialize();
 const project=await tree.createProject(randomUUID(),'Idle research'),node=await tree.ensureMain(project.id),harnesses:Resident[]=[];
 const factory:HarnessFactory=(settings,home,_workspace,_budget,permission)=>{const h=new Resident(`session-${basename(home)}`,permission,(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));harnesses.push(h);return h;};
 const agents=new AgentManager(config,tree,async()=>false,factory,{clock});
 const worker=options.initial?agents.ensureInitialWorker(project.id,node):agents.create(project.id,node,randomUUID(),{title:'Analyst',systemPrompt:{text:'Keep this role',sourcePath:'/captured.md'}});
 const view=()=>agents.get(worker.id),send=(text:string)=>agents.submit(project.id,node,worker.id,{id:randomUUID(),text});
 t.after(async()=>{for(const h of harnesses){h.reserveGate?.resolve();h.closeGate?.resolve();h.complete();}await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
 const first=await send('Initial task');await until(()=>view().state==='running');const h=harnesses[0]!;h.complete();await until(()=>(config.workerIdleUnloadMs===null||clock.tasks.size===1)&&view().submissions.find(s=>s.id===first.id)?.state==='applied');
 return {config,clock,tree,agents,project:project.id,node,worker,h,harnesses,view,send};
}

test('six continuous idle minutes unload execution and the next message resumes the same session', {timeout:10000},async t=>{
 const f=await fixture(t),session=f.view().harnessSessionId;
 f.clock.advance(359999);for(let i=0;i<3;i++)assert.equal(f.agents.get(f.worker.id).state,'idle');
 assert.equal(f.h.calls.some(c=>c.method==='closeSession'),false);
 f.clock.advance(1);await until(()=>f.view().state==='inactive');
 assert.equal(f.h.exited,true);assert.ok(f.view().residency.lastUnloadedAt);assert.equal(f.view().harnessSessionId,session);
 assert.deepEqual(f.view().creation,f.worker.creation);
 const next=await f.send('Next task');await until(()=>f.harnesses.length===2&&f.view().state==='running');
 assert.ok(f.harnesses[1]!.calls.some(c=>c.method==='activate'&&(c.params as {sessionId:string|null}).sessionId!==null));assert.equal(f.view().harnessSessionId,session);
 f.harnesses[1]!.complete();assert.equal(f.view().submissions.filter(s=>s.id===next.id).length,1);
});

test('native jobs, descendants, goals, reminders and unknown producers prevent unload', {timeout:10000},async t=>{
 const f=await fixture(t);
 for(const kind of ['job','descendant','goal','schedule','dynamic-plugin','unknown'] as const){
  f.h.blockers=[{kind}];f.h.changed();assert.ok(f.view().residency.blockers.includes(kind));
  f.clock.advance(360000);await settle();assert.equal(f.h.calls.some(c=>c.method==='closeSession'),false);
 }
 f.h.blockers=[];f.h.changed();f.clock.advance(359999);await settle();assert.equal(f.view().state,'idle');
 f.clock.advance(1);await until(()=>f.view().state==='inactive');
});

test('Send before reservation commit abandons unload and delivers once to the existing process', {timeout:10000},async t=>{
 const f=await fixture(t);f.h.reserveGate=gate();f.clock.advance(360000);await f.h.reserveEntered.promise;
 const next=await f.send('Arrived during reservation');f.h.reserveGate.resolve();
 await until(()=>f.view().state==='running');assert.equal(f.harnesses.length,1);assert.equal(f.h.calls.some(c=>c.method==='closeSession'),false);
 assert.equal(f.h.messages.filter(m=>m.requestId===next.id).length,1);f.h.complete();
});

test('Send after committed unload waits for process settlement and resumes without replay', {timeout:10000},async t=>{
 const f=await fixture(t);f.h.closeGate=gate();f.clock.advance(360000);await f.h.closeStarted.promise;
 const next=await f.send('Arrived during closure');assert.equal(f.view().submissions.find(s=>s.id===next.id)?.state,'pending');assert.equal(f.h.messages.length,0);
 f.h.closeGate.resolve();await until(()=>f.harnesses.length===2&&f.view().state==='running');
 assert.equal(f.harnesses[1]!.messages.filter(m=>m.requestId===next.id).length,1);f.harnesses[1]!.complete();
 assert.equal(f.view().submissions.find(s=>s.id===next.id)?.state,'applied');
});

test('manual Close during unload retains explicit Resume semantics', {timeout:10000},async t=>{
 const f=await fixture(t);f.h.closeGate=gate();f.clock.advance(360000);await f.h.closeStarted.promise;
 const closed=f.agents.closeWorker(f.project,f.node,f.worker.id);f.h.closeGate.resolve();await closed;
 assert.equal(f.view().state,'closed');await assert.rejects(f.send('Must not reopen'),/explicitly resume/);
 await f.agents.resume(f.project,f.node,f.worker.id);assert.equal(f.view().state,'idle');
});


test('manual Close recovers a concurrently failed automatic reservation', {timeout:10000},async t=>{
 const f=await fixture(t),failures:unknown[]=[];f.agents.on('failure',event=>failures.push(event));
 f.h.reserveGate=gate();f.h.reserveFailure=true;f.clock.advance(360000);await f.h.reserveEntered.promise;
 const closed=f.agents.closeWorker(f.project,f.node,f.worker.id);f.h.reserveGate.resolve();await closed;
 assert.equal(f.view().state,'closed');assert.equal(f.h.exited,true);
 assert.ok(f.h.calls.some(c=>c.method==='closeSession'));assert.ok(failures.length);
});


test('approval, invalid evidence and configuration lifecycle reset confirmed inactivity', {timeout:10000},async t=>{
 const f=await fixture(t),approval=f.h.askPermission('review');await until(()=>f.view().permissions.length===1);
 f.clock.advance(360000);await settle();assert.ok(f.view().residency.blockers.includes('approval'));assert.equal(f.view().state,'idle');
 f.agents.permission(f.project,f.node,f.worker.id,f.view().permissions[0]!.id,'allow-once');await approval;
 f.h.emit('residency',{sessionId:f.h.id,revision:f.h.revision+1,eligible:false,blockers:[{kind:'unknown'}]});assert.ok(f.view().residency.blockers.includes('unknown'));
 f.clock.advance(360000);await settle();assert.equal(f.view().state,'idle');f.h.changed();
 await assert.rejects(f.agents.configure(f.project,f.node,f.worker.id,'model','not-advertised'),/advertised/);
 f.clock.advance(359999);await settle();assert.equal(f.view().state,'idle');f.clock.advance(1);await until(()=>f.view().state==='inactive');
});

test('failed process settlement retains capacity and recovery never replays accepted messages', {timeout:10000},async t=>{
 const f=await fixture(t),failures:unknown[]=[];f.agents.on('failure',event=>failures.push(event));f.config.maxActiveWorkers=2;
 const resident=f.agents.create(f.project,f.node,randomUUID(),{title:'Resident'});
 await f.agents.submit(f.project,f.node,resident.id,{id:randomUUID(),text:'Independent work'});await until(()=>f.harnesses.length===2&&f.agents.get(resident.id).state==='running');
 f.harnesses[1]!.blockers=[{kind:'goal'}];f.harnesses[1]!.complete();
 f.h.closeFailure=true;f.clock.advance(360000);await until(()=>f.view().state==='uncertain'&&f.view().residency.phase!=='unloading');
 assert.equal(f.h.exited,false);assert.equal(f.view().cleanupPending,true);assert.ok(failures.length);
 const other=f.agents.create(f.project,f.node,randomUUID(),{title:'Waiting'});
 const queued=await f.agents.submit(f.project,f.node,other.id,{id:randomUUID(),text:'Wait for capacity'});
 await until(()=>f.agents.get(other.id).submissions.find(s=>s.id===queued.id)?.state==='failed');
 assert.equal(f.harnesses.length,2);assert.equal(f.agents.get(other.id).submissions[0]!.retryable,true);
 f.h.closeFailure=false;await f.agents.closeWorker(f.project,f.node,f.worker.id);assert.equal(f.h.exited,true);
 f.agents.retry(f.project,f.node,other.id,queued.id);await until(()=>f.harnesses.length===3&&f.agents.get(other.id).state==='running');
 assert.equal(f.harnesses[2]!.messages.filter(m=>m.requestId===queued.id).length,1);f.harnesses[2]!.complete();
});


test('the same residency policy unloads initial workers and null disables scheduling', {timeout:10000},async t=>{
 const initial=await fixture(t,{initial:true});initial.clock.advance(360000);await until(()=>initial.view().state==='inactive');
 const disabled=await fixture(t,{idleMs:null});disabled.clock.advance(720000);await settle();
 assert.equal(disabled.clock.tasks.size,0);assert.equal(disabled.view().residency.phase,'disabled');assert.equal(disabled.view().state,'idle');
});
