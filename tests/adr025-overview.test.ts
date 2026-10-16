import {CanvasBridge} from '../src/canvas.ts';
import {CanvasSnapshots} from '../src/canvas-snapshots.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,Config} from '../src/config.ts';
import {ResearchTree} from '../src/research.ts';
import {AgentManager} from '../src/agents.ts';
import {MainOperations,Projects} from '../src/cli/main-operations.ts';
import {EnvironmentClient} from '../src/environment/daemon.ts';
import {Request} from '../src/cli/contracts.ts';
import {WorkerOverview,WorkerOverviewInput,overviewText,type OverviewWorker} from '../src/worker-overview-contracts.ts';
import {workerOverview} from '../src/worker-overview.ts';
import {owner} from '../src/caller.ts';
import {Fault} from '../src/contracts.ts';
import {ControlledHarness} from './fixtures/harness.ts';

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'adr025-overview-'))),config={...await loadConfig(),stateRoot:root,cliPageSize:3,workerOverviewPageSize:2,maxPendingMessages:20,verification:false};
 let sequence=0;const id=()=>`25000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
 const tree=new ResearchTree(config);await tree.initialize();const project=await tree.createProject(id(),'Research'),node=await tree.ensureMain(project.id);
 const harnesses:ControlledHarness[]=[];
 const agents=new AgentManager(config,tree,async()=>false,(_settings,_home,_workspace,_budget,permission)=>{const h=new ControlledHarness('session-'+id(),permission);harnesses.push(h);return h;});
 const projects=new Projects(tree,agents);await projects.initialize(project.id);
 const worker=agents.create(project.id,node,id(),{title:'Scientist'}).id;
 const snapshots=await CanvasSnapshots.open(config.stateRoot,config.canvas,error=>{throw error;});t.after(()=>snapshots.close());
 const operations=new MainOperations(config,tree,agents,projects,{} as EnvironmentClient,new CanvasBridge(config.canvas),snapshots);
 const read=async(input:Record<string,unknown>={})=>WorkerOverview.parse(await operations.execute(Request.parse({version:1,command:{kind:'worker.overview',input}}),{kind:'worker',id:worker,processId:id()}));
 t.after(async()=>{for(const h of harnesses)h.complete();await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
 return {root,config,id,tree,project:project.id,node,agents,projects,worker,harnesses,operations,read};
}
function until(agents:AgentManager,ready:()=>boolean){if(ready())return Promise.resolve();return new Promise<void>(resolve=>{const check=()=>{if(ready()){agents.off('change',check);resolve();}};agents.on('change',check);check();});}

test('overview resolves authenticated identity, paginates coworkers, excludes archived and other nodes without activating',async t=>{
 const f=await fixture(t);const visible=[];
 for(let i=0;i<4;i++)visible.push(f.agents.create(f.project,f.node,f.id(),{title:'Colleague '+i}).id);
 const archived=f.agents.create(f.project,f.node,f.id(),{title:'Archived'});f.agents.archive(f.project,f.node,archived.id,true);
 const other=f.id();await f.tree.mutate(f.project,{operationId:f.id(),revision:f.tree.graph(f.project).revision,command:{kind:'node.create',id:other,title:'Other node',description:''}});f.agents.create(f.project,other,f.id(),{title:'Elsewhere'});
 const result=await f.read();assert.equal(result.worker.id,f.worker);assert.equal(result.status,'complete');assert.equal(result.placement.workspace.availability,'available');assert.equal(result.environment.observation,'none');assert.equal(result.coworkers.total,5);assert.equal(result.coworkers.returned,2);assert.equal(result.coworkers.coverage,'page');assert.equal(f.harnesses.length,0);
 const ids=result.coworkers.items.map(w=>w.id);let after=result.coworkers.next;
 while(after){const page=await f.read({section:'coworkers',after});ids.push(...page.coworkers.items.map(w=>w.id));after=page.coworkers.next;}
 assert.equal(new Set(ids).size,5);assert.ok(visible.every(id=>ids.includes(id)));assert.ok(!ids.includes(archived.id));
 await assert.rejects(f.operations.execute(Request.parse({version:1,command:{kind:'worker.overview',input:{}}}),owner),{code:'OVERVIEW_TARGET_REQUIRED'});
 assert.equal(WorkerOverview.parse(await f.operations.execute(Request.parse({version:1,command:{kind:'worker.overview',input:{target:f.worker}}}),owner)).worker.id,f.worker);
 await assert.rejects(f.read({target:visible[0],section:'coworkers',after:result.coworkers.next}),{code:'INVALID_CURSOR'});
 await assert.rejects(f.read({section:'attention',after:result.coworkers.next}),{code:'INVALID_CURSOR'});
 assert.throws(()=>WorkerOverviewInput.parse({limit:2}),/requires/);
});

test('authoritative attention includes older pending delivery, preserves permissions and labels historical failures', {timeout:15000},async t=>{
 const f=await fixture(t),sent:string[]=[];
 for(let n=0;n<8;n++){const id=f.id();sent.push(id);await f.agents.submit(f.project,f.node,f.worker,{id,text:'Large message body '+('x'.repeat(4000))});await until(f.agents,()=>f.agents.submission(id).state==='admitted');}
 assert.equal(f.agents.get(f.worker).submissions.length,3);
 const h=f.harnesses[0]!;const permission=h.permission({sessionId:h.id,toolCall:{toolCallId:'tool',title:'Allow computation',rawInput:'private options detail'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]});const permissionId=f.agents.get(f.worker).permissions[0]!.id;
 const first=await f.read();assert.equal(first.attention.totals.pendingDelivery,8);assert.equal(first.attention.totals.permissions,1);assert.equal(first.attention.items[0]?.kind,'permission');assert.ok(!JSON.stringify(first).includes('Large message body'));assert.ok(!JSON.stringify(first).includes('private options detail'));
 const deliveries:string[]=[];let page=first;
 for(;;){deliveries.push(...page.attention.items.filter(i=>i.kind==='pendingDelivery').map(i=>i.id));if(!page.attention.next)break;page=await f.read({section:'attention',after:page.attention.next});}
 assert.deepEqual(deliveries,sent);assert.ok(first.attention.items.every(i=>i.operation===null));assert.equal(f.agents.get(f.worker).permissions.length,1);
 f.agents.permission(f.project,f.node,f.worker,permissionId,'yes');await permission;
 h.complete('cancelled');const interrupted=await f.read();assert.equal(interrupted.attention.totals.pendingDelivery,0);assert.equal(interrupted.attention.totals.historicalDelivery,8);assert.equal(interrupted.attention.totals.permissions,0);assert.ok(interrupted.attention.items.every(i=>i.kind==='historicalDelivery'));assert.equal(interrupted.status,'complete');
 h.exit();const uncertain=await f.read();assert.equal(uncertain.execution.state,'uncertain');assert.ok(uncertain.execution.error?.text.includes('Harness exited'));assert.ok(uncertain.attention.items.some(i=>i.kind==='currentIssue'));assert.equal(uncertain.status,'complete');
});

test('missing workspace is an observed issue, not a failed read or fabricated research blocker',async t=>{
 const f=await fixture(t);await rm(f.tree.workspace(f.project,f.node),{recursive:true,force:true});const result=await f.read();assert.equal(result.status,'complete');assert.equal(result.placement.workspace.availability,'unavailable');assert.ok(result.attention.items.some(i=>i.code==='WORKSPACE_UNAVAILABLE'));assert.equal(f.harnesses.length,0);
});

test('subsidiary failures preserve placement and owner facts; cold environment observation is unknown',async()=>{
 const config=await loadConfig(),id='25000000-0000-4000-8000-000000000001';let time=10;
 const worker:OverviewWorker={id,projectId:id,nodeId:id,name:overviewText('worker',240),state:'closed',model:null,error:null,residency:'inactive',cleanupPending:false,environment:{selection:{environmentId:'env',revisionId:'rev',name:'Tools'},locked:true},connections:[],connectionsKnown:false,connectionTotal:0,unavailableConnections:0,active:false};
 const owners={agents:{overviewWorker:()=>worker,overviewCoworkers:()=>{throw new Fault('STORE_READ','Coworkers unavailable');},overviewAttention:()=>({totals:{permissions:0,pendingDelivery:0,historicalDelivery:0},items:[]})},projects:{get:()=>{throw new Fault('PROJECT_UNAVAILABLE','Project unavailable');}},tree:{resolveNode:()=>({projectId:id,node:{id,title:'Node',archived:false,description:''},workspace:'/workspace'})}};
 const result=await workerOverview(config,owners,{}, {kind:'worker',id,processId:id},{clock:()=>time++,workspaceAvailable:async()=>true});assert.equal(result.status,'partial');assert.equal(result.placement.project.availability,'unknown');assert.equal(result.placement.node.availability,'available');assert.equal(result.coworkers.total,null);assert.equal(result.coworkers.coverage,'unknown');assert.equal(result.environment.observation,'unknown');assert.equal(result.attention.totals.currentIssues,0);assert.equal(result.observed.startedAt,10);assert.equal(result.observed.finishedAt,11);
 worker.connectionsKnown=true;worker.connectionTotal=10000;worker.unavailableConnections=10000;worker.active=true;worker.connections=Array.from({length:config.workerOverviewPageSize},(_,i)=>({componentId:'component-'+i,serverName:'長'.repeat(1000),status:'unavailable' as const,code:'OFFLINE'}));
 const large=await workerOverview(config,owners,{}, {kind:'worker',id,processId:id},{workspaceAvailable:async()=>true});assert.equal(large.environment.connections.total,10000);assert.equal(large.environment.connections.coverage,'page');assert.equal(large.environment.connections.next,`harnessctl worker get ${id}`);assert.equal(large.attention.totals.currentIssues,1);assert.ok(Buffer.byteLength(JSON.stringify({version:1,data:large}))<config.workerOverviewMaxBytes);
 const controller=new AbortController();controller.abort();await assert.rejects(workerOverview(config,owners,{}, {kind:'worker',id,processId:id},{signal:controller.signal}),{code:'OVERVIEW_CANCELLED'});
 await assert.rejects(workerOverview({...config,requestTimeoutMs:10},owners,{}, {kind:'worker',id,processId:id},{workspaceAvailable:()=>new Promise(()=>{})}),{code:'OVERVIEW_TIMEOUT'});
});

test('overview bounds display text and pages within configured bytes without truncating identifiers',async t=>{
 const f=await fixture(t);for(let i=0;i<8;i++)f.agents.create(f.project,f.node,f.id(),{title:'界'.repeat(1000)});
 const small={...f.config,workerOverviewMaxBytes:3500};const input={section:'coworkers' as const};const result=await workerOverview(small,f,input,{kind:'worker',id:f.worker,processId:f.id()});assert.ok(Buffer.byteLength(JSON.stringify({version:1,data:result}))<=3500);assert.ok(result.coworkers.next);assert.ok(result.coworkers.items.some(w=>w.name.truncated));assert.equal(result.worker.id,f.worker);
 await assert.rejects(workerOverview({...small,workerOverviewMaxBytes:1},f,{},owner),{code:'OVERVIEW_TARGET_REQUIRED'});
 await assert.rejects(workerOverview({...small,workerOverviewMaxBytes:1},f,{target:f.worker},owner),{code:'OUTPUT_LIMIT'});
 assert.throws(()=>Config.parse({...f.config,workerOverviewPageSize:f.config.cliPageSize+1}),/overview limits/);
});
