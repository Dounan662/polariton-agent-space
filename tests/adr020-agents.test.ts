import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {setImmediate as settle} from 'node:timers/promises';
import {AgentManager} from '../src/agents.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import type {HarnessFactory,Activity} from '../harness/contracts.ts';
import type {ProviderRuntime,ProviderSettings} from '../harness/providers.ts';
import {ControlledHarness} from './fixtures/harness.ts';

const first=JSON.stringify(['custom-api','first']),second=JSON.stringify(['custom-api','second']);
const choice=(value:string)=>({value,name:JSON.parse(value)[1] as string,image:false});
class Providers implements Pick<ProviderSettings,'choices'|'currentDefault'|'currentRevision'|'withRuntime'> {
  currentRevision=0;defaultRoute:string|null=null;routes:string[]=[];
  currentDefault(){return this.defaultRoute;}
  async choices(){return this.routes.map(choice);}
  async withRuntime<T>(effect:(runtime:ProviderRuntime)=>Promise<T>){return effect({revision:this.currentRevision,credentialPath:'/private-fixture/.credentials.yaml',deepseek:false,providers:{},defaultModel:this.defaultRoute,choices:await this.choices()});}
  update(routes:string[],defaultRoute:string|null){this.routes=routes;this.defaultRoute=defaultRoute;this.currentRevision++;}
}
class Resident extends ControlledHarness {
  revision=0;blockers:Activity['blockers']=[];suspendFailure=false;suspensions=0;
  constructor(id:string,permission:ConstructorParameters<typeof ControlledHarness>[1],model:string){super(id,permission,model);this.on('status',()=>this.changed());}
  override options(){return [{id:'model',name:'Model',currentValue:JSON.stringify(['custom-api',this.model]),options:[first,second].map(value=>({value,name:JSON.parse(value)[1] as string}))}];}
  snapshot():Activity{return {revision:this.revision,eligible:this.status==='idle'&&!this.blockers.length,blockers:this.status==='running'?[{kind:'running'}]:this.blockers};}
  changed(){this.revision++;this.emit('residency',{sessionId:this.id,...this.snapshot()});}
  override async activity(){return this.snapshot();}
  override async suspend(sessionId:string,revision:number,canCommit:()=>boolean){
    this.suspensions++;if(this.suspendFailure)throw new Error('Native settlement unavailable');
    if(!this.snapshot().eligible||revision!==this.revision||!canCommit())return {suspended:false,snapshot:this.snapshot()};
    this.emit('suspending');await this.closeSession(sessionId);await this.close();return {suspended:true,snapshot:this.snapshot()};
  }
}
async function until(ready:()=>boolean){while(!ready())await settle();}
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-provider-agents-')));
  const config={...await loadConfig(),stateRoot:root,verification:false,workerIdleUnloadMs:null};
  const tree=new ResearchTree(config);await tree.initialize();
  let sequence=0;const id=()=>`20000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
  const project=(await tree.createProject(id(),'Provider changes')).id,node=await tree.ensureMain(project);
  const providers=new Providers(),harnesses:Resident[]=[],revisions:number[]=[];
  const factory:HarnessFactory=(settings,home,_workspace,_budget,permission)=>{
    assert(settings.providerRuntime);revisions.push(settings.providerRuntime.revision);
    const h=new Resident(`session-${basename(home)}`,permission,JSON.parse(settings.selectedModel!)[1]);harnesses.push(h);return h;
  };
  const agents=new AgentManager(config,tree,async()=>false,factory,{providers});
  t.after(async()=>{for(const h of harnesses){h.suspendFailure=false;h.complete();}await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
  const create=()=>agents.create(project,node,id(),{title:'Analyst'});
  const send=(worker:string,text='Research task')=>agents.submit(project,node,worker,{id:id(),text});
  return {providers,agents,project,node,harnesses,revisions,create,send};
}

test('blank setup and new defaults never rewrite existing worker route choices',{timeout:10000},async t=>{
  const f=await fixture(t),blank=f.create();assert.equal(blank.model,null);
  f.providers.update([first],first);f.agents.providersChanged();
  const configured=f.create();assert.equal(configured.model,first);assert.equal(f.agents.get(blank.id).model,null);
  f.providers.update([first,second],second);f.agents.providersChanged();
  assert.equal(f.create().model,second);assert.equal(f.agents.get(configured.id).model,first);
  await f.agents.configure(f.project,f.node,blank.id,'model',first);
  assert.equal(f.agents.get(blank.id).model,first);assert.equal(f.harnesses.length,0);
});

test('provider changes preserve active work and apply only after native background work settles',{timeout:10000},async t=>{
  const f=await fixture(t);f.providers.update([first],first);const worker=f.create();
  await f.send(worker.id);await until(()=>f.agents.get(worker.id).state==='running');
  const h=f.harnesses[0]!,session=f.agents.get(worker.id).harnessSessionId;
  f.providers.update([first,second],second);f.agents.providersChanged();
  assert.equal(f.agents.providerApplication().state,'pending');assert.equal(f.agents.providerApplication().pendingWorkers,1);
  assert.equal(f.agents.get(worker.id).model,first);assert.equal(h.suspensions,0);
  assert.equal(h.calls.some(call=>call.method==='configure'||call.method==='interrupt'||call.method==='closeSession'),false);
  h.blockers=[{kind:'job'}];h.complete();await until(()=>f.agents.get(worker.id).state==='idle');
  assert.equal(f.agents.providerApplication().state,'pending');assert.equal(h.suspensions,0);
  await assert.rejects(f.agents.configure(f.project,f.node,worker.id,'model',second),{code:'PROVIDER_UPDATE_PENDING'});
  assert.equal(f.agents.get(worker.id).state,'idle');assert.equal(h.exited,false);
  assert.equal(h.calls.some(call=>call.method==='configure'),false);
  const pending=await f.send(worker.id,'Cannot use stale settings');
  await until(()=>f.agents.submission(pending.id).state==='failed');
  assert.match(f.agents.submission(pending.id).detail!,/Provider settings changed/);
  assert.equal(f.harnesses.length,1);
  h.blockers=[];h.changed();await until(()=>f.agents.get(worker.id).state==='inactive');
  assert.equal(h.exited,true);assert.equal(f.agents.providerApplication().state,'effective');
  f.agents.retry(f.project,f.node,worker.id,pending.id);await until(()=>f.harnesses.length===2&&f.agents.get(worker.id).state==='running');
  assert.deepEqual(f.revisions,[1,2]);assert.equal(f.agents.get(worker.id).model,first);
  assert.equal(f.agents.get(worker.id).harnessSessionId,session);
  assert.equal(f.harnesses[1]!.messages.filter(message=>message.requestId===pending.id).length,1);
});

test('a removed route prevents new execution and explicit reselection recovers the retained submission',{timeout:10000},async t=>{
  const f=await fixture(t);f.providers.update([first],first);const worker=f.create();
  f.providers.update([second],second);f.agents.providersChanged();
  const input=await f.send(worker.id);await until(()=>f.agents.submission(input.id).state==='failed');
  assert.equal(f.harnesses.length,0);assert.equal(f.agents.get(worker.id).model,first);
  assert.equal(f.agents.submission(input.id).retryable,true);assert.match(f.agents.submission(input.id).detail!,/configured model/);
  await f.agents.configure(f.project,f.node,worker.id,'model',second);
  f.agents.retry(f.project,f.node,worker.id,input.id);await until(()=>f.agents.get(worker.id).state==='running');
  assert.equal(f.harnesses.length,1);assert.equal(f.agents.get(worker.id).model,second);
});

test('failed native settlement stays observable and pending until explicit close and resume',{timeout:10000},async t=>{
  const f=await fixture(t);f.providers.update([first],first);const worker=f.create();
  const failures:unknown[]=[];f.agents.on('failure',value=>failures.push(value));
  await f.send(worker.id);await until(()=>f.agents.get(worker.id).state==='running');
  const h=f.harnesses[0]!;h.suspendFailure=true;h.complete();await until(()=>f.agents.get(worker.id).state==='idle');
  f.providers.update([first],first);f.agents.providersChanged();await until(()=>failures.length>0);
  assert.equal(f.agents.providerApplication().state,'pending');assert.equal(h.exited,false);assert.equal(h.suspensions,1);
  assert.equal(f.harnesses.length,1);assert.equal(f.agents.get(worker.id).model,first);
  h.suspendFailure=false;await f.agents.closeWorker(f.project,f.node,worker.id);await f.agents.resume(f.project,f.node,worker.id);
  assert.deepEqual(f.revisions,[1,2]);assert.equal(f.agents.providerApplication().state,'effective');
});
