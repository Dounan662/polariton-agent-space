import {owner} from '../src/caller.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessFactory,McpObservation} from '../harness/contracts.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import type {EnvironmentAccess,AccessRequest,EnvironmentRef} from '../src/environment/contracts.ts';

const route=(model:string)=>JSON.stringify(['deepseek-official',model]);
const environment:EnvironmentRef={environmentId:'lab',revisionId:'r1',name:'Laboratory'};
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function until(agents:AgentManager,ready:()=>boolean){if(ready())return;await new Promise<void>(resolve=>{const check=()=>{if(ready()){agents.off('change',check);resolve();}};agents.on('change',check);check();});}

async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr010-')));
  const config={...await loadConfig(),stateRoot:root,model:'a',verification:false};
  const tree=new ResearchTree(config);await tree.initialize();
  const project=await tree.createProject(randomUUID(),'Assignment contracts'),node=await tree.ensureMain(project.id);
  const stored=new Map<string,{id:string;model:string}>(),harnesses:ControlledHarness[]=[];
  const faults={unavailable:false,discovery:false,allDiscovery:false,acquire:false,release:false,open:false,model:false,close:false,catalogImage:false,catalogWait:null as ReturnType<typeof barrier>|null,wait:null as ReturnType<typeof barrier>|null};
  const calls:AccessRequest[]=[],released:string[]=[],active=new Set<string>();let catalogs=0,sessionCreates=0;
  const access:EnvironmentAccess={
    async choices(){return [{environment,observedAt:'2026-09-24T00:00:00Z'}];},
    async acquire(input){calls.push(input);await faults.wait?.promise;if(faults.acquire)throw new Error('unavailable');active.add(input.id);return {id:input.id,servers:faults.unavailable?[]:[{type:'http',name:'measure',url:'http://127.0.0.1:9001/mcp',headers:[{name:'Authorization',value:'Bearer private-grant'}]},{type:'http',name:'transform',url:'http://127.0.0.1:9002/mcp',headers:[]}],components:['measure','transform'].map(name=>({componentId:name,serverName:name,status:faults.unavailable?'unavailable' as const:'ready' as const,code:faults.unavailable?'CONNECTION_UNAVAILABLE' as const:null}))};},
    async release(input){if(faults.release)throw new Error('secret transport detail');released.push(input.id);active.delete(input.id);},
  };
  const factory:HarnessFactory=(settings,home,_cwd,_budget,permission)=>{
    const key=basename(home),native=`native-${key}`;
    class SessionHarness extends ControlledHarness{
      async close(){if(faults.close)throw new Error("Process close failed");await super.close();}
      override async locate(){this.calls.push({method:'locate',params:{}});return stored.has(key)?native:null;}
      override async activate(sessionId:string|null,servers:Parameters<HarnessPort['activate']>[1]){
        this.calls.push({method:'activate',params:{sessionId,servers}});
        if(sessionId===null){sessionCreates++;stored.set(key,{id:native,model:(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model)});if(faults.open)throw new Error('lost creation reply');}
        const current=stored.get(key)!;this.model=current.model;
        if(faults.model)throw Object.assign(new Error('Selected model is unavailable'),{code:'MODEL_UNAVAILABLE'});
        const mcp:McpObservation[]=servers.map(server=>({serverName:server.name,status:faults.allDiscovery||(faults.discovery&&server.name==='measure')?'unavailable':'connected',code:faults.allDiscovery||(faults.discovery&&server.name==='measure')?'MCP_STARTUP_FAILED':null}));
        return {sessionId:current.id,options:this.options(),mcp};
      }
      override options(){return [{id:'model',name:'Model',currentValue:route(this.model),options:(faults.model?['unavailable']:['a','b']).map(name=>({name,value:route(name)}))}];}
      override async configure(sessionId:string,id:string,value:string){
        this.calls.push({method:'configure',params:{sessionId,id,value}});this.model=JSON.parse(value)[1];stored.get(key)!.model=this.model;return this.options();
      }

    }
    const harness=new SessionHarness(native,permission,(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));harnesses.push(harness);return harness;
  };
  const catalog={async choices(){catalogs++;await faults.catalogWait?.promise;return ['a','b'].map(name=>({name,value:route(name),image:faults.catalogImage}));}};
  let agents=new AgentManager(config,tree,async()=>false,factory,{environment:access,catalog});
  const worker=agents.create(project.id,node,randomUUID(), {title:'Experiment'});
  const view=()=>agents.list(project.id,node).find(value=>value.id===worker.id)!;
  const submit=async(text='Measure and transform')=>{const id=randomUUID();await agents.submit(project.id,node,worker.id,{id,text});return id;};
  t.after(async()=>{faults.wait?.resolve();faults.catalogWait?.resolve();faults.close=false;faults.release=false;for(const harness of harnesses)harness.complete();await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
  return {project:project.id,node,worker:worker.id,tree,view,submit,faults,calls,released,active,harnesses,stored,
    get agents(){return agents;},get catalogs(){return catalogs;},get sessionCreates(){return sessionCreates;},
    async reopen(){await agents.close();agents=new AgentManager(config,tree,async()=>false,factory,{environment:access,catalog});await agents.initialize();},
    select(){return agents.selectEnvironment(project.id,node,worker.id,environment);},
    async finish(){await until(agents,()=>view().state==='running');harnesses.findLast(h=>h.id===`native-${worker.id}`)!.complete();await until(agents,()=>view().submissions.at(-1)?.state==='applied');},
  };
}

test('model choices and selection create no conversation; first prompt confirms selected route and fixes no environment',async t=>{
  const f=await fixture(t);assert.equal(f.view().model,route('a'));
  await assert.rejects(f.agents.resume(f.project,f.node,f.worker),/first message/);assert.equal(f.harnesses.length,0);
  const setup=await f.agents.setup(f.project,f.node,f.worker);assert.equal(setup.models[0].options.length,2);
  await f.agents.configure(f.project,f.node,f.worker,'model',route('b'));assert.equal(f.harnesses.length,0);assert.equal(f.sessionCreates,0);
  await f.submit();await f.finish();assert.equal(f.view().model,route('b'));assert.deepEqual(f.view().environment,{selection:null,locked:true});assert.equal(f.calls.length,0);
  await assert.rejects(f.select(),/new worker/);
});

test('setup retry and resume cannot race a pending model transition; Close drains that transition',async t=>{
  const f=await fixture(t);await f.select();f.faults.acquire=true;const id=await f.submit();await until(f.agents,()=>f.view().submissions[0]?.state==='failed');
  f.faults.acquire=false;f.faults.catalogWait=barrier();
  const configuration=f.agents.configure(f.project,f.node,f.worker,'model',route('b'));
  const rejection=assert.rejects(configuration,/closing/);
  assert.throws(()=>f.agents.retry(f.project,f.node,f.worker,id),/unsettled/);
  await assert.rejects(f.agents.resume(f.project,f.node,f.worker),/configuration is changing/);
  const closing=f.agents.closeWorker(f.project,f.node,f.worker);f.faults.catalogWait.resolve();await closing;await rejection;
  assert.equal(f.view().model,route('a'));assert.equal(f.sessionCreates,0);
});

test('a no-environment edit serializes subsequent setup changes until its receipt settles',async t=>{
  const f=await fixture(t);
  const first=f.agents.selectEnvironment(f.project,f.node,f.worker,null);
  await assert.rejects(f.select(),{code:'SETUP_BUSY'});
  await first;assert.equal(f.view().environment.selection,null);
  await f.select();assert.deepEqual(f.view().environment.selection,environment);
});

test('Interrupt during setup drains late grants and never dispatches the cancelled message',async t=>{
  const f=await fixture(t);await f.select();f.faults.wait=barrier();await f.submit();await until(f.agents,()=>f.calls.length===1);
  const interruption=await f.agents.submit(f.project,f.node,f.worker,{id:randomUUID(),kind:'interrupt',text:''});f.faults.wait.resolve();
  await until(f.agents,()=>f.view().submissions.find(s=>s.id===interruption.id)?.state==='completed');
  assert.equal(f.view().submissions[0].state,'interrupted');assert.equal(f.sessionCreates,0);assert.equal(f.active.size,0);
});

test('failed process close retains observable ownership until a successful close retry',async t=>{
  const f=await fixture(t);await f.select();await f.submit();await f.finish();f.faults.close=true;
  await assert.rejects(f.agents.closeWorker(f.project,f.node,f.worker),/execution cleanup is unconfirmed/);
  assert.equal(f.view().state,'uncertain');assert.equal(f.active.size,1);assert.equal(f.view().cleanupPending,true);
  await assert.rejects(f.agents.resume(f.project,f.node,f.worker),{code:'WORKER_CLOSING'});
  f.faults.close=false;await f.agents.closeWorker(f.project,f.node,f.worker);assert.equal(f.view().state,'closed');
});

test('complete MCP list is scoped to the worker; revision and model survive close, head changes and resume',async t=>{
  const f=await fixture(t);await f.select();await f.submit();await f.finish();
  const opened=f.harnesses[0].calls.find(c=>c.method==='activate'&&(c.params as {sessionId:string|null}).sessionId===null)!.params as {servers:unknown[]};assert.equal(opened.servers.length,2);
  assert.equal(f.calls[0]!.workspace,f.tree.workspace(f.project,f.node),'Environment acquisition receives the same worker workspace as DSH');
  assert(!JSON.stringify(f.view()).includes('private-grant'));
  await f.agents.configure(f.project,f.node,f.worker,'model',route('b'));
  assert.equal(f.view().environment.selection?.revisionId,'r1');
  await f.reopen();assert.equal(f.active.size,0);await f.agents.resume(f.project,f.node,f.worker);
  assert.equal(f.calls.at(-1)?.requireHead,false);assert.equal(f.calls.at(-1)?.environment.revisionId,'r1');assert.equal(f.view().model,route('b'));assert.equal(f.sessionCreates,1);
});

test('failed acquisition never dispatches; explicit same-message retry converges under concurrent requests',async t=>{
  const f=await fixture(t);await f.select();f.faults.acquire=true;const id=await f.submit();await until(f.agents,()=>f.view().submissions[0]?.state==='failed');
  assert.equal(f.sessionCreates,0);assert(f.view().submissions[0].retryable);assert.equal(f.active.size,0);
  f.faults.acquire=false;
  await Promise.all([f.agents.retry(f.project,f.node,f.worker,id),f.agents.retry(f.project,f.node,f.worker,id)]);
  await f.finish();assert.equal(f.sessionCreates,1);assert.equal(f.view().submissions.length,1);
  assert.equal(f.harnesses.flatMap(h=>h.calls).filter(c=>c.method==='message').length,1);
  assert.throws(()=>f.agents.retry(f.project,f.node,f.worker,id),/may have executed/);
});

test('lost session creation response reuses the published session and original revision on retry',async t=>{
  const f=await fixture(t);await f.select();f.faults.open=true;const id=await f.submit();await until(f.agents,()=>f.view().submissions[0]?.state==='failed');
  assert(f.view().harnessSessionId);assert.equal(f.active.size,0);await assert.rejects(f.select(),/Resolve activation/);
  f.faults.open=false;f.agents.retry(f.project,f.node,f.worker,id);await f.finish();assert.equal(f.sessionCreates,1);assert.equal(f.calls.at(-1)?.requireHead,false);
});

test('cleanup failure stays observable and blocks selection; recovery releases only owned access',async t=>{
  const f=await fixture(t);await f.select();await f.submit();await f.finish();f.faults.release=true;
  await assert.rejects(f.agents.closeWorker(f.project,f.node,f.worker),/cleanup is pending/);assert(f.view().cleanupPending);assert(!JSON.stringify(f.view()).includes('secret transport'));
  f.faults.release=false;await f.agents.closeWorker(f.project,f.node,f.worker);assert.equal(f.active.size,0);assert(!f.view().cleanupPending);assert(f.view().environment.locked);
});

test('cancelling activation waits for late acquisition and releases it without creating a session',async t=>{
  const f=await fixture(t);await f.select();f.faults.wait=barrier();await f.submit();await until(f.agents,()=>f.calls.length===1);
  const closing=f.agents.closeWorker(f.project,f.node,f.worker);f.faults.wait.resolve();await closing;
  await until(f.agents,()=>f.view().submissions[0]?.state==='failed');assert.equal(f.active.size,0);assert.equal(f.sessionCreates,0);
});

test('unavailable advertised model prevents first prompt and never substitutes a route',async t=>{
  const f=await fixture(t);await f.select();f.faults.model=true;await f.submit();await until(f.agents,()=>f.view().submissions[0]?.state==='failed');
  assert.equal(f.view().model,route('a'));assert.equal(f.active.size,0);assert.equal(f.harnesses.flatMap(h=>h.calls).filter(c=>c.method==='message').length,0);
});

test('image capability mismatch fails before prompt admission without blocking checkpoint capture',async t=>{
  const f=await fixture(t);f.faults.catalogImage=true;await f.agents.setup(f.project,f.node,f.worker);
  assert.equal(f.view().imageCapability,true);
  const bytes=await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer();
  const image=await f.agents.stageImage(f.project,f.node,f.worker,randomUUID(),'sample.png','image/png',bytes);
  const submissionId=randomUUID();
  await f.agents.submit(f.project,f.node,f.worker,{id:submissionId,text:'Inspect the image',content:[{type:'image',attachmentId:image.id}]});
  await until(f.agents,()=>f.view().submissions.find(value=>value.id===submissionId)?.state==='failed');
  assert.equal(f.view().imageCapability,false);assert.equal(f.view().submissions[0].retryable,true);
  assert.equal(f.harnesses.flatMap(h=>h.calls).filter(call=>call.method==='message').length,0);
  const checkpoint=await f.tree.checkpoint(f.project,f.node,randomUUID(), {publisher:owner});
  assert(checkpoint.id,'A rejected pre-admission image must not prevent workspace publication');
  await f.submit('Continue with text only');await f.finish();
});

test('one worker setup failure cannot block a second worker and active model changes are rejected',async t=>{
  const f=await fixture(t);await f.select();f.faults.wait=barrier();await f.submit();await until(f.agents,()=>f.calls.length===1);
  const second=f.agents.create(f.project,f.node,randomUUID(), {title:'Independent'});
  await f.agents.submit(f.project,f.node,second.id,{id:randomUUID(),text:'Built-in task'});
  await until(f.agents,()=>f.agents.list(f.project,f.node).find(w=>w.id===second.id)?.state==='running');
  await assert.rejects(f.agents.configure(f.project,f.node,second.id,'model',route('b')),/settled worker/);
  f.harnesses.at(-1)!.complete();f.faults.wait.resolve();await f.finish();
});


test('one discovery failure is visible while healthy tools and the submitted prompt remain available',async t=>{
  const f=await fixture(t);await f.select();f.faults.discovery=true;
  await f.submit();await f.finish();
  assert.equal(f.view().environment.locked,true);
  assert.deepEqual(f.view().mcp.map(value=>[value.componentId,value.status]),[['measure','unavailable'],['transform','connected']]);
  assert(!JSON.stringify(f.view()).includes('private-grant'));
  await f.agents.closeWorker(f.project,f.node,f.worker);f.faults.discovery=false;
  await f.agents.resume(f.project,f.node,f.worker);
  assert(f.view().mcp.every(value=>value.status==='connected'));
  assert.equal(f.sessionCreates,1,'Recovery resumes the existing conversation');
});

for(const boundary of ['unavailable','allDiscovery'] as const)test(`all MCP servers unavailable at ${boundary} still admits ordinary worker conversation`,async t=>{
  const f=await fixture(t);await f.select();f.faults[boundary]=true;
  await f.submit('Explain the analysis without using external tools');await f.finish();
  assert.equal(f.view().submissions.at(-1)?.state,'applied');
  assert.equal(f.view().mcp.length,2);assert(f.view().mcp.every(value=>value.status==='unavailable'));
  assert.equal(f.view().state,'idle');assert.equal(f.view().error,null);
  assert.equal(f.harnesses.flatMap(h=>h.calls).filter(call=>call.method==='message').length,1);
});
