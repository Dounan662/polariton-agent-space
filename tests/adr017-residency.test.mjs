import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Jobs from '@deepseek-ai/dsh-jobs-local';
import {Residency} from '../harness/residency.mjs';
import {ResidencySnapshot} from '../harness/settings.ts';
import Goals from '@deepseek-ai/dsh-goal';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as SpawnSubagent from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import DynamicPlugins from '@deepseek-ai/dsh-cordis-host-runner';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import FileSystem from '@deepseek-ai/dsh-fs-local';

/** Public pinned-DSH lifecycle qualification; the adapter never opens a network connection. */
async function fixture(t,{omit}={}) {
  const ctx=new Context(),requests=[],handles=[],releases=[];
  for(const plugin of [SystemPrompt,Tools,Agents,Sessions,Projections,Llm,AgentLoop,Jobs,Goals,DynamicPlugins])if(plugin!==omit)await ctx.plugin(plugin,{});
  ctx.get('jobs')?.attachController('residency-qualification');
  class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']};}
    async *stream(request){
      requests.push(request);
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text:'Completed'};
      yield {type:'block-end',index:0,block:{type:'text',text:'Completed'}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['controlled'],new Adapter());
  const create=async(id,options={})=>{
    const handle=await ctx.agents.create({sessionId:id,agentOptions:{provider:'controlled',model:'local'},...options});
    handles.push(handle);return handle;
  };
  const root=await create('root');
  t.after(async()=>{for(const release of releases)release();await Promise.all(handles.map(handle=>handle.dispose()));await ctx.fiber.dispose();});
  const hold=()=>{const gate=Promise.withResolvers();releases.push(gate.resolve);return gate;};
  return {ctx,root,requests,create,hold};
}
const input=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});

test('maintenance claims idle synchronously, hides its ownership from status, and preserves racing input on release',{timeout:5000},async t=>{
  const {root,hold,requests}=await fixture(t),gate=hold();let entered=false;
  const reserved=root.agent.runMaintenance(()=>{entered=true;return gate.promise;});
  assert.equal(entered,true);
  assert.equal(root.agent.status,'idle');
  assert.throws(()=>root.agent.runMaintenance(async()=>{}),/active work/);
  const message=input('arrived after reservation');root.agent.steer(message);
  assert.equal(root.agent.status,'idle');assert.equal(root.agent.inbox.nextStep[0].id,message.id);
  await nextTurn();assert.equal(requests.length,0);
  gate.resolve();await reserved;await root.agent.whenIdle();
  assert.equal(requests.length,1);
  const committed=root.agent.session.snapshotEvents().filter(event=>event.type==='user/message');
  assert.deepEqual(committed.map(event=>event.data.id),[message.id]);
});

test('handle disposal settles an abort-aware reservation without a turn or deadlock',{timeout:5000},async t=>{
  const {ctx,root,requests}=await fixture(t);let cause;
  const reserved=root.agent.runMaintenance(signal=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{cause=signal.reason;resolve();},{once:true});
  }));
  await root.dispose();await reserved;
  assert.equal(cause.kind,'disposed');assert.equal(ctx.agents.get(root.agent.id),undefined);
  assert.equal(requests.length,0);
});

test('disposal clears accepted input behind maintenance: rechecking inbox and fencing admission are mandatory',{timeout:5000},async t=>{
  const {ctx,root,requests}=await fixture(t),discarded=[];
  ctx.on('agent/inbox/discarded',({message})=>discarded.push(message.id));
  const reserved=root.agent.runMaintenance(signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})));
  const message=input('accepted after the idle check');root.agent.steer(message);
  await root.dispose();await reserved;
  assert.deepEqual(discarded,[message.id]);assert.equal(requests.length,0);
});

test('reserving every published agent does not fence an already admitted unpublished child',{timeout:5000},async t=>{
  const f=await fixture(t),setup=f.hold(),entered=f.hold(),reservation=f.hold();
  const pending=f.create('child',{parentAgent:f.root.agent,meta:{parentSession:f.root.agent.id,origin:'subagent'},setup:async()=>{entered.resolve();await setup.promise;}});
  await entered.promise;
  assert.deepEqual(f.ctx.agents.list().map(agent=>agent.id),['root']);
  const reserved=f.ctx.agents.list().map(agent=>agent.runMaintenance(()=>reservation.promise));
  setup.resolve();const child=await pending;
  child.agent.steer(input('child work admitted before publication'));await child.agent.whenIdle();
  assert.equal(f.requests.length,1);assert.equal(f.root.agent.status,'idle');
  assert.throws(()=>f.root.agent.runMaintenance(async()=>{}),/active work/);
  reservation.resolve();await Promise.all(reserved);
});

test('background registration makes unpublished startup and stopping visible until producer settlement',{timeout:5000},async t=>{
  const f=await fixture(t),setup=f.hold(),entered=f.hold(),finish=f.hold();
  let child;
  const id=f.ctx.jobs.start({kind:'subagent',label:'pending child startup',owner:f.root.agent.id,run:()=>({
    cancel(){},
    done:(async()=>{
      child=await f.create('job-child',{parentAgent:f.root.agent,meta:{parentSession:f.root.agent.id,origin:'subagent'},setup:async()=>{entered.resolve();await setup.promise;}});
      await finish.promise;await child.dispose();return {status:'killed'};
    })(),
  })});
  await entered.promise;
  assert.deepEqual(f.ctx.agents.list().map(agent=>agent.id),['root']);
  assert.equal(f.ctx.jobs.get(id,f.root.agent.id).status,'running');
  f.ctx.jobs.kill(id,f.root.agent.id);
  assert.equal(f.ctx.jobs.get(id,f.root.agent.id).status,'stopping');
  const settled=Promise.withResolvers();f.ctx.jobs.events.subscribe({owners:'all'},event=>{if(event.type==='settled'&&event.job.id===id)settled.resolve(event.job);});
  setup.resolve();finish.resolve();assert.equal((await settled.promise).status,'killed');
});

test('residency rejects stale cuts and holds admission through committed disposal',{timeout:5000},async t=>{
  const f=await fixture(t),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  const first=ResidencySnapshot.parse(observer.inspect('root'));
  assert.equal(first.eligible,true);
  assert.deepEqual(observer.inspect('root'),first,'Read-only observation never restarts the idle interval');
  await observer.admit(async()=>{});
  assert.equal(observer.reserve('root',first.revision).reserved,false);
  const reserved=observer.reserve('root',observer.inspect('root').revision);
  assert.equal(reserved.reserved,true);
  assert.equal(observer.commit('root',reserved.token).committed,true);
  await assert.rejects(observer.admit(async()=>assert.fail('Cannot run')),error=>error.code==='WORKER_UNLOADING');
  await f.root.dispose();assert.equal(observer.inspect('root').reservation,undefined);
});

test('an admitted message racing a precommit reservation is preserved by abandoning closure',{timeout:5000},async t=>{
  const f=await fixture(t),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  const reserved=observer.reserve('root',observer.inspect('root').revision),message=input('racing independent wake');
  f.root.agent.followup(message);
  assert.equal(observer.commit('root',reserved.token).committed,false);
  await f.root.agent.whenIdle();assert.equal(f.requests.length,1);
  assert.equal(f.root.agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.id===message.id).length,1);
});

test('uncommitted reservations expire; committed reservations retain admission until lifecycle settlement',{timeout:5000},async t=>{
  const f=await fixture(t),timers=[],observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false,schedule:fn=>{timers.push(fn);return fn;},unschedule:()=>{}});
  const abandoned=observer.reserve('root',observer.inspect('root').revision);timers.shift()();
  assert.equal(observer.commit('root',abandoned.token).committed,false);
  await f.root.agent.whenIdle();
  const committed=observer.reserve('root',observer.inspect('root').revision);
  assert.equal(observer.commit('root',committed.token).committed,true);timers.shift()();
  await assert.rejects(observer.admit(async()=>{}),error=>error.code==='WORKER_UNLOADING');
  await f.root.dispose();
});

test('pending content admission and running or stopping jobs block reservations',{timeout:5000},async t=>{
  const f=await fixture(t),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false}),admission=f.hold(),done=f.hold();
  const inputWork=observer.admit(()=>admission.promise);
  assert(observer.inspect('root').blockers.some(value=>value.kind==='admission'));
  admission.resolve();await inputWork;
  const id=f.ctx.jobs.start({kind:'subagent',label:'background operation',owner:f.root.agent.id,run:()=>({cancel(){},done:done.promise})});
  assert(observer.inspect('root').blockers.some(value=>value.kind==='job'));
  f.ctx.jobs.kill(id,f.root.agent.id);
  assert(observer.inspect('root').blockers.some(value=>value.kind==='job'));
  done.resolve({status:'killed'});
  await nextTurn();assert.equal(observer.inspect('root').eligible,true);
});

test('competing maintenance is observable as a refused reservation and never gets cancelled',{timeout:5000},async t=>{
  const f=await fixture(t),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false}),gate=f.hold();let aborted=false;
  const existing=f.root.agent.runMaintenance(signal=>{signal.addEventListener('abort',()=>{aborted=true;});return gate.promise;});
  const result=observer.reserve('root',observer.inspect('root').revision);
  assert.equal(result.reserved,false);assert.equal(result.snapshot.blockers[0].kind,'maintenance');assert.equal(aborted,false);
  gate.resolve();await existing;
  const reserved=observer.reserve('root',observer.inspect('root').revision);assert.equal(reserved.reserved,true);observer.release(reserved.token);
});

test('armed goals block unloading even with no running driver',{timeout:5000},async t=>{
  const f=await fixture(t);
  const observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  const goal=f.ctx.goals.create(f.root.agent,{objective:'Await useful progress',maxGoalRounds:3});
  assert.equal(f.root.agent.status,'idle');assert(observer.inspect('root').blockers.some(value=>value.kind==='goal'));
  f.ctx.goals.pause(f.root.agent,{id:goal.id,revision:goal.revision});
  assert.equal(observer.inspect('root').eligible,true);

});

test('native subagent startup and result delivery retain residency until settlement',{timeout:5000},async t=>{
  const f=await fixture(t),entered=f.hold(),start=f.hold();
  const directory=await mkdtemp(join(tmpdir(),'polariton-residency-tool-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await f.ctx.plugin(Persistence,{root:directory});
  const observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  await f.ctx.plugin(FileSystem,{});await f.ctx.plugin(WorkingDirectory,{});
  await f.ctx.plugin(Subagents,{});await f.ctx.plugin(SpawnSubagent,{});await f.ctx.plugin(SubagentTool,{provider:'spawn'});
  f.ctx.on('agent/created',async({agent})=>{if(agent.id!=='root'){entered.resolve();await start.promise;}},{global:true});
  const settled=Promise.withResolvers();f.ctx.on('subagent/end',()=>settled.resolve(),{global:true});
  const response=observer.admit(()=>f.ctx.tools.execute({callId:'native-background',name:'subagent',arguments:{description:'Native child',prompt:'Finish a controlled turn'},agent:f.root.agent,signal:new AbortController().signal}));
  await entered.promise;
  assert.equal(observer.inspect('root').eligible,false,'Pending child admission cannot be suspended');
  start.resolve();
  assert.equal((await response).isError,false);
  await settled.promise;await f.root.agent.whenIdle();
  await nextTurn();assert.equal(observer.inspect('root').eligible,true,JSON.stringify(observer.inspect('root')));
});

test('continuable child disposal stays blocked until its late parent notification is admitted',{timeout:5000},async t=>{
  const f=await fixture(t),directory=await mkdtemp(join(tmpdir(),'polariton-residency-child-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await f.ctx.plugin(Persistence,{root:directory});await f.ctx.plugin(FileSystem,{});await f.ctx.plugin(WorkingDirectory,{});
  await f.ctx.plugin(Subagents,{});await f.ctx.plugin(SpawnSubagent,{});
  const observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false}),ended=Promise.withResolvers();let atRemoval,atEnd;
  f.ctx.on('agent/disposed',({agent})=>{if(agent.id!=='root')atRemoval=observer.inspect('root');},{global:true});
  f.ctx.on('subagent/end',()=>{atEnd=observer.inspect('root');ended.resolve();},{global:true});
  await observer.admit(()=>f.ctx.subagents.startActivation({provider:'spawn',delivery:'parent',label:'continuable child',request:{parent:f.root.agent,prompt:[{type:'text',text:'Complete this turn'}],maxDepth:3},signal:new AbortController().signal}));
  await ended.promise;await f.root.agent.whenIdle();
  assert(atRemoval.blockers.some(value=>value.kind==='descendant'),JSON.stringify(atRemoval));
  assert(atEnd.blockers.some(value=>value.kind==='inbox'||value.kind==='running'),JSON.stringify(atEnd));
  assert.equal(observer.inspect('root').eligible,true,JSON.stringify(observer.inspect('root')));
  assert.equal(f.requests.length,2,'The child and its parent settlement response both finish');
});

test('active dynamic plugin code is an explicit unqualified producer blocker',{timeout:5000},async t=>{
  const f=await fixture(t);
  const observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false}),plugin=f.ctx.dynamicCordisRunner.define({sessionId:'root',plugin:{kind:'new',idPrefix:'idle'},name:'Residency fixture',purpose:'Exercise the dynamic producer boundary',code:{host:'return { name: "residency-fixture", apply() {} };'}});
  assert.equal(observer.inspect('root').blockers.some(value=>value.kind==='dynamic-plugin'),false,'Definition alone executes nothing');
  const result=await f.ctx.dynamicCordisRunner.run(f.root.agent,plugin.pluginId,plugin.packageId,'run');
  assert.equal(result.status,'running',JSON.stringify(result));
  assert(observer.inspect('root').blockers.some(value=>value.kind==='dynamic-plugin'&&value.detail===plugin.pluginId));
  await f.ctx.dynamicCordisRunner.stop(f.root.agent,plugin.pluginId);
  assert.equal(observer.inspect('root').blockers.some(value=>value.kind==='dynamic-plugin'),false);
});

for(const [name,service] of [['jobs',Jobs],['goals',Goals]])
test(`missing ${name} service prevents unloading with an explicit unknown-state diagnostic`,{timeout:5000},async t=>{
  const f=await fixture(t,{omit:service}),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  const snapshot=observer.inspect('root');
  assert.equal(snapshot.eligible,false);
  assert(snapshot.blockers.some(value=>value.kind==='unknown'&&value.detail.endsWith(name)));
  assert.equal(observer.reserve('root',snapshot.revision).reserved,false);
});

test('absent ACP dynamic producer is inert, but losing a previously observed dynamic service is unknown',{timeout:5000},async t=>{
  const f=await fixture(t,{omit:DynamicPlugins}),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
  assert.equal(observer.inspect('root').eligible,true);
  const plugin=await f.ctx.plugin(DynamicPlugins,{});
  assert.equal(observer.inspect('root').eligible,true);
  await plugin.dispose();
  const snapshot=observer.inspect('root');assert.equal(snapshot.eligible,false);
  assert(snapshot.blockers.some(value=>value.kind==='unknown'&&value.detail.endsWith('dynamicCordisRunner')));
});

for(const committed of [false,true])test(`unexpected maintenance rejection invalidates ${committed?'committed':'uncommitted'} reservation proof`,{timeout:5000},async()=>{
  const failed=Promise.withResolvers(),errors=[],notifications=[];
  // A failing adjacent Agent implementation exercises the observation boundary;
  // no pinned DSH internals or lifecycle methods are replaced in this fixture.
  const agent={id:'root',status:'idle',inbox:{nextStep:[],nextTurn:[]},session:{inheritedEventCount:0,snapshotEvents:()=>[]},runMaintenance:()=>failed.promise};
  const services={jobs:{list:()=>[],events:{subscribe(){}}},goals:{get:()=>undefined},dynamicCordisRunner:{inventory:()=>[]}};
  const ctx={agents:{get:()=>agent,list:()=>[agent],roots:()=>[agent]},get:name=>services[name],on(){},effect(){},logger:{error:(...args)=>errors.push(args),warn(){}}};
  const observer=new Residency(ctx,{deadlineMs:5000,requireSchedule:false,changed:(_id,snapshot)=>notifications.push(snapshot)});
  const reserved=observer.reserve('root',observer.inspect('root').revision);
  if(committed)assert.equal(observer.commit('root',reserved.token).committed,true);
  failed.reject(new Error('Controlled adjacent driver failure'));await nextTurn();
  const snapshot=observer.inspect('root');
  assert.equal(snapshot.eligible,false);assert(snapshot.blockers.some(value=>value.kind==='unknown'));
  assert.equal(snapshot.reservation,committed?reserved.token:undefined);
  assert.equal(errors.length,1);assert(notifications.some(value=>!value.eligible));
  if(committed){
    assert.equal(observer.commit('root',reserved.token).committed,false);
    await assert.rejects(observer.admit(async()=>{}),error=>error.code==='WORKER_UNLOADING');
  }
  observer.release(reserved.token);
  assert.equal(observer.reserve('root',observer.inspect('root').revision).reserved,false,'A new reservation cannot erase failed proof');
});

/** New host schedules are owned by the real upstream service. Only its adjacent
 * session resolver is fake; storage, notifications, tools and delivery are real. */
async function schedules(t,f) {
 const directory=await mkdtemp(join(tmpdir(),'polariton-host-schedule-'));
 const [{default:Storage},Json,{default:Typert},Domain,{default:Schedule}]=await Promise.all([
  import('@deepseek-ai/dsh-storage'),import('@deepseek-ai/dsh-storage-json'),import('@deepseek-ai/dsh-typert-registry'),import('@deepseek-ai/dsh-storage-domain'),import('@deepseek-ai/dsh-schedule'),
 ]);
 await f.ctx.plugin(Storage,{});await f.ctx.plugin(Json,{root:join(directory,'storage')});await f.ctx.plugin(Domain,{backend:'json'});await f.ctx.plugin(Typert,{});
 await f.ctx.plugin(Persistence,{root:join(directory,'sessions')});
 f.ctx.provide('sessionController',{resolveAgent:async sessionId=>({agent:f.ctx.agents.get(sessionId)})});
 const service=await f.ctx.plugin(Schedule,{});
 t.after(async()=>{await service.dispose();await rm(directory,{recursive:true,force:true});});
 return f.ctx.schedule;
}

test('host reminders block suspension independently of session events and release after explicit deletion',{timeout:5000},async t=>{
 const f=await fixture(t),schedule=await schedules(t,f),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:true});
 assert.equal(observer.inspect('root').eligible,false,'Unobserved catalog cannot prove idle');
 await nextTurn();assert.equal(observer.inspect('root').eligible,true);
 const task=await schedule.create(f.root.agent.id,{title:'Retained reminder',prompt:'Continue later',after_seconds:60});
 assert(observer.inspect('root').blockers.some(value=>value.kind==='schedule'),'Change invalidates catalog before another asynchronous read');
 await nextTurn();assert(observer.inspect('root').blockers.some(value=>value.detail===task.id));
 assert.equal(f.root.agent.session.snapshotEvents().some(event=>event.type==='schedule/change'),false,'Host reminders have no legacy session records');
 const before=observer.inspect('root');assert.equal(observer.reserve('root',before.revision).reserved,false);
 await schedule.delete({sessionId:f.root.agent.id,id:task.id});await nextTurn();
 const reserved=observer.reserve('root',observer.inspect('root').revision);assert.equal(reserved.reserved,true);observer.release(reserved.token);
});

test('host schedule delivery retains residency through inbox admission and durable acknowledgement',{timeout:5000},async t=>{
 const f=await fixture(t),schedule=await schedules(t,f),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:true});
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 const task=await schedule.create(f.root.agent.id,{title:'Due reminder',prompt:'Continue now',after_seconds:1});
 await nextTurn();assert.equal(observer.inspect('root').eligible,false);
 const applied=Promise.withResolvers();f.ctx.on('agent/inbox/claimed',({message})=>{if(message.source.kind==='schedule')applied.resolve();});
 t.mock.timers.tick(1000);await applied.promise;await f.root.agent.whenIdle();
 // Flush the asynchronous schedule acknowledgement through its public notification.
 while((await schedule.catalog()).find(value=>value.id===task.id)?.status==='active')await nextTurn();
 await nextTurn();assert.equal(observer.inspect('root').eligible,true);
 assert.equal(f.requests.length,1);t.mock.timers.reset();
});

test('catalog changes invalidate a reserved cut and stale asynchronous reads cannot erase active tasks',{timeout:5000},async t=>{
 const f=await fixture(t),reads=[];
 f.ctx.provide('schedule',{catalog:()=>{const gate=Promise.withResolvers();reads.push(gate);return gate.promise;}});
 const observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:false});
 f.ctx.emit('schedule/changed');reads[0].resolve([]);await nextTurn();
 assert.equal(observer.inspect('root').eligible,false);assert.equal(reads.length,2);
 reads[1].resolve([]);await nextTurn();
 const reserved=observer.reserve('root',observer.inspect('root').revision);assert.equal(reserved.reserved,true);
 f.ctx.emit('schedule/changed');
 assert.equal(observer.commit('root',reserved.token).committed,false,'An invalidated catalog abandons the suspension fence');
 reads[2].resolve([{id:'future-task',status:'active'}]);await nextTurn();
 assert(observer.inspect('root').blockers.some(value=>value.detail==='future-task'));
});

test('required host schedules stay blocked until activation mounts and observes them',async t=>{
 const f=await fixture(t),observer=new Residency(f.ctx,{deadlineMs:5000,requireSchedule:true});
 assert(observer.inspect('root').blockers.some(value=>value.kind==='unknown'&&value.detail.endsWith('schedule')));
 await schedules(t,f);observer.refreshSchedules();await nextTurn();
 assert.equal(observer.inspect('root').eligible,true);
 });
