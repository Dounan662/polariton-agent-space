import assert from 'node:assert/strict';
import test from 'node:test';
import {CapabilitySpec,PreparationResult} from '../src/environment/preparation-contracts.ts';
import {ConnectionRevision,type Inventory} from '../src/environment/contracts.ts';
import {accountMismatch,accountSetup,capabilityAccount,pendingCapabilities,selectableCatalog,completedSelection,savedCapabilitySelection,restoreCapabilitySelection,preparationDraft,conflictingAccounts} from '../web/src/environment-preparation.ts';
import {ApiError,operationOutcomeUnknown} from '../web/src/api.ts';
import {AccountPublic} from '../src/environment/account-contracts.ts';

const endpoint=ConnectionRevision.parse({id:'gmail',name:'Gmail',revisionId:'gmail-v1',baseRevisionId:null,operationId:'registration',createdAt:'2026-10-13T12:00:00Z',kind:'http',url:'https://gmailmcp.googleapis.com/mcp/v1',headers:{},requirements:{files:[],identityFiles:[]},credentials:{}});
if(endpoint.kind!=='http')throw new Error('Fixture must be HTTP');
const spec=CapabilitySpec.parse({id:'gmail',name:'Gmail',source:{kind:'endpoint',url:endpoint.url},runtime:{kind:'external'},connection:{kind:'http',url:endpoint.url,headers:{}},requirements:{},authentication:{kind:'none'}});
function preparation(){return PreparationResult.parse({status:'blocked',version:2,environmentId:'mail-env',revisionId:null,components:[{...spec,capabilityId:null,capabilityRevisionId:null,error:{code:'ACCOUNT_MISSING',message:'Connect the account'},evidence:{registered:false,dependencies:'unavailable',connection:'untested',tools:[],authentication:'action-needed',checks:[],observedAt:null}}],actions:[],defaults:[],connection:'untested',operationId:'environment:original'});}
function inventory(values:Partial<Inventory>={}):Inventory{return {capabilities:[],releases:[],environments:[],preparations:[],mounts:[],realizations:[],activeRealizations:{},operations:[],observations:[],bindings:[],...values};}

test('catalog account setup derives only the exact selected definition without creating an environment',()=>{
 const bare=capabilityAccount(endpoint);assert.equal(bare.connection.kind,'http');assert.deepEqual(bare.authentication,{kind:'none'});assert(!('target'in bare));
 const bound=ConnectionRevision.parse({...endpoint,account:{connectionId:'mail-account',epoch:'old-binding',resource:endpoint.url,scopes:['read']}});
 const account=capabilityAccount(bound);assert.deepEqual(account.authentication,{kind:'oauth',connectionId:'mail-account',scopes:['read']});assert.equal(account.bindingEpoch,'old-binding');assert.deepEqual(endpoint.credentials,{});
});

test('editing a blocked preparation preserves update scope and strips retained observation identities',()=>{
 const result=preparation(),input=preparationDraft({name:'Mail',description:'Update mail',target:'mail-env',expectRevision:'mail-base',result});
 assert.equal(input.target,'mail-env');assert.equal(input.expectRevision,'mail-base');assert.equal(input.components?.[0]?.source.kind,'endpoint');assert(!('evidence' in input.components![0]!));assert(!('operationId' in input));assert.equal(result.status,'blocked');
});

test('pending navigation retains each durable draft and never merges by name or endpoint',()=>{
 const first=preparation(),second=PreparationResult.parse({...first,operationId:'environment:second'}),state=inventory({capabilities:[endpoint],preparations:[{name:'Mail',description:'',result:first},{name:'Mail',description:'',result:second}]});
 assert.deepEqual(pendingCapabilities(state).map(value=>[value.plan.result.operationId,value.component.id]),[['environment:original','gmail'],['environment:second','gmail']]);
 first.components[0]!.capabilityId=endpoint.id;first.components[0]!.capabilityRevisionId=endpoint.revisionId;
 assert.deepEqual(pendingCapabilities(state).map(value=>value.plan.result.operationId),['environment:second']);
});

test('pending selection follows only its own registered identity and preserves the returned exact version',()=>{
 const result=preparation(),selected={kind:'pending' as const,operationId:result.operationId,componentId:'gmail'};
 assert.deepEqual(completedSelection(selected,result,inventory()),selected);
 result.components[0]!.capabilityId='registered-mail';result.components[0]!.capabilityRevisionId='registered-v2';
 assert.deepEqual(completedSelection(selected,result,inventory()),{kind:'capability',id:'registered-mail',revisionId:'registered-v2'});
 assert.deepEqual(completedSelection({...selected,componentId:'drive'},result,inventory()),{...selected,componentId:'drive'});
 assert.deepEqual(completedSelection({...selected,operationId:'environment:other'},result,inventory()),{...selected,operationId:'environment:other'});
});

test('managed release identity merges into its catalog package without duplicating a pending row',()=>{
 const result=preparation();result.components[0]!.capabilityId='release-one';result.components[0]!.capabilityRevisionId=null;
 const state=inventory({capabilities:[{kind:'managed',id:'git-package',name:'Managed',source:{repository:'/fixture',subdirectory:''},createdAt:'2026-10-13'}],releases:[{id:'release-one',packageId:'git-package'} as Inventory['releases'][number]],preparations:[{name:'Managed',description:'',result}]});
 assert.deepEqual(pendingCapabilities(state),[]);assert.deepEqual(completedSelection({kind:'pending',operationId:result.operationId,componentId:'gmail'},result,state),{kind:'capability',id:'git-package'});
});

test('saved navigation restores typed exact selection and rejects malformed local state',()=>{
 for(const selection of [{kind:'capability',id:'mail',revisionId:'mail-v1'},{kind:'pending',operationId:'environment:one',componentId:'mail'}])assert.deepEqual(savedCapabilitySelection(JSON.stringify(selection)),selection);
 for(const invalid of [null,'invalid','null','{}','{"kind":"capability","id":42}','{"kind":"capability","id":"../wrong"}','{"kind":"pending","operationId":"one"}','{"kind":"capability","id":"mail","secret":"wrong"}'])assert.equal(savedCapabilitySelection(invalid),null);
});

test('shared OAuth identities across protected resources require review before offering account setup',()=>{
 const gmail={...spec,authentication:{kind:'oauth' as const,connectionId:'google',scopes:['gmail']}};
 const drive={...gmail,id:'drive',source:{kind:'endpoint' as const,url:'https://drivemcp.googleapis.com/mcp/v1'},connection:{kind:'http' as const,url:'https://drivemcp.googleapis.com/mcp/v1',headers:{}},authentication:{...gmail.authentication,scopes:['drive']}};
 assert.deepEqual([...conflictingAccounts([gmail,drive])],['google']);assert.equal(conflictingAccounts([gmail,{...drive,authentication:{...drive.authentication,connectionId:'google-drive'}}]).size,0);
 assert.equal(conflictingAccounts([gmail,{...gmail,id:'same-resource'}]).size,0);
});

test('account setup uses the selected protected resource and verified Google endpoints only',()=>{
 const google=accountSetup({...spec,connection:{kind:'http',headers:{}}});
 assert.equal(google.resource,endpoint.url);assert.equal(google.issuer,'https://accounts.google.com');assert.equal(google.registration,'preregistered');
 for(const service of ['gmailmcp','drivemcp','calendarmcp','people','docsmcp','sheetsmcp','slidesmcp','chatmcp'])assert.equal(accountSetup({...spec,source:{kind:'endpoint',url:`https://${service}.googleapis.com/mcp/v1`},connection:{kind:'http',headers:{}}}).google,true);
 for(const url of ['https://gmail.googleapis.com/mcp','https://gmailmcp.googleapis.com/mcp/v1/other','https://gmailmcp.googleapis.com.evil.test/mcp/v1']){
  const other=accountSetup({...spec,connection:{kind:'http',url,headers:{}}});assert.equal(other.resource,url);assert.equal(other.google,false);assert.equal(other.issuer,'');assert.equal(other.registration,'dynamic');
 }
});

test('static credential setup excludes only reserved worker path placeholders',()=>{
 const setup=accountSetup({...spec,connection:{kind:'stdio',args:[],env:{TOKEN:'${POLARITON_TOKEN}',WORKSPACE:'${POLARITON_WORKSPACE}',RUNTIME:'${POLARITON_RUNTIME}',DATA:'${POLARITON_DATA}',AUTH:'Bearer ${API_KEY}',SECOND:'${POLARITON_TOKEN}',LITERAL:'not-a-reference'}}});
 assert.deepEqual(setup.references,['POLARITON_TOKEN','API_KEY']);assert.equal(setup.resource,'');assert.equal(setup.google,false);
});

test('new and partially consented OAuth connections remain connectable for the selected resource',()=>{
 const component={...spec,authentication:{kind:'oauth' as const,connectionId:'google-gmail',scopes:['gmail.readonly']}},account=AccountPublic.parse({id:'google-gmail',name:'Gmail',kind:'oauth',status:'disconnected',epoch:'one',resource:endpoint.url,scopes:[],account:null,errorCode:null});
 assert.equal(accountMismatch(component,account),false);assert.equal(accountMismatch(component,{...account,status:'connected',scopes:['other-scope']}),false);
 assert.equal(accountMismatch(component,{...account,resource:'https://drivemcp.googleapis.com/mcp/v1'}),true);assert.equal(accountMismatch(component,{...account,kind:'static'}),true);
 assert.equal(accountMismatch({...spec,authentication:{kind:'static'}},account),true);
});


test('confirmed authentication rejection is retryable after correction while unknown outcomes retain recovery',()=>{
 assert.equal(operationOutcomeUnknown(new ApiError('ACCOUNT_NOT_FOUND','Configure the account',404)),false);
 assert.equal(operationOutcomeUnknown(new ApiError('ACCOUNT_BINDING','Select the appropriate account',409)),false);
 assert.equal(operationOutcomeUnknown(new ApiError('ENVIRONMENT_UNAVAILABLE','Owner unavailable',503)),true);
 assert.equal(operationOutcomeUnknown(new ApiError('REQUEST_TIMEOUT','Outcome unknown',408)),true);
 assert.equal(operationOutcomeUnknown(new TypeError('Network response lost')),true);
});


const retainedId='10000000-0000-4000-8000-000000000001';
function retainedReceipt(result:ReturnType<typeof preparation>,input:unknown={name:'Mail',source:spec.source},command='environment.prepare'){
 return {reference:`environment:${retainedId}`,requestId:retainedId,actor:{kind:'owner',id:'local-owner'},command,input,state:'succeeded',result:{...result,operationId:`environment:${retainedId}`},error:null,attempts:[]};
}
const missingRead=async()=>{throw new ApiError('NOT_FOUND','Operation does not exist',404);};

test('saved pending capability is forgotten only after its owner confirms that it is missing',async()=>{
 const selection={kind:'pending' as const,operationId:`environment:${retainedId}`,componentId:'gmail'};
 const missing=await restoreCapabilitySelection(selection,inventory(),missingRead);
 assert.equal(missing.kind,'missing');assert.match(missing.message,/Choose a capability/);
 for(const failure of [new ApiError('ENVIRONMENT_UNAVAILABLE','Owner unavailable',503),new ApiError('REQUEST_TIMEOUT','Read timed out',408),new ApiError('ACCOUNT_NOT_FOUND','Account missing',404),new TypeError('Network response lost')]){
  const result=await restoreCapabilitySelection(selection,inventory(),async()=>{throw failure;});
  assert.equal(result.kind,'failed');assert.equal(result.message,failure.message);
 }
});

test('saved navigation recovers ready preparations omitted from the attention inventory',async()=>{
 const receipt=retainedReceipt(preparation()),selection={kind:'pending' as const,operationId:receipt.reference,componentId:'gmail'};
 receipt.result.status='ready';receipt.result.components[0]!.capabilityId=endpoint.id;receipt.result.components[0]!.capabilityRevisionId=endpoint.revisionId;
 const recovered=await restoreCapabilitySelection(selection,inventory({capabilities:[endpoint]}),async()=>receipt);
 assert.deepEqual(recovered,{kind:'ready',selection:{kind:'capability',id:endpoint.id,revisionId:endpoint.revisionId},pending:null,capability:endpoint});
});

test('retained draft restoration preserves component identity and resolves standalone capability receipts',async()=>{
 const result={...preparation(),environmentId:null,status:'draft' as const};
 const receipt=retainedReceipt(result,{name:'Standalone mail',specification:spec},'capability.add'),selection={kind:'pending' as const,operationId:receipt.reference,componentId:'gmail'};
 const restored=await restoreCapabilitySelection(selection,inventory(),async()=>receipt);
 assert.equal(restored.kind,'ready');if(restored.kind!=='ready')return;
 assert.deepEqual(restored.selection,selection);assert.equal(restored.pending?.plan.name,'Standalone mail');assert.equal(restored.pending?.plan.result.environmentId,null);
 const missing=await restoreCapabilitySelection({...selection,componentId:'removed'},inventory(),async()=>receipt);assert.equal(missing.kind,'missing');
 const wrong=await restoreCapabilitySelection({...selection,operationId:'environment:another'},inventory(),async()=>receipt);assert.equal(wrong.kind,'failed');
});

test('inventory drafts survive unavailable receipts and exact saved revisions do not follow catalog head',async()=>{
 const result=preparation(),selection={kind:'pending' as const,operationId:result.operationId,componentId:'gmail'};
 const restored=await restoreCapabilitySelection(selection,inventory({preparations:[{name:'Mail',description:'',result}]}),missingRead);
 assert.equal(restored.kind,'ready');if(restored.kind==='ready')assert.equal(restored.pending?.component.id,'gmail');
 const old={kind:'capability' as const,id:endpoint.id,revisionId:'older-mail'};
 const older={...endpoint,revisionId:'older-mail'},selected=await restoreCapabilitySelection(old,inventory({capabilities:[endpoint]}),async()=>older);
 assert.deepEqual(selected,{kind:'ready',selection:old,pending:null,capability:older});
 assert.equal((await restoreCapabilitySelection(old,inventory({capabilities:[endpoint]}),missingRead)).kind,'missing');
 assert.equal((await restoreCapabilitySelection(old,inventory({capabilities:[endpoint]}),async()=>endpoint)).kind,'failed');
});

test('invalid retained owner data does not discard a saved selection',async()=>{
 const selection={kind:'pending' as const,operationId:`environment:${retainedId}`,componentId:'gmail'};
 const result=await restoreCapabilitySelection(selection,inventory(),async()=>({}));assert.equal(result.kind,'failed');assert.match(result.message,/could not be read/);
});


test('standalone preparation keeps setup and recovery reachable after registration until ready',()=>{
 const result=preparation();result.environmentId=null;result.components[0]!.capabilityId=endpoint.id;result.components[0]!.capabilityRevisionId=endpoint.revisionId;
 const selected={kind:'pending' as const,operationId:result.operationId,componentId:'gmail'};
 const state=inventory({capabilities:[endpoint],preparations:[{name:'Mail',description:'',result}]});
 for(const status of ['draft','blocked','preparing','partial','failed'] as const){
  result.status=status;
  assert.deepEqual(pendingCapabilities(state).map(value=>value.component.id),['gmail']);
  assert.deepEqual(completedSelection(selected,result,state),selected);
 }
 result.status='ready';
 assert.deepEqual(pendingCapabilities(state),[]);
 assert.deepEqual(completedSelection(selected,result,state),{kind:'capability',id:endpoint.id,revisionId:endpoint.revisionId});
});


test('catalog selection excludes unfinished standalone setup without hiding existing completed releases',()=>{
 const result=preparation();result.environmentId=null;result.components[0]!.capabilityId=endpoint.id;
 const managed:PreparationResult={...preparation(),environmentId:null};managed.components[0]!.capabilityId='release-pending';
 const packageCapability={kind:'managed' as const,id:'package',name:'Managed',source:{repository:'/fixture',subdirectory:''},createdAt:'2026-10-13'};
 const state=inventory({capabilities:[endpoint,packageCapability],releases:[{id:'release-pending',packageId:'package'},{id:'release-ready',packageId:'package'}] as Inventory['releases'],preparations:[{name:'Connection',description:'',result},{name:'Managed',description:'',result:managed}]});
 const blocked=selectableCatalog(state);
 assert.deepEqual(blocked.capabilities,[]);assert.deepEqual(blocked.releases.map(release=>release.id),['release-ready']);
 result.status='ready';managed.status='ready';
 const ready=selectableCatalog(state);assert.deepEqual(ready.capabilities,state.capabilities);assert.deepEqual(ready.releases,state.releases);
 result.status='blocked';result.environmentId='existing-environment';managed.status='blocked';managed.environmentId='existing-environment';
 const composition=selectableCatalog(state);assert.deepEqual(composition.capabilities,state.capabilities);assert.deepEqual(composition.releases,state.releases);
});


test('managed catalog registration cannot replace a draft before its release is installed',()=>{
 const result=preparation();result.environmentId=null;result.components[0]!.catalogId='managed-tool';
 const catalog={kind:'managed' as const,id:'managed-tool',name:'Managed tool',source:{repository:'/fixture',subdirectory:''},createdAt:'2026-10-13'};
 const state=inventory({capabilities:[catalog],releases:[{id:'older-release',packageId:catalog.id}] as Inventory['releases'],preparations:[{name:'Managed tool',description:'',result}]});
 const selection={kind:'pending' as const,operationId:result.operationId,componentId:'gmail'};
 assert.equal(pendingCapabilities(state).length,1);assert.deepEqual(selectableCatalog(state).capabilities,[]);
 assert.deepEqual(selectableCatalog(state).releases,state.releases);assert.deepEqual(completedSelection(selection,result,state),selection);
 result.status='ready';result.components[0]!.capabilityId='new-release';
 assert.deepEqual(completedSelection(selection,result,inventory()),{kind:'capability',id:catalog.id});
 assert.deepEqual(selectableCatalog(state).capabilities,[catalog]);assert.deepEqual(pendingCapabilities(state),[]);
});
