import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {serveHttp} from './fixtures/adr011/server.mjs';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {RackConfig,RackFault,OfficialView,type OfficialEntry,type OfficialManifest,type ConnectionRevision,type Realization,type Revision,Manifest} from '../src/environment/contracts.ts';
import type {ContainerState} from '../src/environment/backend.ts';
import {Connections} from '../src/environment/connections.ts';
import {officialDigest} from '../src/environment/catalog.ts';
import {environmentOperation} from '../src/cli/environment-operations.ts';
import {Request} from '../src/cli/contracts.ts';
import {parseResult} from '../src/cli/results.ts';
import {owner} from '../src/caller.ts';
import {loadRackConfig,createEnvironmentDaemon} from '../src/environment/daemon.ts';
import {loadConfig} from '../src/config.ts';

const exec=promisify(execFile);
const entry=(id:string,definition:OfficialEntry['definition'],version='1'):OfficialEntry=>{const value={id,version,name:id,description:'Controlled catalog fixture',prerequisites:[],configurationRequirements:[],usageSkills:['example'],definition};return {...value,digest:officialDigest(value)};};
const collection=(entries:OfficialEntry[],version='1'):OfficialManifest=>({format:1,version,entries});
/** Catalog tests control distribution, backend failures and local sources through owner inputs. */
async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-official-'))),config=RackConfig.parse({stateRoot:join(root,'rack'),socketPath:join(root,'rack.sock'),catalogSources:{fixture:join(root,'source')},monitorMs:3600000});
 let rack:EnvironmentRack|undefined,installs=0,failInstall=false,endpoint='';const states=new Map<string,ContainerState>();
 const backend:RackBackend={async ready(){},async owned(){return [...states.values()];},async remove(id){states.delete(id);},async publishAuthority(){},async inspect(id){return states.get(id)??null;},async start(mount,release){assert(endpoint);const value={id:mount.id,running:true,exitCode:0,oom:false,endpoint,labels:{'polariton.mount':mount.id,'polariton.generation':mount.generation,'polariton.release':release.id}};states.set(value.id,value);return value;},async install(source,commit){installs++;if(failInstall)throw new RackFault('BUILD_FAILED','Controlled preparation failure');return {source,commit,artifactDigest:'artifact',imageId:'image',image:'fixture@sha256:'+ '0'.repeat(64),manifest:Manifest.parse({format:1,name:'fixture',description:'',image:'fixture@sha256:'+'0'.repeat(64),build:[],entrypoint:['node','server.mjs'],lockfiles:['lock'],configSchema:{type:'object'},mcpPath:'/mcp',port:8080,state:'scratch'}),locks:{}};}};
 t.after(async()=>{await rack?.close();await rm(root,{recursive:true,force:true});});
 return {root,config,get rack(){assert(rack);return rack;},get installs(){return installs;},set endpoint(value:string){endpoint=value;},set failInstall(value:boolean){failInstall=value;},async open(manifest?:OfficialManifest){await rack?.close();rack=undefined;rack=await new EnvironmentRack(config,()=>backend,manifest).open();return rack;},async git(){const path=config.catalogSources.fixture!;await mkdir(path);await writeFile(join(path,'source'),'fixture');await exec('git',['init','--quiet',path]);await exec('git',['-C',path,'add','.']);await exec('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@polariton.invalid','commit','--quiet','-m','fixture']);return (await exec('git',['-C',path,'rev-parse','HEAD'])).stdout.trim();}};
}
const provision=(entryId:string,version='1',install=false,operationId=randomUUID())=>({kind:'catalog.provision' as const,entryId,version,install,operationId});

test('production collection is empty and reachable through read-only CLI owner contracts',async t=>{
 const f=await fixture(t);await f.open();
 const result=await environmentOperation(f.rack,Request.parse({version:1,command:{kind:'catalog.list',input:{}}}),owner);
 assert.deepEqual(parseResult('catalog.list',result),{catalogVersion:'1',items:[],next:null});
 assert.equal((await f.rack.inventory()).operations.length,0);assert.equal(f.installs,0);
 await assert.rejects(f.rack.execute(provision('missing')),{code:'NOT_FOUND'});
});

test('HTTP and stdio official entries compose through Apply and serve real tools without provisioning during inspection',async t=>{
 const f=await fixture(t),http=await serveHttp();t.after(()=>http.close());
 const script=resolve('tests/fixtures/adr011/server.mjs'),preview=await new Connections(f.config).preview({configuration:{mcpServers:{http:{url:http.url},stdio:{command:await realpath(process.execPath),args:[script]}}},resolutions:{}});
 assert.deepEqual(preview.errors,[]);
 const manifest=collection(preview.entries.map(value=>entry(value.name,value.definition)));await f.open(manifest);
 assert.equal(f.rack.catalog().items.length,2);assert.equal((await f.rack.inventory()).capabilities.length,0);
 const capabilities:ConnectionRevision[]=[];
 for(const expected of manifest.entries){const command=provision(expected.id),result=OfficialView.parse(await f.rack.execute(command));assert.equal(result.state,'registered');const capability=f.rack.capability(result.capabilityId!);assert(capability.kind!=='managed');capabilities.push(capability);assert.equal(capability.origin?.digest,expected.digest);assert.deepEqual(await f.rack.execute(command),result);}
 assert.equal(f.installs,0);
 const revision=await f.rack.execute({kind:'environment.publish',operationId:'publish',expectedBase:null,document:{format:2,environmentId:'official',name:'Official fixture',description:'',components:capabilities.map(value=>({id:value.id,name:value.name,definition:{capabilityId:value.id,revisionId:value.revisionId}}))}}) as Revision;
 const applied=await f.rack.execute({kind:'environment.apply',operationId:'apply',environmentId:revision.environmentId,revisionId:revision.revisionId}) as Realization;assert.equal(applied.status,'ready');
 const grant=await f.rack.acquireAccess({id:'access',owner:'main',principal:'fixture',workspace:f.root,requireHead:true,environment:{environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name}});
 for(const server of grant.servers){const client=new Client({name:'official-qualification',version:'1'});try{await client.connect('url' in server?new StreamableHTTPClientTransport(new URL(server.url)):new StdioClientTransport({command:server.command,args:server.args,stderr:'pipe'}));const result=await client.callTool({name:'transform',arguments:{value:6,label:'official'}});assert.equal((result.structuredContent as {value:number}).value,43);}finally{await client.close();}}
 await f.rack.releaseAccess({id:'access',owner:'main'});await f.open(manifest);assert.equal((await f.rack.inventory()).capabilities.length,2);
 const changed=entry('http',{...preview.entries[0]!.definition,kind:'http',url:http.url+'/second'} as OfficialEntry['definition'],'2');await f.open(collection([...manifest.entries,changed],'2'));
 const added=OfficialView.parse(await f.rack.execute(provision('http','2')));assert.notEqual(added.capabilityId,capabilities[0]!.id);assert.equal((await f.rack.revision('official','publish')).components[0]!.id,capabilities[0]!.id);
 const original=capabilities[0]!;await assert.rejects(f.rack.execute({kind:'capability.revise',operationId:'edit-official',id:original.id,expectedBase:original.revisionId,entry:preview.entries[0]}),{code:'CATALOG_IMMUTABLE'});
});

test('managed partial preparation retains registration and retries converge across restart and catalog removal',async t=>{
 const f=await fixture(t),commit=await f.git(),managed=entry('managed',{kind:'managed',source:'fixture',subdirectory:'',commit}),manifest=collection([managed]);await f.open(manifest);
 f.failInstall=true;const command=provision('managed','1',true);
 await assert.rejects(f.rack.execute(command),{code:'BUILD_FAILED'});assert.equal(f.rack.operation(command.operationId).state,'failed');assert.equal(f.rack.catalogEntry('managed').versions[0]!.state,'registered');assert.equal((await f.rack.inventory()).capabilities.length,1);
 await f.open(collection([],'2'));f.failInstall=false;
 const recovered=OfficialView.parse(await f.rack.execute(command));assert.equal(recovered.state,'installed');assert.equal(recovered.available,false);assert.equal(f.installs,2);assert.equal(f.rack.operation(command.operationId).attempts.length,2);
 assert.deepEqual(await f.rack.execute(command),recovered);await f.rack.execute(provision('managed','1',true));assert.equal(f.installs,2);assert.equal((await f.rack.inventory()).releases.length,1);
 const release=(await f.rack.inventory()).releases[0]!;assert.equal(release.commit,commit);assert.equal(release.origin?.digest,managed.digest);
 const http=await serveHttp();t.after(()=>http.close());f.endpoint=http.url;
 await f.rack.execute({kind:'environment.publish',operationId:'managed-env',expectedBase:null,document:{format:2,environmentId:'managed',name:'Managed official',description:'',components:[{id:'tool',name:'Tool',releaseId:release.id,configuration:{}}]}});
 const applied=await f.rack.execute({kind:'environment.apply',operationId:'managed-apply',environmentId:'managed',revisionId:'managed-env'}) as Realization;assert.equal(applied.status,'ready');
 const grant=await f.rack.acquireAccess({id:'managed-access',owner:'main',principal:'fixture',workspace:f.root,requireHead:true,environment:{environmentId:'managed',revisionId:'managed-env',name:'Managed official'}}),server=grant.servers[0]!;assert('url' in server);
 const client=new Client({name:'managed-official-test',version:'1'});try{await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:Object.fromEntries(server.headers.map(value=>[value.name,value.value]))}}));const result=await client.callTool({name:'transform',arguments:{value:2,label:'managed'}});assert.equal((result.structuredContent as {value:number}).value,15);}finally{await client.close();}
 await f.rack.releaseAccess({id:'managed-access',owner:'main'});assert.equal(f.installs,2);

 await assert.rejects(f.rack.execute({...command,install:false}),{code:'OPERATION_CONFLICT'});
 await assert.rejects(f.rack.execute({kind:'release.install',operationId:'wrong-commit',packageId:recovered.capabilityId,commit:'1'.repeat(40)}),{code:'CATALOG_IMMUTABLE'});
});

test('official provisioning enforces owner authority and version immutability without overwriting user entries',async t=>{
 const f=await fixture(t),definition:OfficialEntry['definition']={kind:'http',url:'https://example.invalid/mcp',headers:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}},original=entry('http',definition);await f.open(collection([original]));
 const denied=provision('http');await assert.rejects(f.rack.execute(denied,{kind:'worker',id:randomUUID(),processId:randomUUID()}),{code:'ACTOR_DENIED'});assert.equal((await f.rack.inventory()).operations.length,0);
 const imported=await f.rack.execute({kind:'capability.import',operationId:'user',entries:[{name:'http (http@1)',definition}]});const official=OfficialView.parse(await f.rack.execute(provision('http')));assert(official.capabilityId);assert.equal((await f.rack.inventory()).capabilities.filter(value=>value.name==='http (http@1)').length,2);assert.deepEqual(await f.rack.execute({kind:'capability.import',operationId:'user',entries:[{name:'http (http@1)',definition}]}),imported);
 const other=entry('other',definition);await f.open(collection([original,other]));await f.rack.execute(provision('other'));
 await assert.rejects(f.open(collection([entry('other',{...definition,url:'https://changed.invalid/mcp'})],'2')),{code:'CATALOG_IMMUTABLE'});
 await f.open(collection([other]));assert.equal(f.rack.catalogEntry('other').versions[0]!.entry.digest,other.digest);
 await assert.rejects(f.rack.execute(provision('other','1',true)),{code:'CATALOG_INSTALL'});
});

test('invalid manifests fail before service opens and configured source paths resolve relative to the configuration',async t=>{
 const f=await fixture(t),definition:OfficialEntry['definition']={kind:'http',url:'https://example.invalid/mcp',headers:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}},value=entry('http',definition);
 await assert.rejects(f.open(collection([{...value,description:'changed'}])),{code:'CATALOG_DIGEST'});
 await assert.rejects(f.open(collection([value,value])),{code:'CATALOG_DUPLICATE'});
 const path=join(f.root,'environment.json');await writeFile(path,JSON.stringify({stateRoot:'rack',socketPath:'rack.sock',catalogSources:{tools:'local-git'}}));assert.equal((await loadRackConfig(path)).catalogSources.tools,join(f.root,'local-git'));
});


test('standalone CLI routes catalog version and install flags to the Environment owner',async t=>{
 // macOS's per-user temporary directory can exceed the Unix socket path budget.
 const f=await fixture(t),config={...f.config,socketPath:join('/tmp',`polariton-catalog-${randomUUID()}.sock`)},environmentPath=join(f.root,'environment.json'),appPath=join(f.root,'app.json');
 await writeFile(environmentPath,JSON.stringify(config));await writeFile(appPath,JSON.stringify({...await loadConfig(),stateRoot:join(f.root,'main'),environmentConfig:environmentPath}));
 const daemon=await createEnvironmentDaemon(config);t.after(()=>daemon.app.close());
 const cli=async(args:string[])=>{try{return await exec(process.execPath,['bin/harnessctl',...args,'--config',appPath],{env:{...process.env,DSH_SHELL:'',DSH_HARNESSCTL_TOKEN:'',HARNESSCTL_TOKEN:''}});}catch(error){if(error&&typeof error==='object'&&'stdout' in error)return error as {stdout:string;stderr:string};throw error;}};
 const listed=await cli(['catalog','list']);assert.deepEqual(JSON.parse(listed.stdout).data,{catalogVersion:'1',items:[],next:null});
 const requestId=randomUUID(),failed=await cli(['catalog','provision','missing','--details','--version','1','--install','--request-id',requestId]),receipt=JSON.parse(failed.stdout).data;
 assert.equal(receipt.command,'catalog.provision');assert.equal(receipt.input.version,'1');assert.equal(receipt.input.install,true);assert.equal(receipt.error.code,'NOT_FOUND');assert.equal(receipt.requestId,requestId);
 assert.equal((await daemon.rack.inventory()).capabilities.length,0);
});

test('failed source provisioning binds immutable content before any capability exists',async t=>{
 const f=await fixture(t),initial=entry('managed',{kind:'managed',source:'missing',subdirectory:'',commit:'0'.repeat(40)});await f.open(collection([initial]));
 await assert.rejects(f.rack.execute(provision('managed')),{code:'CATALOG_SOURCE'});assert.equal(f.rack.catalogEntry('managed').versions[0]!.state,'unprovisioned');assert.equal((await f.rack.inventory()).capabilities.length,0);
 const changed={...initial,description:'changed'};changed.digest=officialDigest(changed);
 await assert.rejects(f.open(collection([changed],'2')),{code:'CATALOG_IMMUTABLE'});
 await f.open(collection([],'2'));assert.equal(f.rack.catalogEntry('managed').versions[0]!.entry.digest,initial.digest);
});
