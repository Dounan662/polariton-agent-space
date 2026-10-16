import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OciRuntime,type OciBackend} from '../src/environment/oci.ts';
import {RackStore} from '../src/environment/storage.ts';
import {RackConfig,type ConnectionRevision} from '../src/environment/contracts.ts';
import type {ContainerState} from '../src/environment/backend.ts';
import {CapabilitySpec} from '../src/environment/preparation-contracts.ts';
import {fileIdentity} from '../src/environment/toolchains.ts';

const image=`example.com/tool@sha256:${'a'.repeat(64)}`;
const definition:ConnectionRevision&{kind:'stdio'}={id:'image',name:'Clock',kind:'stdio',command:'/usr/local/bin/docker',args:[],env:{},container:{image},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'},revisionId:'v1',baseRevisionId:null,operationId:'install',createdAt:'2026-10-13T00:00:00Z'};
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'polariton-oci-'));await writeFile(join(root,'docker'),'fixture',{mode:0o755});const config=RackConfig.parse({stateRoot:root,socketPath:join(root,'owner.sock'),preparedContainerCapacity:1,executablePaths:[root]}),store=await RackStore.open(root,config.maxRecords);
 const containers=new Map<string,ContainerState>(),effects:string[][]=[];
 let sequence=0;
 const backend:OciBackend={ready:async()=>{},inspect:async id=>containers.get(id)??null,remove:async id=>{effects.push(['remove',id]);containers.delete(id);},docker:async args=>{
  effects.push(args);if(args[0]==='image')return Buffer.from(JSON.stringify([{Id:`sha256:${'b'.repeat(64)}`,Os:'linux',Architecture:process.arch==='arm64'?'arm64':'amd64'}]));
  if(args[0]==='create'){assert(args.includes('--read-only'));assert(args.includes('none'));assert(args.includes('--pids-limit'));if(args.includes('max-file=1'))assert(args.includes('compress=false'),'Docker rejects compression for a one-file local log budget');const id=`container-${++sequence}`;containers.set(id,{id,running:false,exitCode:0,oom:false,endpoint:null,labels:{}});return Buffer.from(id);}
  if(args[0]==='start')containers.get(args[1]!)!.running=true;return Buffer.from('');
 }};
 const observed={...definition,command:join(root,'docker'),identity:{platform:process.platform,arch:process.arch,files:[await fileIdentity(join(root,'docker'),config.maxIdentityBytes)]}};
 const runtime=new OciRuntime(config,'fixture-owner',store,backend);t.after(async()=>{await runtime.close();store.close();await rm(root,{recursive:true,force:true});});return {runtime,effects,containers,definition:observed};
}
test('OCI access only claims explicitly prepared capacity and preserves idempotent access identity',async t=>{
 const {runtime,effects,definition}=await fixture(t);
 await assert.rejects(runtime.claim(definition,'first','tool','tool'),{code:'OCI_CAPACITY_UNAVAILABLE'});assert.deepEqual(effects,[]);
 await runtime.prepare(definition);const launches=effects.filter(e=>['create','start','pull'].includes(e[0]!)).length;
 const first=await runtime.claim(definition,'first','tool','tool');assert('command'in first);assert(first.args.includes('attach'));assert.equal(first.protocol,'legacy','A retained container stdin must not receive speculative reconnect probes');
 assert.deepEqual(await runtime.claim(definition,'first','tool','tool'),first);
 await assert.rejects(runtime.claim(definition,'second','tool','tool'),{code:'OCI_CAPACITY_UNAVAILABLE'});
 assert.equal(effects.filter(e=>['create','start','pull'].includes(e[0]!)).length,launches);
 await runtime.release('first');await runtime.release('first');assert.equal(await runtime.available(definition,'second','tool'),false);
 await runtime.prepare(definition);assert.equal(await runtime.available(definition,'second','tool'),true);
});
test('shutdown settles prepared and claimed containers',async t=>{
 const {runtime,containers,definition}=await fixture(t);await runtime.prepare(definition);await runtime.claim(definition,'first','tool','tool');await runtime.close();assert.equal(containers.size,0);
});
test('prepared capacity cannot launch through a drifted attach executable',async t=>{
 const {runtime,definition,effects}=await fixture(t);await runtime.prepare(definition);const count=effects.length;await writeFile(definition.command,'changed Docker executable');
 await assert.rejects(runtime.claim(definition,'first','tool','tool'),{code:'EXECUTABLE_DRIFT'});assert.equal(effects.length,count);assert.equal(await runtime.available(definition,'first','tool'),true);
});
test('OCI source assessment rejects unsupported storage and literal credentials before effects',async t=>{
 const {runtime,effects}=await fixture(t),spec=CapabilitySpec.parse({id:'clock',name:'Clock',source:{kind:'oci',image},runtime:{kind:'container'},connection:{kind:'stdio'},requirements:{},authentication:{kind:'none'}});
 const accepted=await runtime.source(spec);assert.equal(accepted.source.kind,'oci');assert.deepEqual(effects,[]);
 await assert.rejects(runtime.source({...spec,requirements:{...spec.requirements,storage:{scope:'capability',access:'exclusive',retention:'retain'}}}),{code:'OCI_REQUIREMENT'});
 await assert.rejects(runtime.source({...spec,connection:{kind:'stdio',args:[],env:{AUTHORIZATION:'Bearer literal-secret'}}}),{code:'CREDENTIAL_LITERAL'});
 await assert.rejects(runtime.source({...spec,connection:{kind:'stdio',args:['--token=literal-secret'],env:{}}}),{code:'LAUNCH_ARGUMENT'});assert.deepEqual(effects,[]);
});
