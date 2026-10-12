import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {Manifest,RackConfig,type AccessRequest,type Mount,type Release,type Component} from '../src/environment/contracts.ts';
import type {ContainerState} from '../src/environment/backend.ts';

type Authority={generation:string;bindings:Array<{id:string;principal:string;access:string;hash:string}>};

/** Fake the container host at its public boundary. The rack still owns real
 * durable records, administrative operations, grants and restart recovery.
 */
class Host implements RackBackend {
  states=new Map<string,ContainerState>();authority=new Map<string,Authority>();removed:string[]=[];
  fail:((mount:Mount,authority:Authority)=>boolean)|null=null;
  beforePublish:((mount:Mount,authority:Authority)=>Promise<void>)|null=null;
  endpoint:string;counter=0;
  constructor(endpoint:string){this.endpoint=endpoint;}
  async ready(){}
  async owned(){return [...this.states.values()];}
  async remove(id:string){this.removed.push(id);this.states.delete(id);}
  async inspect(id:string){return this.states.get(id)??null;}
  async install(source:{repository:string;subdirectory:string},commit:string,_releaseId:string){return {
    source,commit,artifactDigest:'fixture-artifact',imageId:'fixture-image',image:`node@sha256:${'1'.repeat(64)}`,
    manifest:Manifest.parse({format:1,name:'Contract fixture',description:'',image:`node@sha256:${'1'.repeat(64)}`,build:[],entrypoint:['node','server.mjs'],lockfiles:['lock.json'],configSchema:{type:'object'},mcpPath:'/mcp',port:8080,state:'scratch'}),locks:{'lock.json':'fixture-lock'},
  };}
  async publishAuthority(mount:Mount,_release:Release,value:unknown,_configuration:unknown){
    const authority=value as Authority;
    await this.beforePublish?.(mount,authority);
    if(this.fail?.(mount,authority))throw new Error('Controlled authority publication failure');
    this.authority.set(mount.id,structuredClone(authority));
  }
  async start(mount:Mount,release:Release){
    const value={id:`container-${++this.counter}`,running:true,exitCode:0,oom:false,endpoint:this.endpoint,labels:{'polariton.mount':mount.id,'polariton.generation':mount.generation,'polariton.release':release.id}};
    this.states.set(value.id,value);return value;
  }
}

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'polariton-access-'));
  const server=createServer((_req,res)=>{res.writeHead(200);res.end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const host=new Host(`http://127.0.0.1:${address.port}/mcp`);
  const config=RackConfig.parse({stateRoot:join(directory,'state'),socketPath:join(directory,'rack.sock'),monitorMs:3600000});
  let rack=await new EnvironmentRack(config,()=>host).open();
  t.after(async()=>{host.fail=null;await rack.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});});
  const repository=join(directory,'source');await mkdir(repository);execFileSync('git',['init','--quiet',repository]);
  await rack.execute({kind:'capability.register',operationId:'register',id:'fixture',repository});
  await rack.execute({kind:'release.install',operationId:'release-r1',packageId:'fixture',commit:'1'.repeat(40)});
  const component=(id:string,revision=1):Component=>({id,name:id,releaseId:'release-r1',configuration:{revision}});
  const publish=async(revision:number)=>{
    const revisionId=`revision-${revision}`;
    await rack.execute({kind:'environment.publish',operationId:revisionId,expectedBase:revision===1?null:`revision-${revision-1}`,document:{format:2,environmentId:'environment',name:'Fixture',description:'',components:[component('measure',revision),component('transform',revision)]}});
    await rack.execute({kind:'environment.apply',operationId:`apply-${revision}`,environmentId:'environment',revisionId});
  };
  await publish(1);
  const request=(id:string,overrides:Partial<AccessRequest>={}):AccessRequest=>({id,owner:'main-owner',principal:id,workspace:directory,environment:{environmentId:'environment',revisionId:'revision-1',name:'Fixture'},requireHead:true,...overrides});
  const active=()=>[...host.authority.values()].flatMap(value=>value.bindings).filter(binding=>binding.access==='call');
  return {get rack(){return rack;},host,request,publish,active,
    restart:async()=>{await rack.close();rack=await new EnvironmentRack(config,()=>host).open();},
  };
}

test('one access identity converges; releasing one shared worker preserves the other and all mounts',async t=>{
  const f=await fixture(t),input=f.request('worker-one');
  const [first,retry]=await Promise.all([f.rack.acquireAccess(input),f.rack.acquireAccess(input)]);
  assert.deepEqual(first,retry);assert.deepEqual(first.servers.map(server=>server.name),['measure','transform']);
  const second=await f.rack.acquireAccess(f.request('worker-two'));assert.equal(f.active().length,4);
  const before=(await f.rack.inventory()).mounts;
  await Promise.all([f.rack.releaseAccess({id:input.id,owner:input.owner}),f.rack.releaseAccess({id:input.id,owner:input.owner})]);
  assert.equal(f.active().length,2);assert(f.active().every(binding=>binding.principal==='worker-two'));
  assert.deepEqual((await f.rack.inventory()).mounts,before);assert.equal(f.host.removed.length,0);
  assert.deepEqual(await f.rack.acquireAccess(f.request('worker-two')),second);
  await assert.rejects(f.rack.acquireAccess(input),{code:'ACCESS_RELEASED'});
});

test('a failed managed grant is rolled back while healthy grants remain available',async t=>{
  const f=await fixture(t);
  f.host.fail=(mount,authority)=>mount.component.id==='transform'&&authority.bindings.some(binding=>binding.principal==='worker-one');
  const grant=await f.rack.acquireAccess(f.request('worker-one'));
  assert.deepEqual(grant.servers.map(server=>server.name),['measure']);
  assert.deepEqual(grant.components,[{componentId:'measure',serverName:'measure',status:'ready',code:null},{componentId:'transform',serverName:'transform',status:'unavailable',code:'GRANT_UNAVAILABLE'}]);
  assert.equal(f.active().length,1);assert.equal((await f.rack.inventory()).bindings.filter(binding=>binding.released).length,1);
  f.host.fail=null;assert.equal((await f.rack.acquireAccess(f.request('worker-one'))).servers.length,2);
  f.host.fail=null;assert.equal((await f.rack.acquireAccess(f.request('worker-two'))).servers.length,2);
  assert.equal(f.host.removed.length,0);
});

test('release drains in-flight acquisition before sealing the identity against late retries',async t=>{
  const f=await fixture(t);let enter!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{finish=resolve;});
  f.host.beforePublish=async(mount,authority)=>{if(mount.component.id==='measure'&&authority.bindings.some(binding=>binding.principal==='delayed')){enter();await gate;}};
  const acquired=f.rack.acquireAccess(f.request('delayed'));await entered;
  let settled=false;const released=f.rack.releaseAccess({id:'delayed',owner:'main-owner'}).then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
  finish();await Promise.all([acquired,released]);
  assert.equal(f.active().length,0);assert.equal(f.host.removed.length,0);
  await assert.rejects(f.rack.acquireAccess(f.request('delayed')),{code:'ACCESS_RELEASED'});
});

test('failed cleanup remains retryable and never returns a partial connection set',async t=>{
  const f=await fixture(t);let failedAcquisition=false;
  f.host.fail=(mount,authority)=>{
    if(mount.component.id==='transform'&&authority.bindings.some(binding=>binding.principal==='worker-one')){failedAcquisition=true;return true;}
    return failedAcquisition&&mount.component.id==='transform'&&authority.bindings.length===0;
  };
  await assert.rejects(f.rack.acquireAccess(f.request('worker-one')),{code:'ACCESS_CLEANUP_PENDING'});
  assert.equal((await f.rack.inventory()).bindings.filter(binding=>binding.principal==='worker-one').length,2,'Both acquired and uncertain grants remain journaled');
  await assert.rejects(f.rack.acquireAccess(f.request('worker-one')),{code:'ACCESS_RELEASED'});
  f.host.fail=null;await f.rack.releaseAccess({id:'worker-one',owner:'main-owner'});
  assert.equal(f.active().length,0);assert.equal((await f.rack.acquireAccess(f.request('worker-two'))).servers.length,2);
});

test('startup finishes a persisted failed cleanup before any fresh grant is issued',async t=>{
  const f=await fixture(t);await f.rack.acquireAccess(f.request('worker-one'));
  f.host.fail=(_mount,authority)=>authority.bindings.length===0;
  await assert.rejects(f.rack.releaseAccess({id:'worker-one',owner:'main-owner'}),{code:'ACCESS_CLEANUP_PENDING'});
  assert.equal(f.active().length,2);
  f.host.fail=null;await f.restart();assert.equal(f.active().length,0);
  await assert.rejects(f.rack.acquireAccess(f.request('worker-one')),{code:'ACCESS_RELEASED'});
  assert.equal((await f.rack.acquireAccess(f.request('worker-two'))).servers.length,2);
});

test('release-before-acquire tombstone and ownership survive same-version restart',async t=>{
  const f=await fixture(t);await f.rack.releaseAccess({id:'cancelled',owner:'main-owner'});
  await f.restart();await assert.rejects(f.rack.acquireAccess(f.request('cancelled')),{code:'ACCESS_RELEASED'});
  await assert.rejects(f.rack.releaseAccess({id:'cancelled',owner:'different-owner'}),{code:'ACCESS_OWNER'});
  const grant=await f.rack.acquireAccess(f.request('fresh'));assert.equal(grant.servers.length,2);
  await f.restart();assert.deepEqual(await f.rack.acquireAccess(f.request('fresh')),grant);
});

test('published head validation does not prevent retained-revision reconstruction',async t=>{
  const f=await fixture(t);await f.publish(2);
  await assert.rejects(f.rack.acquireAccess(f.request('stale')),{code:'STALE_REVISION'});
  const retained=await f.rack.acquireAccess(f.request('resumed',{requireHead:false}));assert.equal(retained.servers.length,2);
  const fresh=await f.rack.acquireAccess(f.request('new-head',{environment:{environmentId:'environment',revisionId:'revision-2',name:'Fixture'}}));
  assert.equal(fresh.servers.length,2);assert('headers' in retained.servers[0]);assert('headers' in fresh.servers[0]);assert.notEqual(retained.servers[0].headers[0].value,fresh.servers[0].headers[0].value);
});

test('revoked access requires a new identity; public inventory excludes grant credentials and hashes',async t=>{
  const f=await fixture(t),input=f.request('worker-one'),grant=await f.rack.acquireAccess(input);
  const inventory=await f.rack.inventory(),encoded=JSON.stringify(inventory);
  for(const server of grant.servers){assert('headers' in server);for(const header of server.headers)assert(!encoded.includes(header.value));}
  assert(!encoded.includes('"hash"'));assert(!encoded.includes('"headers"'));assert(!encoded.includes('Bearer '));
  const binding=inventory.bindings.find(binding=>binding.principal==='worker-one')!;
  await f.rack.execute({kind:'binding.release',operationId:'revoke',id:binding.id});
  const degraded=await f.rack.acquireAccess(input);assert.equal(degraded.servers.length,1);assert.equal(degraded.components.find(component=>component.status==='unavailable')?.code,'GRANT_UNAVAILABLE');
  await f.rack.releaseAccess({id:input.id,owner:input.owner});assert.equal(f.active().length,0);
  assert.equal((await f.rack.acquireAccess(f.request('worker-two'))).servers.length,2);
});
