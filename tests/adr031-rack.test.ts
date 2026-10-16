import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {RackConfig,BrowserInventory,type AccessGrant,type Revision,type ConnectionRevision} from '../src/environment/contracts.ts';
import {CapabilityInspection,PreparationInput,type PreparationResult,type ValidationResult} from '../src/environment/preparation-contracts.ts';

async function fixture(t:test.TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-031-rack-'))),executable=await realpath(process.execPath);
 const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'owner.sock'),monitorMs:3600000});
 const backend=new Proxy({},{get(){return async()=>{throw new Error('Local preparation must not consult Docker');};}}) as RackBackend;
 let rack=await new EnvironmentRack(config,()=>backend).open();
 t.after(async()=>{await rack.close();await rm(root,{recursive:true,force:true});});
 const spec=PreparationInput.parse({name:'Persistent tool',components:[{id:'tool',name:'Transform',source:{kind:'installed',command:executable},runtime:{kind:'local'},connection:{kind:'stdio',args:[resolve('tests/fixtures/adr011/server.mjs')],env:{DATA_DIRECTORY:'${POLARITON_DATA}'}},requirements:{storage:{scope:'capability',access:'exclusive',retention:'retain'}},authentication:{kind:'none'},checks:[{name:'arithmetic',effects:'read',steps:[{tool:'transform',arguments:{value:6,label:'prepared-validation'}}]}]}]});
 const prepare=(input=spec)=>rack.execute({kind:'environment.prepare',operationId:randomUUID(),input}) as Promise<PreparationResult>;
 const acquire=(result:PreparationResult,id=randomUUID())=>rack.acquireAccess({id,owner:'test-main',principal:id,workspace:root,environment:{environmentId:result.environmentId!,revisionId:result.revisionId!,name:spec.name},requireHead:false});
 return {root,spec,prepare,acquire,get rack(){return rack;},async restart(){await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();}};
}
function value(grant:AccessGrant,name:string){const server=grant.servers[0]!;assert('command'in server);return server.env.find(field=>field.name===name)!.value;}
test('display names remain human choices while catalog identities distinguish repeated preparations',async t=>{
 const f=await fixture(t),first=await f.prepare(),second=await f.prepare();
 assert.equal(first.status,'ready');assert.equal(second.status,'ready');
 const capabilities=(await f.rack.inventory()).capabilities;
 assert.deepEqual(capabilities.map(value=>value.name),['Transform','Transform']);assert.notEqual(capabilities[0]!.id,capabilities[1]!.id);
 // Exercise the exact suffix that older compound preparation retained, including
 // an authentication-compatible revision chain, without migrating stored records.
 const before=f.rack.capability(first.components[0]!.capabilityId!) as ConnectionRevision;
 const {id,name,revisionId,baseRevisionId,operationId,createdAt,origin,...definition}=before;
 const derived=`Transform (${first.environmentId}/tool)`;
 const revised=await f.rack.execute({kind:'capability.revise',operationId:randomUUID(),id,expectedBase:revisionId,entry:{name:derived,definition}}) as ConnectionRevision;
 assert.equal(revised.name,derived,'The durable revision is retained as written');
 assert.equal(f.rack.capability(id).name,'Transform');assert.equal((await f.rack.inventory()).capabilities.find(value=>value.id===id)!.name,'Transform');
 await f.restart();assert.equal(f.rack.capability(id,revised.revisionId).name,'Transform');
});
test('catalog inspection keeps dependency facts separate from exact environment validation',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),id=prepared.components[0]!.capabilityId!,revision=prepared.components[0]!.capabilityRevisionId!;
 const before=CapabilityInspection.parse(await f.rack.capabilityDetails(id,revision));
 assert.equal(before.component.source.kind,'installed');assert.equal(before.component.requirements.storage?.access,'exclusive');assert.equal(before.component.checks[0]!.name,'arithmetic');assert.equal(before.component.evidence.dependencies,'ready');assert.equal(before.component.evidence.connection,'untested');
 await f.rack.execute({kind:'environment.validate',operationId:randomUUID(),input:{target:prepared.environmentId,revision:prepared.revisionId,check:'arithmetic'}});
 const observed=await f.rack.capabilityDetails(id,revision);
 assert.equal(observed.component.evidence.connection,'untested');assert.deepEqual(observed.component.evidence.tools,[]);assert.equal(observed.component.evidence.checks[0]!.status,'not-run');
 assert.equal(observed.environments.length,1);assert.equal(observed.environments[0]!.revisionId,prepared.revisionId);assert.equal(observed.environments[0]!.evidence.connection,'connected');assert.equal(observed.environments[0]!.evidence.checks[0]!.status,'passed');assert(observed.environments[0]!.evidence.observedAt);
 const beforeEffects=(await f.rack.inventory()).operations.length;
 await f.rack.capabilityDetails(id,revision);assert.equal((await f.rack.inventory()).operations.length,beforeEffects);
});
test('authentication revisions preserve declarations only while the software contract stays identical',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),component=prepared.components[0]!,before=f.rack.capability(component.capabilityId!) as ConnectionRevision;
 const changed=await f.rack.execute({kind:'capability.authenticate',operationId:randomUUID(),id:before.id,expectedBase:before.revisionId,authentication:{kind:'none'}}) as ConnectionRevision;
 const preserved=await f.rack.capabilityDetails(changed.id,changed.revisionId);
 assert.equal(preserved.component.checks[0]!.name,'arithmetic');assert.equal(preserved.environments.length,0,'The prior environment selects a different definition revision');
 const {id,name,revisionId,baseRevisionId,operationId,createdAt,origin,...definition}=changed;assert.equal(definition.kind,'stdio');if(definition.kind!=='stdio')return;
 const edited=await f.rack.execute({kind:'capability.revise',operationId:randomUUID(),id,expectedBase:revisionId,entry:{name,definition:{...definition,args:[...definition.args,'--different-contract']}}}) as ConnectionRevision;
 assert.deepEqual((await f.rack.capabilityDetails(id,edited.revisionId)).component.checks,[]);
 assert.equal((await f.rack.capabilityDetails(id,before.revisionId)).component.checks[0]!.name,'arithmetic');
});
test('missing private credentials do not misreport installed dependencies',async t=>{
 const f=await fixture(t);
 const result=await f.rack.execute({kind:'capability.import',operationId:randomUUID(),entries:[{name:'Private endpoint',definition:{kind:'http',url:'https://private.example/mcp',headers:{Authorization:'Bearer ${PRIVATE_TOKEN}'},credentials:{PRIVATE_TOKEN:{account:'fixture',authority:'read'}},requirements:{files:[],identityFiles:[],execution:'foreground-host'}}}]}) as {capabilities:ConnectionRevision[]};
 const detail=await f.rack.capabilityDetails(result.capabilities[0]!.id);
 assert.equal(detail.component.evidence.dependencies,'ready');assert.equal(detail.component.evidence.authentication,'referenced');assert.equal(detail.component.evidence.connection,'untested');assert.equal(detail.component.error,null);assert.deepEqual(detail.environments,[]);
});
test('standalone resource requirements survive composition and govern concurrent access',async t=>{
 const f=await fixture(t),original=f.spec.components![0]!;
 const specification={...original,connection:{kind:'stdio',args:original.connection.kind==='stdio'?original.connection.args:[],env:{}},requirements:{...original.requirements,storage:undefined,resource:{identity:'shared-instrument',exclusive:true}}};
 const draft=await f.rack.execute({kind:'capability.add',operationId:randomUUID(),input:{name:'Instrument',specification}}) as PreparationResult;
 const ready=await f.rack.execute({kind:'capability.complete',operationId:randomUUID(),input:{target:draft.operationId,expectedVersion:draft.version,componentId:'tool'}}) as PreparationResult,view=ready.components[0]!;
 const component={id:'instrument',name:'Instrument',definition:{capabilityId:view.capabilityId!,revisionId:view.capabilityRevisionId!}};
 const publish=(environmentId:string,resource?:{identity:string,exclusive:boolean})=>f.rack.execute({kind:'environment.publish',operationId:randomUUID(),expectedBase:null,document:{format:2,environmentId,name:environmentId,description:'',components:[{...component,...resource?{resource}:{}}]}}) as Promise<Revision>;
 const first=await publish('first-instrument'),second=await publish('second-instrument');assert.deepEqual(first.components[0]!.resource,specification.requirements.resource);
 await assert.rejects(publish('weakened',{identity:'shared-instrument',exclusive:false}),{code:'RESOURCE_REQUIREMENT'});await assert.rejects(publish('substituted',{identity:'other-instrument',exclusive:true}),{code:'RESOURCE_REQUIREMENT'});
 for(const revision of [first,second])await f.rack.execute({kind:'environment.apply',operationId:randomUUID(),environmentId:revision.environmentId,revisionId:revision.revisionId});
 const firstAccess=await f.acquire({...ready,environmentId:first.environmentId,revisionId:first.revisionId}),busy=await f.acquire({...ready,environmentId:second.environmentId,revisionId:second.revisionId});
 assert.equal(firstAccess.servers.length,1);assert.equal(busy.components[0]!.code,'RESOURCE_BUSY');await f.rack.releaseAccess({id:busy.id,owner:'test-main'});await f.rack.releaseAccess({id:firstAccess.id,owner:'test-main'});
 const available=await f.acquire({...ready,environmentId:second.environmentId,revisionId:second.revisionId});assert.equal(available.servers.length,1);await f.rack.releaseAccess({id:available.id,owner:'test-main'});
});
test('persistent data retains capability ownership across access, revision and daemon lifetimes',async t=>{
 const f=await fixture(t),prepared=await f.prepare();assert.equal(prepared.status,'ready');
 const first=await f.acquire(prepared),data=value(first,'DATA_DIRECTORY'),scratch=value(first,'TMPDIR');
 assert.notEqual(data,scratch);assert(Buffer.byteLength(scratch)<80);await writeFile(join(data,'retained'),'survives release');
 const busy=await f.acquire(prepared);assert.equal(busy.components[0]!.code,'RESOURCE_BUSY');assert.equal(busy.servers.length,0);await f.rack.releaseAccess({id:busy.id,owner:'test-main'});
 await f.rack.releaseAccess({id:first.id,owner:'test-main'});await assert.rejects(stat(scratch),{code:'ENOENT'});assert.equal(await readFile(join(data,'retained'),'utf8'),'survives release');
 const updated=await f.prepare({...f.spec,name:'Updated environment',target:prepared.environmentId!,expectRevision:prepared.revisionId!});assert.equal(updated.status,'ready');assert.equal(updated.components[0]!.capabilityId,prepared.components[0]!.capabilityId);assert.notEqual(updated.revisionId,prepared.revisionId);
 await f.restart();const next=await f.acquire(updated);assert.equal(value(next,'DATA_DIRECTORY'),data);assert.notEqual(value(next,'TMPDIR'),scratch);await f.rack.releaseAccess({id:next.id,owner:'test-main'});
 const stale=await f.prepare({...f.spec,target:prepared.environmentId!,expectRevision:prepared.revisionId!});assert.equal(stale.status,'blocked');assert.equal(stale.actions[0]!.code,'STALE_REVISION');
});
test('expert revision edits preserve common inspection and inference-free functional validation',async t=>{
 const f=await fixture(t),prepared=await f.prepare(),original=await f.rack.revision(prepared.environmentId!,prepared.revisionId!);
 const edited=await f.rack.execute({kind:'environment.publish',operationId:randomUUID(),expectedBase:original.revisionId,document:{format:2,environmentId:original.environmentId,name:'Owner rename',description:'Updated owner description',components:original.components}}) as Revision;
 await f.rack.execute({kind:'environment.apply',operationId:randomUUID(),environmentId:edited.environmentId,revisionId:edited.revisionId});
 const inspected=await f.rack.inspect(edited.environmentId,edited.revisionId);assert.equal(inspected.components[0]!.source.kind,'installed');assert.equal(inspected.components[0]!.checks[0]!.name,'arithmetic');
 const result=await f.rack.execute({kind:'environment.validate',operationId:randomUUID(),input:{target:edited.environmentId,revision:edited.revisionId,check:'arithmetic'}}) as ValidationResult;
 assert.equal(result.components[0]!.connected,true);assert.equal(result.components[0]!.check!.status,'passed');assert.equal(result.components[0]!.cleanup,'settled');
 const after=await f.rack.inspect(edited.environmentId,edited.revisionId);assert.equal(after.components[0]!.evidence.connection,'connected');assert.equal(after.components[0]!.evidence.checks[0]!.status,'passed');
 assert.equal((await f.rack.inspect(original.environmentId,original.revisionId)).components[0]!.evidence.connection,'untested');
});
test('an unavailable checked component leaves healthy validation available and records each failure cause',async t=>{
 const f=await fixture(t),healthy=f.spec.components![0]!;
 const prepared=await f.prepare({...f.spec,components:[healthy,{...healthy,id:'missing',name:'Missing prerequisite',requirements:{...healthy.requirements,files:[join(f.root,'unavailable-application')]}}]});
 assert.equal(prepared.status,'partial');
 const operationId=randomUUID(),result=await f.rack.execute({kind:'environment.validate',operationId,input:{target:prepared.environmentId!,revision:prepared.revisionId!,check:'arithmetic'}}) as ValidationResult;
 assert.equal(result.components[0]!.check!.status,'passed');assert.equal(result.components[1]!.check!.status,'failed');assert.equal(result.components[1]!.error,'PREPARATION_UNAVAILABLE');assert.equal(f.rack.operation(operationId).state,'partial');
 const failed=await f.prepare({...f.spec,name:'Bad input check',components:[{...healthy,checks:[{name:'invalid',effects:'read',steps:[{tool:'transform',arguments:{}}]}]}]});
 const check=await f.rack.execute({kind:'environment.validate',operationId:randomUUID(),input:{target:failed.environmentId,revision:failed.revisionId!,check:'invalid'}}) as ValidationResult;
 assert.equal(check.components[0]!.check!.status,'failed');assert(check.components[0]!.error);
});
test('blocked account setup reaches browser inventory before publication and survives daemon restart',async t=>{
 const f=await fixture(t);
 const input=PreparationInput.parse({name:'Workspace Gmail',components:[{id:'gmail',name:'Gmail',source:{kind:'endpoint',url:'https://gmail.example/mcp'},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'workspace-gmail',scopes:['read']}}]});
 const result=await f.prepare(input);assert.equal(result.status,'blocked');assert.equal(result.actions[0]!.code,'ACCOUNT_NOT_FOUND');
 const inventory=BrowserInventory.parse(await f.rack.inventory());assert.deepEqual(inventory.environments,[]);
 assert.equal(inventory.preparations[0]!.result.operationId,result.operationId);assert.equal(inventory.preparations[0]!.result.components[0]!.authentication.kind,'oauth');
 await f.restart();
 assert.deepEqual(BrowserInventory.parse(await f.rack.inventory()).preparations,inventory.preparations);
 assert.deepEqual((await f.rack.accountInventory()).accounts,[]);
});

test('source capability setup prepares an installed program independently of environment composition',async t=>{
 const f=await fixture(t),operationId=randomUUID();
 const command={kind:'capability.add',operationId,input:{name:'Independent transform',specification:f.spec.components![0]}};
 const added=await f.rack.execute(command) as PreparationResult;
 assert.equal(added.status,'draft');assert.equal(added.environmentId,null);
 let inventory=BrowserInventory.parse(await f.rack.inventory());assert.equal(inventory.preparations.length,1);assert.deepEqual(inventory.capabilities,[]);assert.deepEqual(inventory.environments,[]);assert.deepEqual(inventory.realizations,[]);assert.deepEqual(inventory.mounts,[]);
 await f.restart();assert.deepEqual(await f.rack.execute(command),added);
 const completion={kind:'capability.complete',operationId:randomUUID(),input:{target:added.operationId,expectedVersion:added.version,componentId:'tool'}};
 const ready=await f.rack.execute(completion) as PreparationResult;assert.equal(ready.status,'ready');assert.equal(ready.environmentId,null);assert.equal(ready.revisionId,null);assert.equal(ready.components[0]!.evidence.dependencies,'ready');
 inventory=BrowserInventory.parse(await f.rack.inventory());assert.equal(inventory.capabilities.length,1);assert.equal(inventory.capabilities[0]!.name,'Independent transform');assert.deepEqual(inventory.environments,[]);assert.deepEqual(inventory.realizations,[]);assert.deepEqual(inventory.mounts,[]);assert.deepEqual(inventory.bindings,[]);
 await f.restart();assert.deepEqual(await f.rack.execute(completion),ready);assert.deepEqual((await f.rack.inventory()).preparations[0]!.result,ready);
 // Composition is a separate explicit publication using the retained capability.
 const view=ready.components[0]!,environmentId='independent-composition';
 const revision=await f.rack.execute({kind:'environment.publish',operationId:randomUUID(),expectedBase:null,document:{format:2,environmentId,name:'Composition',description:'',components:[{id:'tool',name:view.name,definition:{capabilityId:view.capabilityId!,revisionId:view.capabilityRevisionId!}}]}}) as Revision;
 assert.equal((await f.rack.inventory()).environments.length,1);assert.deepEqual((await f.rack.inventory()).realizations,[]);
 assert.equal((await f.rack.inspect(environmentId,revision.revisionId)).components[0]!.checks[0]!.name,'arithmetic');
});

test('an OAuth capability remains discoverable before and after blocked setup without creating an environment',async t=>{
 const f=await fixture(t),added=await f.rack.execute({kind:'capability.add',operationId:randomUUID(),input:{name:'Mail',specification:{id:'mail',name:'Mail',source:{kind:'endpoint',url:'https://mail.example/mcp'},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'mail-account',scopes:['read']}}}}) as PreparationResult;
 assert.equal(added.status,'draft');
 const blocked=await f.rack.execute({kind:'capability.complete',operationId:randomUUID(),input:{target:added.operationId,expectedVersion:added.version,componentId:'mail'}}) as PreparationResult;
 assert.equal(blocked.status,'blocked');assert.equal(blocked.components[0]!.error?.code,'ACCOUNT_NOT_FOUND');
 await f.restart();const inventory=BrowserInventory.parse(await f.rack.inventory());assert.equal(inventory.preparations[0]!.result.operationId,added.operationId);assert.deepEqual(inventory.environments,[]);assert.deepEqual(inventory.realizations,[]);assert.deepEqual(inventory.capabilities,[]);
});

test('standalone registry capability setup installs through the package owner without environment effects',async t=>{
 const {mkdir,chmod,lstat,readdir}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-031-package-'))),npm=join(root,'npm.mjs'),calls=join(root,'calls');
 // The controlled package manager exposes the real subprocess and installation
 // boundary without network access or any dependency on a public registry.
 await writeFile(npm,`import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2);if(args.includes('--version')){console.log('1.0.0');process.exit(0);}
await appendFile(${JSON.stringify(calls)},args[0]+'\\n');
if(args.includes('--package-lock-only'))await writeFile('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{fixture:'1.0.0'}},'node_modules/fixture':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',integrity:'sha512-fixture'}}}));
else if(args[0]==='ci'){await mkdir('node_modules/fixture',{recursive:true});await writeFile('node_modules/fixture/package.json',JSON.stringify({name:'fixture',version:'1.0.0',bin:{fixture:'cli.js'}}));await writeFile('node_modules/fixture/cli.js','#!/usr/bin/env node\\nconsole.log("fixture");');}
else process.exit(1);
`,{mode:0o755});
 const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'owner.sock'),monitorMs:3600000,packageTools:{node:await realpath(process.execPath),npm}});
 const backend=new Proxy({},{get(){return async()=>{throw new Error('Package setup must not consult Docker');};}}) as RackBackend;
 let rack=await new EnvironmentRack(config,()=>backend).open();
 const writable=async(path:string):Promise<void>=>{const info=await lstat(path);if(info.isSymbolicLink())return;if(info.isDirectory()){await chmod(path,0o700);for(const name of await readdir(path))await writable(join(path,name));}else await chmod(path,0o600);};
 t.after(async()=>{await rack.close();await writable(root);await rm(root,{recursive:true,force:true});});
 const added=await rack.execute({kind:'capability.add',operationId:randomUUID(),input:{name:'Fixture package',source:'npm:fixture@1.0.0'}}) as PreparationResult;
 await assert.rejects(stat(calls),{code:'ENOENT'});
 const complete={kind:'capability.complete',operationId:randomUUID(),input:{target:added.operationId,expectedVersion:added.version,componentId:'tool'}};
 const ready=await rack.execute(complete) as PreparationResult;assert.equal(ready.status,'ready',JSON.stringify(ready.actions));assert.equal(ready.components[0]!.evidence.dependencies,'ready');assert.equal(await readFile(calls,'utf8'),'install\nci\n');
 const inventory=BrowserInventory.parse(await rack.inventory());assert.equal(inventory.capabilities.length,1);assert.deepEqual(inventory.environments,[]);assert.deepEqual(inventory.realizations,[]);assert.deepEqual(inventory.mounts,[]);
 await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();assert.deepEqual(await rack.execute(complete),ready);assert.equal(await readFile(calls,'utf8'),'install\nci\n');
 // Familiar imports retain their requested selector, while inspection exposes the
 // exact primary package actually installed by explicit Apply.
 const npx=join(root,'npx');await writeFile(npx,'#!/bin/sh\nexit 99\n',{mode:0o755});
 const preview=await rack.preview({configuration:{mcpServers:{Moving:{command:npx,args:['fixture@latest']}}}});assert.deepEqual(preview.errors,[]);
 const imported=await rack.execute({kind:'capability.import',operationId:randomUUID(),entries:preview.entries}) as {capabilities:ConnectionRevision[]},capability=imported.capabilities[0]!;
 const environment=await rack.execute({kind:'environment.publish',operationId:randomUUID(),expectedBase:null,document:{format:2,environmentId:'moving-import',name:'Moving import',description:'',components:[{id:'tool',name:'Tool',definition:{capabilityId:capability.id,revisionId:capability.revisionId}}]}}) as Revision;
 await rack.execute({kind:'environment.apply',operationId:randomUUID(),environmentId:environment.environmentId,revisionId:environment.revisionId});
 const observed=await rack.capabilityDetails(capability.id);assert.equal(observed.component.source.kind,'npm');assert.equal('version'in observed.component.source&&observed.component.source.version,'1.0.0');assert.deepEqual(observed.installation?.primary,{name:'fixture',version:'1.0.0'});assert.equal(observed.installation?.platform,process.platform);assert.equal(observed.installation?.arch,process.arch);
 const inspection=await rack.inspect(environment.environmentId,environment.revisionId);assert.equal('version'in inspection.components[0]!.source&&inspection.components[0]!.source.version,'1.0.0');
 const requested=rack.capability(capability.id);assert(requested.kind==='stdio'&&requested.package?.manager==='npm');assert.equal(requested.package.specifier,'fixture@latest');
});

test('a managed capability retains its exact catalog identity when release installation fails',async t=>{
 const {mkdir}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const f=await fixture(t),directory=join(f.root,'authored-tool');await mkdir(directory);await writeFile(join(directory,'README'),'Controlled authored source');
 const exec=promisify(execFile),git=async(...args:string[])=>(await exec('git',['-C',directory,...args])).stdout.trim();
 await git('init','--quiet');await git('add','.');await git('-c','user.name=Polariton fixture','-c','user.email=fixture@polariton.invalid','commit','--quiet','-m','Authored tool');
 const added=await f.rack.execute({kind:'capability.add',operationId:randomUUID(),input:{name:'Authored tool',specification:{id:'authored',name:'Authored tool',source:{kind:'git',directory,commit:await git('rev-parse','HEAD')},runtime:{kind:'container'},connection:{kind:'http'},requirements:{},authentication:{kind:'none'}}}}) as PreparationResult;
 const blocked=await f.rack.execute({kind:'capability.complete',operationId:randomUUID(),input:{target:added.operationId,expectedVersion:added.version,componentId:'authored'}}) as PreparationResult;
 assert.equal(blocked.status,'blocked');assert.equal(blocked.components[0]!.capabilityId,null);assert(blocked.components[0]!.catalogId);assert.equal(blocked.components[0]!.evidence.registered,true);
 let inventory=BrowserInventory.parse(await f.rack.inventory());assert.equal(inventory.capabilities.length,1);assert.equal(inventory.capabilities[0]!.id,blocked.components[0]!.catalogId);assert.deepEqual(inventory.releases,[]);assert.deepEqual(inventory.environments,[]);
 await f.restart();inventory=BrowserInventory.parse(await f.rack.inventory());assert.equal(inventory.preparations[0]!.result.components[0]!.catalogId,inventory.capabilities[0]!.id);
 const retried=await f.rack.execute({kind:'capability.complete',operationId:randomUUID(),input:{target:added.operationId,expectedVersion:blocked.version,componentId:'authored'}}) as PreparationResult;
 assert.equal(retried.status,'blocked');assert.equal(retried.components[0]!.catalogId,blocked.components[0]!.catalogId);assert.equal((await f.rack.inventory()).capabilities.length,1);assert.deepEqual((await f.rack.inventory()).environments,[]);
});
