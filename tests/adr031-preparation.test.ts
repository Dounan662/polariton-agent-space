import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Preparation,type PreparationOwner} from '../src/environment/preparation.ts';
import {RackConfig,RackFault,type ConnectionDefinition,type ConnectionRevision,type Revision} from '../src/environment/contracts.ts';
import {PreparationInput,PreparationSummary,CapabilitySpec} from '../src/environment/preparation-contracts.ts';
import {RackStore} from '../src/environment/storage.ts';
import {owner,type Actor} from '../src/caller.ts';

const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
const requestId=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor:Actor={kind:'worker',id:ids[2]!,processId:ids[3]!};
const input=PreparationInput.parse({name:'Clock',source:'https://example.com/mcp'});
const definition:ConnectionDefinition={kind:'http',url:'https://example.com/mcp',headers:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}};
async function fixture(t:test.TestContext,overrides:Partial<PreparationOwner>={},settings:Partial<RackConfig>={}){
 const root=await mkdtemp(join(tmpdir(),'polariton-preparation-')),config=RackConfig.parse({stateRoot:root,socketPath:join(root,'owner.sock'),...settings}),store=await RackStore.open(root,config.maxRecords);
 const effects:string[]=[],revisions=new Map<string,Revision>();
 const port:PreparationOwner={
  source:async spec=>{effects.push('resolve');return {definition,source:spec.source,defaults:[]};},
  register:async(id,name,definition)=>{effects.push('register');return {...definition,id,name,revisionId:id,baseRevisionId:null,operationId:id,createdAt:'2026-10-13T00:00:00Z'} as ConnectionRevision;},
  registered:()=>undefined,
  dependencies:async()=>{effects.push('dependencies');},
  git:async()=>{throw new Error('No Git source in fixture');},
  publish:async(id,input,environmentId,components)=>{effects.push('publish');const revision:Revision={format:2,environmentId,name:input.name,description:input.description,components,revisionId:id,baseRevisionId:input.expectRevision??null,createdAt:'2026-10-13T00:00:00Z',operationId:id};revisions.set(environmentId,revision);return revision;},
  apply:async(_id,environmentId)=>{effects.push('prepare');return revisions.get(environmentId)!.components.map(c=>({componentId:c.id,error:null,readiness:'ready-to-connect'}));},
  revision:async id=>revisions.get(id)!,describe:async()=>[],acquire:async()=>{throw new Error('No validation in this fixture');},release:async()=>{},...overrides,
 };
 const preparation=new Preparation(config,store,port);t.after(async()=>{await preparation.close();store.close();await rm(root,{recursive:true,force:true});});return {preparation,effects,port,store};
}
test('unsupported declared requirements block before source or registration effects',async t=>{
 const {preparation,effects}=await fixture(t);
 const base=CapabilitySpec.parse({id:'tool',name:'Declared tool',source:{kind:'git',directory:'/source',commit:'a'.repeat(40)},runtime:{kind:'container'},connection:{kind:'http'},requirements:{},authentication:{kind:'none'}});
 const unsupported:CapabilitySpec[]=[
  {...base,requirements:{...base.requirements,files:['/application']}},
  {...base,connection:{kind:'http',url:'https://different.example/mcp',headers:{}}},
  {...base,connection:{kind:'http',headers:{Accept:'application/json'}}},
  {...base,source:{kind:'installed',command:'/tool'},runtime:{kind:'local'},connection:{kind:'stdio',args:[],env:{}},requirements:{...base.requirements,assets:[{kind:'playwright-browser',browser:'chromium'}]}},
  {...base,source:{kind:'npm',identifier:'fixture',version:'1.0.0'},runtime:{kind:'local'},connection:{kind:'stdio',args:[],env:{}},requirements:{...base.requirements,nativeBuild:true}},
  {...base,source:{kind:'endpoint',url:'https://example.com/mcp'},runtime:{kind:'external'},requirements:{...base.requirements,identityFiles:['/application']}},
 ];
 for(const [index,spec]of unsupported.entries()){
  const result=await preparation.prepare(requestId(100+index),actor,PreparationInput.parse({name:'Unsupported',components:[spec]}));
  assert.equal(result.status,'blocked');assert.equal(result.actions[0]!.code,'REQUIREMENT_UNSUPPORTED');
  await assert.rejects(preparation.continue(requestId(200+index),actor,{target:result.operationId,expectedVersion:result.version,actionId:result.actions[0]!.id,resolution:{kind:'retry'}}),{code:'RESOLUTION_SCOPE'});
 }
 assert.deepEqual(effects,[]);
});
test('preview has no effects; preparation owns publication, evidence and actor-bound replay',async t=>{
 const {preparation,effects}=await fixture(t);
 assert.equal(preparation.preview(input).status,'preview');assert.deepEqual(effects,[]);
 const result=await preparation.prepare(ids[0]!,actor,input);assert.equal(result.status,'ready');assert.equal(result.connection,'untested');assert(result.revisionId);assert.equal(result.components[0]!.evidence.dependencies,'ready');assert.equal(result.components[0]!.evidence.connection,'untested');
 assert.deepEqual((await preparation.prepare(ids[0]!,actor,input)),result);assert.equal(effects.filter(e=>e==='prepare').length,1);
 await assert.rejects(preparation.prepare(ids[0]!,owner,input),{code:'OPERATION_CONFLICT'});
 await assert.rejects(preparation.prepare(ids[0]!,actor,{...input,name:'Changed'}),{code:'OPERATION_CONFLICT'});
 const inspected=await preparation.inspect(result.environmentId!,result.revisionId!);assert.equal(inspected.components[0]!.source.kind,'endpoint');
});
test('a missing tool returns a specific action; continuation preserves original input and identities',async t=>{
 let available=false,candidate:string|undefined;
 const {preparation}=await fixture(t,{source:async(spec,_signal,candidates)=>{candidate=candidates.node;if(!candidate)throw new RackFault('PACKAGE_TOOL_MISSING','Preparation requires node');available=true;return {definition,source:spec.source,defaults:[]};}});
 const first=await preparation.prepare(ids[0]!,actor,input);assert.equal(first.status,'blocked');assert.equal(first.actions[0]!.tool,'node');assert.equal(available,false);
 const continuation={target:`environment:${ids[0]}`,expectedVersion:first.version,actionId:first.actions[0]!.id,resolution:{kind:'toolchain' as const,tool:'node' as const,path:'/opt/toolchain/node'}};
 const second=await preparation.continue(ids[1]!,actor,continuation);assert.equal(second.status,'ready');assert.equal(second.environmentId,first.environmentId);assert.equal(candidate,'/opt/toolchain/node');assert.deepEqual(preparation.operation(ids[0]!)!.input,input);
 assert.deepEqual(await preparation.continue(ids[1]!,actor,continuation),second);
 await assert.rejects(preparation.continue(ids[2]!,actor,continuation),{code:'STALE_OPERATION'});
});
test('another worker cannot resolve an initiator action',async t=>{
 const {preparation}=await fixture(t,{source:async()=>{throw new RackFault('REGISTRY_UNAVAILABLE','Registry unavailable');}});
 const first=await preparation.prepare(ids[0]!,actor,input);
 await assert.rejects(preparation.continue(ids[1]!,{kind:'worker',id:ids[0]!,processId:ids[1]!},{target:`environment:${ids[0]}`,expectedVersion:first.version,actionId:first.actions[0]!.id,resolution:{kind:'retry'}}),{code:'ACTOR_DENIED'});
 assert.equal(preparation.operation(ids[0]!)!.state,'waiting');
});
test('explicit cancellation waits for the source to settle and publishes no environment',async t=>{
 let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);
 const {preparation,effects}=await fixture(t,{source:async(_spec,signal)=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));throw new Error('unreachable');}});
 const running=preparation.prepare(ids[0]!,actor,input);await began;
 const cancelled=await preparation.cancel(ids[1]!,actor,`environment:${ids[0]}`);assert.equal(cancelled.cancelled,true);assert.equal((await running).status,'cancelled');assert(!effects.includes('publish'));
});
test('complete update input cannot be replaced by single-source convenience',()=>{
 assert.throws(()=>PreparationInput.parse({...input,target:'existing',expectRevision:'prior'}));
});
test('plaintext credentials are rejected before a public operation is retained',async t=>{
 const {preparation,effects}=await fixture(t);
 const invalid={name:'Secret',source:'https://example.com/mcp?access_token=never-persist'};
 await assert.rejects(preparation.prepare(ids[0]!,actor,invalid as PreparationInput));assert.equal(preparation.operation(ids[0]!),undefined);assert.deepEqual(effects,[]);
});
test('inspection projects exact-revision discovery without erasing independent functional evidence',async t=>{
 const {preparation,store}=await fixture(t);
 const component=preparation.preview(input).components[0]!;
 const {catalogId,capabilityId,capabilityRevisionId,evidence,error,...spec}=component;
 const prepared=await preparation.prepare(ids[0]!,actor,PreparationInput.parse({name:'Clock',components:[{...spec,checks:[{name:'clock',effects:'read',steps:[{tool:'get_time',arguments:{}}]}]}]}));
 const observation={environmentId:prepared.environmentId,revisionId:prepared.revisionId!,observedAt:'2026-10-13T01:00:00Z',scope:'functional:clock',components:[{componentId:'tool',connected:true,tools:['get_time'],check:{name:'clock',status:'passed' as const},error:null,cleanup:'settled' as const}]};
 store.put('validation','first',observation);
 store.put('validation','later',{...observation,observedAt:'2026-10-13T02:00:00Z',scope:'connection-and-discovery',components:[{...observation.components[0],connected:false,tools:[],check:null,error:'MCP_UNAVAILABLE'}]});
 store.put('validation','other-revision',{...observation,revisionId:'other',observedAt:'2026-10-13T03:00:00Z'});
 const inspected=await preparation.inspect(prepared.environmentId!,prepared.revisionId!);
 assert.equal(inspected.components[0]!.evidence.connection,'failed');assert.deepEqual(inspected.components[0]!.evidence.tools,[]);assert.equal(inspected.components[0]!.evidence.checks[0]!.status,'passed');assert.equal(inspected.observations.length,2);
 assert.equal((await preparation.prepare(ids[0]!,actor,PreparationInput.parse({name:'Clock',components:[{...spec,checks:[{name:'clock',effects:'read',steps:[{tool:'get_time',arguments:{}}]}]}]}))).components[0]!.evidence.connection,'untested');
});
test('failed continuations replay their failure and cancellation settles waiting plans',async t=>{
 const {preparation}=await fixture(t,{source:async()=>{throw new RackFault('REGISTRY_UNAVAILABLE','Registry unavailable');}});
 const first=await preparation.prepare(ids[0]!,actor,input);
 const wrong={target:`environment:${ids[0]}`,expectedVersion:first.version+1,actionId:first.actions[0]!.id,resolution:{kind:'retry' as const}};
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(preparation.continue(ids[1]!,actor,wrong),{code:'STALE_OPERATION'});
 assert.equal((await preparation.cancel(ids[2]!,actor,`environment:${ids[0]}`)).cancelled,true);assert.equal(preparation.operation(ids[0]!)!.state,'failed');
 assert.equal((await preparation.cancel(ids[2]!,actor,`environment:${ids[0]}`)).cancelled,true);
});
test('validation planning errors settle their receipt without acquiring access',async t=>{
 const {preparation,effects}=await fixture(t);
 const prepared=await preparation.prepare(ids[0]!,actor,input);
 await assert.rejects(preparation.validate(ids[1]!,actor,{target:prepared.environmentId!,revision:prepared.revisionId!,check:'unknown'}),{code:'CHECK_UNKNOWN'});
 assert.equal(preparation.operation(ids[1]!)!.state,'failed');assert.equal(preparation.operation(ids[1]!)!.error!.code,'CHECK_UNKNOWN');
});
test('a rotated account binding requests a reviewed replacement instead of a continuation loop',async t=>{
 const {preparation}=await fixture(t,{source:async()=>{throw new RackFault('ACCOUNT_BINDING_REVOKED','Account login changed');}});
 const result=await preparation.prepare(ids[0]!,actor,input);assert.equal(result.actions[0]!.kind,'review');assert.equal(result.actions[0]!.actor,'owner');
 await assert.rejects(preparation.continue(ids[1]!,owner,{target:`environment:${ids[0]}`,expectedVersion:result.version,actionId:result.actions[0]!.id,resolution:{kind:'authentication-complete'}}),{code:'RESOLUTION_SCOPE'});
});
test('an incompatible configured account requires a reviewed plan instead of an ineffective login retry',async t=>{
 const {preparation}=await fixture(t,{source:async()=>{throw new RackFault('ACCOUNT_BINDING','Account resource or configured scopes do not match');}});
 const result=await preparation.prepare(ids[0]!,actor,input);assert.equal(result.actions[0]!.kind,'review');assert.equal(result.actions[0]!.actor,'owner');
 await assert.rejects(preparation.continue(ids[1]!,owner,{target:result.operationId,expectedVersion:result.version,actionId:result.actions[0]!.id,resolution:{kind:'authentication-complete'}}),{code:'RESOLUTION_SCOPE'});
});
test('owner attention retains blocked unpublished work across owner recreation without resuming it',async t=>{
 const {preparation,store,port,effects}=await fixture(t,{source:async()=>{throw new RackFault('ACCOUNT_NOT_FOUND','Account connection not found');}});
 const original=PreparationInput.parse({...input,name:'Google Workspace',description:'Owner consent required',source:undefined,target:'workspace',expectRevision:'previous',components:preparation.preview(input).components.map(({catalogId,capabilityId,capabilityRevisionId,evidence,error,...spec})=>spec)});
 const result=await preparation.prepare(ids[0]!,actor,original);
 assert.equal(result.revisionId,null);
 assert.equal(result.components[0]!.evidence.dependencies,'unprepared');assert.equal(result.components[0]!.evidence.authentication,'action-needed');
 const before=[...effects],restored=new Preparation(RackConfig.parse({stateRoot:'/unused',socketPath:'/unused.sock'}),store,port);
 assert.deepEqual(restored.attention(),[PreparationSummary.parse({name:original.name,description:original.description,target:'workspace',expectRevision:'previous',result})]);
 assert.deepEqual(effects,before);
 const listed=restored.attention();listed[0]!.result.components.length=0;
 assert.equal(restored.attention()[0]!.result.components.length,1);
 await restored.cancel(ids[1]!,owner,result.operationId);
 assert.deepEqual(restored.attention(),[]);
});
test('an account failure during Apply does not invent a dependency failure',async t=>{
 const {preparation}=await fixture(t,{apply:async()=>[{componentId:'tool',error:'Account needs login',errorCode:'ACCOUNT_LOGIN_REQUIRED',readiness:'unavailable'}]});
 const result=await preparation.prepare(ids[0]!,actor,input);
 assert.equal(result.status,'partial');assert.equal(result.components[0]!.evidence.dependencies,'unprepared');assert.equal(result.components[0]!.evidence.authentication,'action-needed');assert.equal(result.components[0]!.error?.code,'ACCOUNT_LOGIN_REQUIRED');
});
test('OAuth preparation rejects a shared connection identity across distinct resources before any effects',async t=>{
 const {preparation,effects}=await fixture(t);
 const components=['gmail','drive'].map(id=>({id,name:id,source:{kind:'endpoint',url:`https://${id}.example/mcp`},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'workspace',scopes:['read']}}));
 const specification=PreparationInput.parse({name:'Workspace',components});
 const preview=preparation.preview(specification);
 assert.equal(preview.actions.length,2);assert(preview.actions.every(action=>action.code==='ACCOUNT_RESOURCE_CONFLICT'&&action.kind==='review'));
 assert.equal((await preparation.prepare(ids[0]!,actor,specification)).status,'blocked');assert.deepEqual(effects,[]);
 const corrected=PreparationInput.parse({name:'Workspace',components:components.map(component=>({...component,authentication:{...component.authentication,connectionId:`workspace-${component.id}`}}))});
 assert.deepEqual(preparation.preview(corrected).actions,[]);
});
test('private references reveal static authentication while worker path references remain unauthenticated',async t=>{
 const {preparation}=await fixture(t);
 const component={id:'tool',name:'Tool',source:{kind:'npm',identifier:'example',version:'1.0.0'},runtime:{kind:'local'},connection:{kind:'stdio',env:{WORKSPACE:'${POLARITON_WORKSPACE}',PRIVATE_KEY:'${service-key}'}},requirements:{},authentication:{kind:'none'}};
 const preview=preparation.preview(PreparationInput.parse({name:'Tool',components:[component]}));
 assert.equal(preview.components[0]!.authentication.kind,'static');assert.match(preview.defaults[0]!,/private references/);
 component.connection.env.PRIVATE_KEY='${POLARITON_DATA}';
 assert.equal(preparation.preview(PreparationInput.parse({name:'Tool',components:[component]})).components[0]!.authentication.kind,'none');
});

test('selected capability authentication amendments survive restart and completion never publishes siblings',async t=>{
 let connected=false;const resolved:string[]=[],registeredActors:Actor[]=[];
 const f=await fixture(t,{source:async spec=>{resolved.push(spec.id);if(!connected)throw new RackFault('ACCOUNT_DISCONNECTED','Connect the selected account');return {definition,source:spec.source,defaults:[]};},register:async(id,name,value,by)=>{registeredActors.push(by);return {...value,id,name,revisionId:id,baseRevisionId:null,operationId:id,createdAt:'2026-10-13T00:00:00Z'} as ConnectionRevision;}});
 const original=PreparationInput.parse({name:'Workspace',components:['mail','drive'].map(id=>({id,name:id,source:{kind:'endpoint',url:`https://${id}.example/mcp`},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'shared',scopes:['read']}}))});
 const first=await f.preparation.prepare(requestId(10),actor,original);assert.equal(first.actions.length,2);assert.deepEqual(resolved,[]);
 const amendment={target:first.operationId,expectedVersion:first.version,componentId:'mail',authentication:{kind:'oauth' as const,connectionId:'mail-account',scopes:['read']}};
 await assert.rejects(f.preparation.complete(requestId(11),actor,amendment),{code:'ACTOR_DENIED'});assert.equal(f.preparation.attention()[0]!.result.version,first.version);
 const saved=await f.preparation.complete(requestId(12),owner,amendment);assert.equal(saved.components[0]!.authentication.kind,'oauth');assert(!saved.actions.some(action=>action.code==='ACCOUNT_RESOURCE_CONFLICT'));assert.equal(saved.components[0]!.error?.code,'ACCOUNT_DISCONNECTED');assert.deepEqual(resolved,['mail']);
 assert.deepEqual(f.preparation.operation(requestId(10))!.input,original);assert.deepEqual(f.preparation.operation(requestId(12))!.actor,owner);assert.deepEqual(f.preparation.operation(requestId(12))!.input,amendment);
 const restored=new Preparation(RackConfig.parse({stateRoot:'/unused',socketPath:'/unused.sock'}),f.store,f.port);assert.deepEqual(restored.attention()[0]!.result,saved);
 await assert.rejects(restored.complete(requestId(13),owner,amendment),{code:'STALE_OPERATION'});
 connected=true;const completion={target:first.operationId,expectedVersion:saved.version,componentId:'mail'};
 const completed=await restored.complete(requestId(14),owner,completion);assert(completed.components[0]!.capabilityId);assert.equal(completed.components[1]!.capabilityId,null);assert.equal(completed.revisionId,null);assert.equal(completed.status,'blocked');assert.deepEqual(resolved,['mail','mail']);assert.deepEqual(f.effects,[]);assert.deepEqual(registeredActors,[actor]);
 assert.deepEqual(await restored.complete(requestId(14),owner,completion),completed);assert.deepEqual(registeredActors,[actor]);
 await assert.rejects(restored.complete(requestId(15),owner,{...amendment,expectedVersion:completed.version}),{code:'CAPABILITY_REGISTERED'});
 const action=completed.actions.find(action=>action.code==='CAPABILITY_COMPLETED')!;
 const published=await restored.continue(requestId(16),owner,{target:first.operationId,expectedVersion:completed.version,actionId:action.id,resolution:{kind:'retry'}});assert.equal(published.status,'ready');assert.deepEqual(resolved,['mail','mail','drive']);assert.deepEqual(f.effects,['publish','prepare']);assert.deepEqual(restored.operation(requestId(10))!.input,original);
});

test('completion reconciles a registered child after interruption before allowing authentication amendment',async t=>{
 let registered:ConnectionRevision|undefined;
 const f=await fixture(t,{source:async()=>{throw new RackFault('ACCOUNT_DISCONNECTED','Login required');},registered:()=>registered});
 const first=await f.preparation.prepare(requestId(20),actor,input);
 registered={...definition,id:'retained',name:'Retained',revisionId:'retained-v1',baseRevisionId:null,operationId:'child',createdAt:'2026-10-13T00:00:00Z'} as ConnectionRevision;
 await assert.rejects(f.preparation.complete(requestId(21),owner,{target:first.operationId,expectedVersion:first.version,componentId:'tool',authentication:{kind:'oauth',connectionId:'changed',scopes:['read']}}),{code:'CAPABILITY_REGISTERED'});
 const restored=f.preparation.attention()[0]!.result;assert.equal(restored.components[0]!.capabilityId,'retained');assert.deepEqual(restored.components[0]!.authentication,{kind:'none'});assert(restored.version>first.version);assert.deepEqual(f.effects,[]);
});

test('draft authentication remains consistent with fixed private credential references',async t=>{
 const f=await fixture(t,{source:async()=>{throw new RackFault('CREDENTIAL_MISSING','Private credential required');}});
 const specification=PreparationInput.parse({name:'Private endpoint',components:[{id:'private',name:'Private',source:{kind:'endpoint',url:'https://example.com/mcp'},runtime:{kind:'external'},connection:{kind:'http',headers:{Authorization:'Bearer ${service}'}},requirements:{},authentication:{kind:'static'}}]});
 const first=await f.preparation.prepare(requestId(30),actor,specification),result=await f.preparation.complete(requestId(31),owner,{target:first.operationId,expectedVersion:first.version,componentId:'private',authentication:{kind:'none'}});
 assert.equal(result.components[0]!.authentication.kind,'static');assert.equal(result.components[0]!.evidence.authentication,'action-needed');assert.equal(result.components[0]!.evidence.dependencies,'unprepared');assert.equal(result.components[0]!.error?.code,'CREDENTIAL_MISSING');assert.equal(result.revisionId,null);
 const empty=f.preparation.preview(PreparationInput.parse({...specification,components:[{...specification.components![0]!,connection:{kind:'http',headers:{}}}]}));assert.equal(empty.actions[0]!.code,'AUTHENTICATION_CONFLICT');
});

test('cancelling selected completion settles its source without resolving siblings or publication',async t=>{
 let wait=false,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),resolved:string[]=[];
 const f=await fixture(t,{source:async(spec,signal)=>{resolved.push(spec.id);if(!wait)throw new RackFault('REGISTRY_UNAVAILABLE','Retry later');entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));throw new Error('Unreachable');}});
 const first=await f.preparation.prepare(requestId(40),actor,input);wait=true;
 const completion=f.preparation.complete(requestId(41),actor,{target:first.operationId,expectedVersion:first.version,componentId:'tool'});await started;
 const cancelled=await f.preparation.cancel(requestId(42),owner,first.operationId);assert.equal(cancelled.cancelled,true);assert.equal((await completion).status,'cancelled');assert.deepEqual(resolved,['tool','tool']);assert.deepEqual(f.effects,[]);
});

test('standalone addition durably retains intent without resolving sources or reserving an environment',async t=>{
 const f=await fixture(t),input={name:'Independent tool',description:'Reusable source',source:'npm:example@1.0.0'};
 const added=await f.preparation.add(requestId(40),actor,{...input,description:input.description});
 assert.equal(added.status,'draft');assert.equal(added.environmentId,null);assert.equal(added.revisionId,null);assert.equal(added.components[0]!.evidence.dependencies,'unprepared');assert.deepEqual(f.effects,[]);
 const restored=new Preparation(RackConfig.parse({stateRoot:'/unused',socketPath:'/unused.sock'}),f.store,f.port);await restored.recover();
 assert.deepEqual(restored.attention()[0]!.result,added);assert.deepEqual(await restored.add(requestId(40),actor,input),added);assert.deepEqual(f.effects,[]);
 await assert.rejects(restored.add(requestId(40),owner,input),{code:'OPERATION_CONFLICT'});
 const complete={target:added.operationId,expectedVersion:added.version,componentId:added.components[0]!.id};
 const ready=await restored.complete(requestId(41),actor,complete);
 assert.equal(ready.status,'ready');assert.equal(ready.environmentId,null);assert.equal(ready.revisionId,null);assert.equal(ready.components[0]!.evidence.dependencies,'ready');assert.equal(ready.components[0]!.evidence.connection,'untested');assert.deepEqual(ready.actions,[]);assert.deepEqual(f.effects,['resolve','register','dependencies']);
 assert.deepEqual(await restored.complete(requestId(41),actor,complete),ready);assert.deepEqual(restored.attention()[0]!.result,ready);
 assert.equal(restored.operation(requestId(40))!.state,'succeeded');
});

test('standalone authentication waits in its own draft and remains owner-scoped after restart',async t=>{
 let available=false;
 const f=await fixture(t,{source:async spec=>{if(!available)throw new RackFault('ACCOUNT_NOT_FOUND','Account connection not found');return {definition,source:spec.source,defaults:[]};}});
 const specification=f.preparation.preview(input).components[0]!;
 const {catalogId,capabilityId,capabilityRevisionId,evidence,error,...spec}=specification;
 const added=await f.preparation.add(requestId(50),actor,{name:'Mail',description:'',specification:{...spec,authentication:{kind:'oauth',connectionId:'mail',scopes:['read']}}});
 await assert.rejects(f.preparation.complete(requestId(51),actor,{target:added.operationId,expectedVersion:added.version,componentId:'tool'}),{code:'ACTOR_DENIED'});
 const blocked=await f.preparation.complete(requestId(52),owner,{target:added.operationId,expectedVersion:added.version,componentId:'tool'});
 assert.equal(blocked.status,'blocked');assert.equal(blocked.components[0]!.error?.code,'ACCOUNT_NOT_FOUND');assert.equal(blocked.components[0]!.capabilityId,null);assert.deepEqual(f.effects,[]);
 const restored=new Preparation(RackConfig.parse({stateRoot:'/unused',socketPath:'/unused.sock'}),f.store,f.port);await restored.recover();available=true;
 const ready=await restored.continue(requestId(53),owner,{target:added.operationId,expectedVersion:blocked.version,actionId:blocked.actions[0]!.id,resolution:{kind:'authentication-complete'}});
 assert.equal(ready.status,'ready');assert.equal(ready.environmentId,null);assert.deepEqual(f.effects,['register','dependencies']);assert.equal(ready.components[0]!.evidence.authentication,'connected');
});

test('registered standalone dependency failures retry without changing source or creating an environment',async t=>{
 let available=false;const f=await fixture(t,{dependencies:async()=>{if(!available)throw new RackFault('PACKAGE_TOOL_MISSING','Preparation requires node');}});
 const added=await f.preparation.add(requestId(60),actor,{name:'Package',description:'',source:'npm:example@1.0.0'});
 const first=await f.preparation.complete(requestId(61),actor,{target:added.operationId,expectedVersion:added.version,componentId:'tool'});
 assert.equal(first.status,'blocked');assert(first.components[0]!.capabilityId);assert.equal(first.components[0]!.evidence.dependencies,'unavailable');
 await assert.rejects(f.preparation.complete(requestId(62),owner,{target:added.operationId,expectedVersion:first.version,componentId:'tool',authentication:{kind:'none'}}),{code:'CAPABILITY_REGISTERED'});
 available=true;const ready=await f.preparation.complete(requestId(63),actor,{target:added.operationId,expectedVersion:first.version,componentId:'tool'});
 assert.equal(ready.status,'ready');assert.equal(ready.components[0]!.capabilityId,first.components[0]!.capabilityId);assert.equal(f.effects.filter(value=>value==='resolve').length,1);assert(!f.effects.includes('publish'));assert(!f.effects.includes('prepare'));
});

test('standalone cancellation settles dependency work, leaves unrelated drafts usable and permits explicit retry',async t=>{
 let entered!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);let block=true;
 const f=await fixture(t,{dependencies:async(component,signal)=>{if(component.name!=='Slow'||!block)return;entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 const added=await f.preparation.add(requestId(70),actor,{name:'Slow',description:'',source:'npm:example@1.0.0'});
 const running=f.preparation.complete(requestId(71),actor,{target:added.operationId,expectedVersion:added.version,componentId:'tool'});await began;
 const other=await f.preparation.add(requestId(72),actor,{name:'Other',description:'',source:'https://example.com/mcp'});
 assert.equal((await f.preparation.complete(requestId(73),actor,{target:other.operationId,expectedVersion:other.version,componentId:'tool'})).status,'ready');
 assert.equal((await f.preparation.cancel(requestId(74),actor,added.operationId)).cancelled,true);const cancelled=await running;assert.equal(cancelled.status,'cancelled');assert.equal(f.preparation.attention().length,2);
 block=false;const ready=await f.preparation.complete(requestId(75),actor,{target:added.operationId,expectedVersion:cancelled.version,componentId:'tool'});assert.equal(ready.status,'ready');assert.equal(ready.environmentId,null);assert(!f.effects.includes('publish'));
});

test('standalone preparation deadline is observable and a new explicit attempt can recover',async t=>{
 let wait=true;const f=await fixture(t,{dependencies:async(_component,signal)=>{if(wait)await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}},{operationTimeoutMs:20});
 const added=await f.preparation.add(requestId(80),actor,{name:'Deadline tool',description:'',source:'npm:example@1.0.0'});
 const timeout=await f.preparation.complete(requestId(81),actor,{target:added.operationId,expectedVersion:added.version,componentId:'tool'});
 assert.equal(timeout.status,'cancelled');assert.equal(timeout.components[0]!.error?.code,'PREPARATION_TIMEOUT');assert.equal(timeout.components[0]!.evidence.dependencies,'unavailable');
 wait=false;const ready=await f.preparation.complete(requestId(82),actor,{target:added.operationId,expectedVersion:timeout.version,componentId:'tool'});assert.equal(ready.status,'ready');assert.equal(ready.environmentId,null);assert(!f.effects.includes('publish'));
});
