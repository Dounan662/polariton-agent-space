import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {RackConfig,Manifest,type Mount,type Release,type ConnectionRevision,type Revision} from '../src/environment/contracts.ts';
import type {ContainerState} from '../src/environment/backend.ts';

async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adversarial-'))),credentials=join(root,'credentials.json');
  await writeFile(credentials,JSON.stringify({format:1,credentials:{TOKEN:{account:'owner',authority:'test',value:'private-value'}}}),{mode:0o600});
  const config=RackConfig.parse({stateRoot:join(root,'state'),socketPath:join(root,'rack.sock'),credentialFile:credentials,maxIdentityBytes:268435456,monitorMs:3600000});
  const states=new Map<string,ContainerState>();let endpoint='';
  const host:RackBackend={async ready(){},async owned(){return [...states.values()];},async inspect(id){return states.get(id)??null;},async remove(id){states.delete(id);},async publishAuthority(){},async install(source,commit){return {source,commit,artifactDigest:'test',imageId:'test',image:`node@sha256:${'1'.repeat(64)}`,locks:{'lock.json':'test'},manifest:Manifest.parse({format:1,name:'test',description:'',image:`node@sha256:${'1'.repeat(64)}`,build:[],entrypoint:['node','server.mjs'],lockfiles:['lock.json'],configSchema:{type:'object'},mcpPath:'/mcp',port:8080,state:'scratch'})};},async start(mount:Mount,release:Release){const state={id:mount.id,running:true,exitCode:0,oom:false,endpoint,labels:{'polariton.mount':mount.id,'polariton.generation':mount.generation,'polariton.release':release.id}};states.set(mount.id,state);return state;}};
  const rack=await new EnvironmentRack(config,()=>host).open();
  t.after(async()=>{await rack.close();await rm(root,{recursive:true,force:true});});
  const preview=(mcpServers:Record<string,unknown>)=>rack.preview({configuration:{mcpServers}});
  const external=async()=>{const p=await preview({external:{url:'https://fixture.invalid/mcp'}});return ((await rack.execute({kind:'capability.import',operationId:'import-external',entries:p.entries})) as {capabilities:ConnectionRevision[]}).capabilities[0]!;};
  const managed=async(resource?:{identity:string;exclusive:boolean})=>{
    const server=createServer((_request,response)=>response.end('{}'));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert(address&&typeof address!=='string');endpoint=`http://127.0.0.1:${address.port}/mcp`;
    const repo=join(root,'repo');await mkdir(repo);execFileSync('git',['init','--quiet',repo]);await rack.execute({kind:'capability.register',operationId:'managed',id:'managed',repository:repo});await rack.execute({kind:'release.install',operationId:'release',packageId:'managed',commit:'1'.repeat(40)});
    const revision=await rack.execute({kind:'environment.publish',operationId:'managed-revision',expectedBase:null,document:{format:2,environmentId:'managed-env',name:'Managed',description:'',components:[{id:'component',name:'Managed',releaseId:'release',configuration:{},...(resource?{resource}:{})}]}}) as Revision;
    await rack.execute({kind:'environment.apply',operationId:'apply-managed',environmentId:revision.environmentId,revisionId:revision.revisionId});return (await rack.inventory()).mounts[0]!;
  };
  return {root,config,rack,preview,external,managed};
}

test('sensitive literal mixed with a credential reference is rejected without persistence',async t=>{
  const f=await fixture(t),sentinel='must-not-be-recorded';
  const preview=await f.preview({leak:{url:'https://fixture.invalid/mcp',headers:{Authorization:`Bearer ${sentinel}-`+'${TOKEN}'}}});
  assert.equal(preview.entries.length,0);assert.equal(preview.errors.length,1);assert(!JSON.stringify(preview).includes(sentinel));
});

test('foreground launch validation rejects daemon flags and credentials embedded in argument URLs',async t=>{
  const f=await fixture(t),command=await realpath(process.execPath),entry=join(f.root,'server.mjs'),sentinel='private-argument-value';
  await writeFile(entry,'process.exit(0);');
  const preview=await f.preview({daemon:{command,args:[entry,'--daemon']},detached:{command,args:[entry,'--detach=true']},url:{command,args:[entry,`--endpoint=https://user:${sentinel}@example.invalid/mcp`]}});
  assert.equal(preview.entries.length,0);assert.deepEqual(preview.errors.map(value=>value.code),['LAUNCH_DAEMON','LAUNCH_DAEMON','ENDPOINT_INVALID']);
  assert(!JSON.stringify(preview).includes(sentinel));assert.equal((await f.rack.inventory()).capabilities.length,0);
});

test('preview reports an oversized display name per entry while preserving valid neighbors',async t=>{
  const f=await fixture(t),preview=await f.preview({['x'.repeat(257)]:{url:'https://example.invalid/mcp'},valid:{url:'https://example.invalid/mcp'}});
  assert.equal(preview.entries.length,1);assert.equal(preview.entries[0]!.name,'valid');assert.equal(preview.errors[0]!.code,'CAPABILITY_NAME');
  assert.equal((await f.rack.inventory()).capabilities.length,0);
});

test('normalized import cannot omit a declared dependency from executable identity',async t=>{
  const f=await fixture(t),script=join(f.root,'server.mjs'),dependency=join(f.root,'dependency.mjs');await writeFile(script,'// controlled entry');await writeFile(dependency,'// dependency');
  const preview=await f.preview({local:{command:await realpath(process.execPath),args:[script],requirements:{identityFiles:[dependency]}}});assert.deepEqual(preview.errors,[]);
  const entry=preview.entries[0]!;assert.equal(entry.definition.kind,'stdio');if(entry.definition.kind!=='stdio')throw new Error();
  entry.definition.identity.files=entry.definition.identity.files.filter(file=>file.path!==dependency);
  await assert.rejects(f.rack.execute({kind:'capability.import',operationId:'tampered',entries:[entry]}));
  assert.equal((await f.rack.inventory()).capabilities.length,0);
});

test('aggregate acquisition and release never reuse or revoke an unrelated administrative grant identity',async t=>{
  const f=await fixture(t),mount=await f.managed(),accessId='new-access';
  const collision=`a-${createHash('sha256').update(`${accessId}:component`).digest('hex').slice(0,48)}`;
  await f.rack.execute({kind:'binding.create',operationId:collision,mountId:mount.id,principal:'unrelated-owner',access:'call'});
  const grant=await f.rack.acquireAccess({id:accessId,owner:'main',principal:'worker',workspace:f.root,environment:{environmentId:'managed-env',revisionId:'managed-revision',name:'Managed'},requireHead:true});assert.equal(grant.servers.length,1);
  await f.rack.releaseAccess({id:accessId,owner:'main'});
  assert.equal((await f.rack.inventory()).bindings.find(binding=>binding.id===collision)?.released,false);
});

test('external access respects exclusive resource ownership already held by a managed controller',async t=>{
  const f=await fixture(t);await f.managed({identity:'instrument',exclusive:true});const capability=await f.external();
  await f.rack.execute({kind:'environment.publish',operationId:'external-revision',expectedBase:null,document:{format:2,environmentId:'external-env',name:'External',description:'',components:[{id:'external',name:'External',definition:{capabilityId:capability.id,revisionId:capability.revisionId},resource:{identity:'instrument',exclusive:true}}]}});
  await f.rack.execute({kind:'environment.apply',operationId:'external-apply',environmentId:'external-env',revisionId:'external-revision'});
  assert.equal((await f.rack.acquireAccess({id:'external-worker',owner:'main',principal:'external-worker',workspace:f.root,environment:{environmentId:'external-env',revisionId:'external-revision',name:'External'},requireHead:true})).components[0]?.code,'RESOURCE_BUSY');
});


test('FIFO credentials and entrypoints reject promptly while a neighboring preview succeeds',async t=>{
  const f=await fixture(t),pipe=join(f.root,'invalid-fifo');execFileSync('mkfifo',[pipe]);
  // An isolated caller gives the contract a hard deadline even if a regression blocks
  // an OS open forever; it cannot leave the test runner's filesystem pool occupied.
  const config=RackConfig.parse({...f.config,credentialFile:pipe,operationTimeoutMs:5000});
  const script=`import {Connections} from './src/environment/connections.ts';import {RackConfig} from './src/environment/contracts.ts';
    const config=RackConfig.parse(JSON.parse(process.argv[1])),service=new Connections(config);
    const results=await Promise.all([
      service.preview({configuration:{mcpServers:{credential:{url:'https://fixture.invalid/mcp',headers:{Authorization:'Bearer \${TOKEN}'}}}}}),
      service.preview({configuration:{mcpServers:{entry:{command:process.execPath,args:[config.credentialFile]}}}}),
      service.preview({configuration:{mcpServers:{neighbor:{url:'https://fixture.invalid/mcp'}}}})
    ]);console.log(JSON.stringify(results));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{cwd:fileURLToPath(new URL('../',import.meta.url)),timeout:config.operationTimeoutMs});
  const results=JSON.parse(stdout) as Array<{entries:unknown[];errors:Array<{code:string}>}>;
  assert.equal(results[0]!.errors[0]!.code,'CREDENTIAL_SOURCE');assert.equal(results[1]!.errors[0]!.code,'IDENTITY_LIMIT');
  assert.equal(results[2]!.entries.length,1);assert.deepEqual(results[2]!.errors,[]);
});
