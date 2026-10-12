import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,writeFile,readFile,readdir,rm,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {RackConfig,type ConnectionRevision,type ConnectionComponent,type Revision,type Realization,type AccessRequest} from '../src/environment/contracts.ts';

/** An external-only environment has no reason to consult its container host. */
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-general-mcp-')));
  const credentials=join(root,'credentials.json');
  await writeFile(credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'researcher',authority:'fixture',value:'private-sentinel-adr011'}}}),{mode:0o600});
  const touched:string[]=[];
  const backend=new Proxy({},{get(_target,key){return async()=>{touched.push(String(key));throw new Error('Docker is deliberately unavailable');};}}) as RackBackend;
  const executable=await realpath(process.execPath);
  const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'rack.sock'),credentialFile:credentials,executablePaths:[dirname(executable)],maxIdentityBytes:268435456,monitorMs:3600000});
  let rack=await new EnvironmentRack(config,()=>backend).open();
  t.after(async()=>{await rack.close();await rm(root,{recursive:true,force:true});});
  const preview=(mcpServers:Record<string,unknown>,resolutions:Record<string,string>={})=>rack.preview({configuration:{mcpServers},resolutions});
  const imported=async(name:string,raw:unknown,operationId=`import-${name}`)=>{
    const value=await preview({[name]:raw});assert.deepEqual(value.errors,[]);
    const result=await rack.execute({kind:'capability.import',operationId,entries:value.entries}) as {capabilities:ConnectionRevision[]};
    return result.capabilities[0]!;
  };
  const publish=async(capabilities:ConnectionRevision[],operationId='r1',expectedBase:string|null=null)=>{
    const components:ConnectionComponent[]=capabilities.map((capability,index)=>({id:`component-${index}`,name:capability.name,definition:{capabilityId:capability.id,revisionId:capability.revisionId}}));
    return await rack.execute({kind:'environment.publish',operationId,expectedBase,document:{format:2,environmentId:'external',name:'External',description:'',components}}) as Revision;
  };
  const apply=async(revision:Revision,operationId=`apply-${revision.revisionId}`)=>await rack.execute({kind:'environment.apply',operationId,environmentId:revision.environmentId,revisionId:revision.revisionId}) as Realization;
  const request=(revision:Revision,id='worker',requireHead=true):AccessRequest=>({id,owner:'main',principal:id,workspace:root,environment:{environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name},requireHead});
  return {root,credentials,config,executable,touched,preview,imported,publish,apply,request,get rack(){return rack;},async restart(){await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();}};
}

test('preview and atomic import perform no endpoint request, program launch or Docker operation',async t=>{
  const f=await fixture(t);let requests=0;
  const server=createServer((_request,response)=>{requests++;response.end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert(address&&typeof address!=='string');
  const marker=join(f.root,'launched'),script=join(f.root,'installed.mjs');
  await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  const value=await f.preview({http:{url:`http://127.0.0.1:${address.port}/mcp`},local:{command:f.executable,args:[script]}});
  assert.deepEqual(value.errors,[]);assert.equal(value.entries.length,2);
  await f.rack.execute({kind:'capability.import',operationId:'both',entries:value.entries});
  assert.equal((await f.rack.inventory()).capabilities.length,2);
  assert.equal(requests,0);await assert.rejects(readFile(marker),{code:'ENOENT'});assert.deepEqual(f.touched,[]);
});

test('preview reports each invalid named entry without reflecting credential values',async t=>{
  const f=await fixture(t);
  const secret='do-not-persist-this-token';
  const value=await f.preview({
    legacy:{type:'sse',url:'http://127.0.0.1:1/mcp'},cwd:{command:f.executable,cwd:f.root},
    install:{command:'npx',args:['-y','uninstalled-package']},literal:{url:'https://example.invalid/mcp',headers:{Authorization:`Bearer ${secret}`}},
    embedded:{url:`https://user:${secret}@example.invalid/mcp`},unknown:{url:'https://example.invalid/mcp',unexpected:true},
    evaluate:{command:f.executable,args:['-e','process.exit()']},packageRunner:{command:'uv',args:['run','--with','uninstalled-package','server']},
  });
  assert.equal(value.entries.length,0);assert.equal(value.errors.length,8);
  assert(!JSON.stringify(value).includes(secret));assert.deepEqual(f.touched,[]);
  assert.equal((await f.rack.inventory()).capabilities.length,0);
});

test('bare executable resolution needs an explicit absolute-path confirmation',async t=>{
  const f=await fixture(t),name=basename(f.executable),input={local:{command:name,args:[]}};
  const unresolved=await f.preview(input);
  assert.equal(unresolved.entries.length,0);assert.equal(unresolved.resolutions.local,f.executable);
  const confirmed=await f.preview(input,unresolved.resolutions);
  assert.deepEqual(confirmed.errors,[]);assert.equal(confirmed.entries[0]!.definition.kind,'stdio');
  if(confirmed.entries[0]!.definition.kind==='stdio')assert.equal(confirmed.entries[0]!.definition.command,f.executable);
});

test('imports are atomic, durable and idempotent after a lost reply',async t=>{
  const f=await fixture(t),preview=await f.preview({one:{url:'https://one.invalid/mcp'},two:{url:'https://two.invalid/mcp'}});
  const command={kind:'capability.import' as const,operationId:'batch',entries:preview.entries};
  const first=await f.rack.execute(command);
  assert.deepEqual(await f.rack.execute(command),first);await f.restart();assert.deepEqual(await f.rack.execute(command),first);
  const before=(await f.rack.inventory()).capabilities;
  await assert.rejects(f.rack.execute({...command,entries:preview.entries.slice(0,1)}));
  await assert.rejects(f.rack.execute({...command,operationId:'duplicate-batch',entries:[preview.entries[0]!,preview.entries[0]!]}));
  const mixed=await f.preview({three:{url:'https://three.invalid/mcp'}});
  await assert.rejects(f.rack.execute({...command,operationId:'part-conflict',entries:[mixed.entries[0]!,preview.entries[0]!]}));
  assert.deepEqual((await f.rack.inventory()).capabilities,before);assert.deepEqual(f.touched,[]);
});

test('definition revisions are immutable and require their expected current base',async t=>{
  const f=await fixture(t),first=await f.imported('service',{url:'https://first.invalid/mcp'});
  const preview=await f.preview({service:{url:'https://second.invalid/mcp'}});
  const command={kind:'capability.revise' as const,operationId:'revise',id:first.id,expectedBase:first.revisionId,entry:preview.entries[0]!};
  const second=await f.rack.execute(command) as ConnectionRevision;
  assert.equal(second.id,first.id);assert.notEqual(second.revisionId,first.revisionId);
  assert.deepEqual(await f.rack.capability(first.id,first.revisionId),first);
  assert.deepEqual(await f.rack.capability(first.id),second);
  await assert.rejects(f.rack.execute({...command,operationId:'stale-edit'}));
  await f.restart();assert.deepEqual(await f.rack.execute(command),second);
});

test('external-only preparation and access have no mounts or fabricated grants',async t=>{
  const f=await fixture(t),http=await f.imported('remote',{url:'https://example.invalid/mcp'}),local=await f.imported('local',{command:f.executable,args:[]});
  const revision=await f.publish([http,local]);assert.deepEqual(await f.rack.choices(),[]);
  const applied=await f.apply(revision);assert.equal(applied.status,'ready');
  assert.deepEqual(applied.components.map(value=>value.readiness),['ready-to-connect','ready-to-launch']);
  assert(applied.components.every(value=>value.mountId===null));
  assert.equal((await f.rack.choices()).length,1);
  const request=f.request(revision),grant=await f.rack.acquireAccess(request);assert.equal(grant.servers.length,2);
  const inventory=await f.rack.inventory();assert.equal(inventory.mounts.length,0);assert.equal(inventory.bindings.length,0);
  await f.rack.releaseAccess({id:request.id,owner:request.owner});await f.restart();
  await assert.rejects(f.rack.acquireAccess(request),{code:'ACCESS_RELEASED'});assert.deepEqual(f.touched,[]);
});

test('credential values resolve privately and rotation cannot change account authority',async t=>{
  const f=await fixture(t),capability=await f.imported('private',{url:'https://example.invalid/mcp',headers:{Authorization:'Bearer ${TOKEN}'}});
  const revision=await f.publish([capability]);assert.equal((await f.apply(revision)).status,'ready');
  const first=await f.rack.acquireAccess(f.request(revision,'one'));
  assert('headers' in first.servers[0]!);assert.equal(first.servers[0].headers[0]!.value,'Bearer private-sentinel-adr011');
  assert(!JSON.stringify(await f.rack.inventory()).includes('private-sentinel-adr011'));
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'researcher',authority:'fixture',value:'rotated-sentinel'}}}));
  const second=await f.rack.acquireAccess(f.request(revision,'two'));assert('headers' in second.servers[0]!);assert.equal(second.servers[0].headers[0]!.value,'Bearer rotated-sentinel');
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'other-user',authority:'fixture',value:'rotated-sentinel'}}}));
  assert.equal((await f.rack.acquireAccess(f.request(revision,'three'))).components[0]?.code,'CONNECTION_UNAVAILABLE');
  const allFiles=async(path:string):Promise<string[]>=>{const entries=await readdir(path,{withFileTypes:true});return (await Promise.all(entries.map(entry=>entry.isDirectory()?allFiles(join(path,entry.name)):readFile(join(path,entry.name)).then(value=>[value.toString()])))).flat();};
  const state=(await allFiles(f.config.stateRoot)).join('\n');assert(!state.includes('private-sentinel-adr011'));assert(!state.includes('rotated-sentinel'));
});

test('missing credentials and insecure credential file permissions block preparation',async t=>{
  const f=await fixture(t),capability=await f.imported('private',{url:'https://example.invalid/mcp',headers:{Authorization:'Bearer ${TOKEN}'}}),revision=await f.publish([capability]);
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{}}));
  assert.equal((await f.apply(revision)).status,'partial');assert.equal((await f.rack.choices()).length,1);assert.equal((await f.rack.acquireAccess(f.request(revision))).components[0]?.code,'PREPARATION_UNAVAILABLE');
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'researcher',authority:'fixture',value:'sentinel'}}}));await chmod(f.credentials,0o644);
  assert.equal((await f.apply(revision,'insecure-file')).status,'partial');
  await chmod(f.credentials,0o600);await writeFile(f.credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'researcher',authority:'fixture',value:'sentinel',expiresAt:'2000-01-01T00:00:00Z'}}}));
  assert.equal((await f.apply(revision,'expired')).status,'partial');
});

test('prerequisites and executable drift disable the component while the environment remains selectable',async t=>{
  const f=await fixture(t),script=join(f.root,'script.mjs'),application=join(f.root,'Controlled.app');
  await writeFile(script,'// installed revision one\n');await writeFile(application,'controlled application prerequisite');
  const capability=await f.imported('application',{command:f.executable,args:[script],requirements:{execution:'foreground-host',files:[application],identityFiles:[script]}});
  const revision=await f.publish([capability]);assert.equal((await f.apply(revision)).status,'ready');
  await writeFile(script,'// different installed code\n');
  assert.equal((await f.rack.acquireAccess(f.request(revision))).components[0]?.code,'CONNECTION_UNAVAILABLE');assert.equal((await f.apply(revision,'drifted')).status,'partial');
  assert.equal((await f.rack.choices()).length,1);await rm(application);
  assert.equal((await f.apply(revision,'missing-app')).status,'partial');assert.deepEqual(f.touched,[]);
});

test('retained environment revisions resolve their exact connection definition',async t=>{
  const f=await fixture(t),first=await f.imported('remote',{url:'https://first.invalid/mcp'}),r1=await f.publish([first]);await f.apply(r1);
  const preview=await f.preview({remote:{url:'https://second.invalid/mcp'}});
  const second=await f.rack.execute({kind:'capability.revise',operationId:'second',id:first.id,expectedBase:first.revisionId,entry:preview.entries[0]!}) as ConnectionRevision;
  const r2=await f.publish([second],'r2',r1.revisionId);await f.apply(r2);
  await assert.rejects(f.rack.acquireAccess(f.request(r1,'stale')),{code:'STALE_REVISION'});
  const retained=await f.rack.acquireAccess(f.request(r1,'resume',false)),fresh=await f.rack.acquireAccess(f.request(r2,'fresh'));
  assert('url' in retained.servers[0]!&&'url' in fresh.servers[0]!);
  assert.equal(retained.servers[0].url,'https://first.invalid/mcp');assert.equal(fresh.servers[0].url,'https://second.invalid/mcp');
});

test('explicit external resource ownership survives restart and releases only its own reservation',async t=>{
  const f=await fixture(t),capability=await f.imported('instrument',{url:'https://instrument.invalid/mcp'});
  const revision=await f.rack.execute({kind:'environment.publish',operationId:'exclusive-r1',expectedBase:null,document:{format:2,environmentId:'external',name:'External',description:'',components:[{id:'instrument',name:'Instrument',definition:{capabilityId:capability.id,revisionId:capability.revisionId},resource:{identity:'instrument-one',exclusive:true}}]}}) as Revision;
  await f.apply(revision);await f.rack.acquireAccess(f.request(revision,'one'));await f.restart();
  assert.equal((await f.rack.acquireAccess(f.request(revision,'two'))).components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:'unrelated',owner:'main'});
  assert.equal((await f.rack.acquireAccess(f.request(revision,'two'))).components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:'one',owner:'main'});
  assert.equal((await f.rack.acquireAccess(f.request(revision,'two'))).servers.length,1);
  assert.equal((await f.rack.inventory()).bindings.length,0);
});

test('failed revalidation retains issued ownership until explicit settled release',async t=>{
  const f=await fixture(t),capability=await f.imported('secured',{url:'https://secured.invalid/mcp',headers:{Authorization:'Bearer ${TOKEN}'}});
  const revision=await f.rack.execute({kind:'environment.publish',operationId:'secured-r1',expectedBase:null,document:{format:2,environmentId:'external',name:'External',description:'',components:[{id:'secured',name:'Secured',definition:{capabilityId:capability.id,revisionId:capability.revisionId},resource:{identity:'secured-resource',exclusive:true}}]}}) as Revision;
  await f.apply(revision);await f.rack.acquireAccess(f.request(revision,'original'));
  const credentials=await readFile(f.credentials);await writeFile(f.credentials,JSON.stringify({format:1,credentials:{}}));
  assert.equal((await f.rack.acquireAccess(f.request(revision,'original'))).components[0]?.code,'CONNECTION_UNAVAILABLE');
  await writeFile(f.credentials,credentials);
  assert.equal((await f.rack.acquireAccess(f.request(revision,'replacement'))).components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:'original',owner:'main'});
  assert.equal((await f.rack.acquireAccess(f.request(revision,'replacement'))).servers.length,1);
  await assert.rejects(f.rack.acquireAccess(f.request(revision,'original')),{code:'ACCESS_RELEASED'});
});


test('partial preparation and credential drift preserve healthy neighbors with explicit component outcomes',async t=>{
  const f=await fixture(t),secured=await f.imported('secured-neighbor',{url:'https://secured.invalid/mcp',headers:{Authorization:'Bearer ${TOKEN}'}}),healthy=await f.imported('healthy-neighbor',{url:'https://healthy.invalid/mcp'}),revision=await f.publish([secured,healthy]);
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{}}));
  const prepared=await f.apply(revision);assert.equal(prepared.status,'partial');assert.equal((await f.rack.choices()).length,1);
  assert.equal(prepared.components[0]?.errorCode,'CREDENTIAL_MISSING');assert.equal(prepared.components[1]?.error,null);
  const partial=await f.rack.acquireAccess(f.request(revision,'partial'));
  assert.deepEqual(partial.servers.map(server=>server.name),['component-1']);
  assert.deepEqual(partial.components,[{componentId:'component-0',serverName:'component-0',status:'unavailable',code:'PREPARATION_UNAVAILABLE'},{componentId:'component-1',serverName:'component-1',status:'ready',code:null}]);
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'researcher',authority:'fixture',value:'synthetic-recovery-secret'}}}));
  await f.apply(revision,'repaired-credentials');assert.equal((await f.rack.acquireAccess(f.request(revision,'partial'))).servers.length,2);
  await writeFile(f.credentials,JSON.stringify({format:1,credentials:{}}));
  const drift=await f.rack.acquireAccess(f.request(revision,'partial'));assert.equal(drift.servers.length,1);assert.equal(drift.components[0]?.code,'CONNECTION_UNAVAILABLE');
  assert(!JSON.stringify(drift).includes('synthetic-recovery-secret'));assert.equal((await f.rack.choices()).length,1);
  await f.rack.releaseAccess({id:'partial',owner:'main'});assert.deepEqual(f.touched,[]);
});

test('normalized aggregate name collisions remain fatal even if one component is unavailable',async t=>{
  const f=await fixture(t),capability=await f.imported('collision',{url:'https://example.invalid/mcp'}),id='component.with.dots',collision=`c_${createHash('sha256').update(id).digest('hex').slice(0,30)}`;
  const revision=await f.rack.execute({kind:'environment.publish',operationId:'collision-r1',expectedBase:null,document:{format:2,environmentId:'external',name:'External',description:'',components:[id,collision].map(id=>({id,name:id,definition:{capabilityId:capability.id,revisionId:capability.revisionId}}))}}) as Revision;
  await f.apply(revision);await assert.rejects(f.rack.acquireAccess(f.request(revision)),{code:'SERVER_NAME'});assert.equal((await f.rack.inventory()).bindings.length,0);
});

test('an exclusive busy component does not suppress an unrelated healthy component',async t=>{
  const f=await fixture(t),busy=await f.imported('busy',{url:'https://busy.invalid/mcp'}),healthy=await f.imported('healthy',{url:'https://healthy.invalid/mcp'});
  const revision=await f.rack.execute({kind:'environment.publish',operationId:'busy-r1',expectedBase:null,document:{format:2,environmentId:'external',name:'External',description:'',components:[{id:'busy',name:'Busy',definition:{capabilityId:busy.id,revisionId:busy.revisionId},resource:{identity:'application',exclusive:true}},{id:'healthy',name:'Healthy',definition:{capabilityId:healthy.id,revisionId:healthy.revisionId}}]}}) as Revision;
  await f.apply(revision);assert.equal((await f.rack.acquireAccess(f.request(revision,'owner'))).servers.length,2);
  const neighbor=await f.rack.acquireAccess(f.request(revision,'neighbor'));assert.deepEqual(neighbor.servers.map(server=>server.name),['healthy']);assert.equal(neighbor.components[0]?.code,'RESOURCE_BUSY');
  await f.rack.releaseAccess({id:'owner',owner:'main'});assert.equal((await f.rack.acquireAccess(f.request(revision,'neighbor'))).servers.length,2);
});
