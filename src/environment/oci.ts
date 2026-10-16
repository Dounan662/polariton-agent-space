import {z} from 'zod';
import {access,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ContainerBackend,type ContainerState} from './backend.ts';
import {RecordSchemas,RackFault,type RackConfig,type ConnectionRevision,type ConnectionDefinition,type AccessGrant} from './contracts.ts';
import {type CapabilitySpec,type SourceSpec} from './preparation-contracts.ts';
import {RackStore,digest,json} from './storage.ts';
import {fileIdentity,toolDirectories} from './toolchains.ts';
import {Connections} from './connections.ts';

const Slot=z.object({id:z.string(),pool:z.string(),name:z.string(),containerId:z.string().nullable(),state:z.enum(['preparing','prepared','claimed','released','cleanup-pending']),accessId:z.string().nullable(),componentId:z.string().nullable(),error:z.string().nullable()}).strict();
type Slot=z.infer<typeof Slot>;
RecordSchemas['oci-slot']=Slot;
type Definition=ConnectionRevision&{kind:'stdio'};
export type OciBackend=Pick<ContainerBackend,'docker'|'ready'|'inspect'|'remove'>;

/** Generic images run as isolated, prepared instances. A worker only claims capacity;
 * neither claim nor reconnect pulls an image or starts a container. DSH owns attach,
 * Environment owns the actual container and removes it after access settlement. */
export class OciRuntime {
 private config:RackConfig;private owner:string;private store:RackStore;private backend:OciBackend;
 private pending=new Map<string,Promise<unknown>>();
 constructor(config:RackConfig,owner:string,store:RackStore,backend:OciBackend=new ContainerBackend(config,owner)){this.config=config;this.owner=owner;this.store=store;this.backend=backend;}
 private async locked<T>(key:string,work:()=>Promise<T>):Promise<T>{const before=this.pending.get(key)??Promise.resolve(),task=before.catch(()=>{}).then(work);this.pending.set(key,task);try{return await task;}finally{if(this.pending.get(key)===task)this.pending.delete(key);}}
 private pool(definition:Definition){return digest(json({image:definition.container!.image,args:definition.args,env:definition.env}));}
 private flags(){return [...this.config.dockerConfig?['--config',this.config.dockerConfig]:[],'--context',this.config.dockerContext];}
 async source(spec:CapabilitySpec):Promise<{definition:ConnectionDefinition,source:SourceSpec,defaults:string[]}>{
  if(spec.source.kind!=='oci'||spec.runtime.kind!=='container'||spec.connection.kind!=='stdio')throw new RackFault('SOURCE_RUNTIME','OCI currently requires a container runtime and stdio connection');
  if(spec.authentication.kind!=='none'||spec.requirements.files.length||spec.requirements.identityFiles.length||spec.requirements.assets.length||spec.requirements.storage||[...spec.connection.args,...Object.values(spec.connection.env)].some(v=>v.includes('${')))throw new RackFault('OCI_REQUIREMENT','Generic OCI instances support isolated temporary storage and nonsecret environment values; host mounts and credentials require an explicit qualified recipe');
  let executable:string|undefined;
  for(const directory of await toolDirectories(this.config)){try{const path=await realpath(join(directory,'docker'));await access(path,constants.X_OK);executable=path;break;}catch{}}
  if(!executable)throw new RackFault('OCI_TOOL_MISSING','Install the Docker CLI in a standard executable location');
  const input=spec.source.image;if(!/^[a-zA-Z0-9][a-zA-Z0-9./:_@-]+$/.test(input))throw new RackFault('OCI_IMAGE','Supply a registry image and exact tag or digest');
  let image=input;
  if(!/@sha256:[a-f0-9]{64}$/.test(input)){
   let raw:unknown;try{raw=JSON.parse((await this.backend.docker(['manifest','inspect','--verbose',input],this.config.maxObservationBytes)).toString());}catch{throw new RackFault('OCI_RESOLUTION','Image metadata could not be resolved; use an exact accessible image digest');}
   const Descriptor=z.object({digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),platform:z.object({os:z.string(),architecture:z.string()}).passthrough().optional()}).passthrough();
   const entries=z.array(z.object({Descriptor}).passthrough()).parse(Array.isArray(raw)?raw:[raw]);
   const architecture=process.arch==='arm64'?'arm64':'amd64',selected=entries.find(v=>v.Descriptor.platform?.os==='linux'&&v.Descriptor.platform.architecture===architecture)??(entries.length===1?entries[0]:undefined);
   if(!selected)throw new RackFault('OCI_PLATFORM',`Image does not declare linux/${architecture}`);
   image=`${input.replace(/:[^/:]+$/,'')}@${selected.Descriptor.digest}`;
  }
  const identity=await fileIdentity(executable,this.config.maxIdentityBytes);
  const definition:ConnectionDefinition={kind:'stdio',command:executable,args:spec.connection.args,env:spec.connection.env,credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'},identity:{platform:process.platform,arch:process.arch,files:[identity]},container:{image}};
  new Connections(this.config).validate(definition);
  return {definition,source:{kind:'oci',image},defaults:['OCI: isolated prepared instance per access; no network, host mounts, or shared persistent state']};
 }
 async prepare(definition:Definition,signal?:AbortSignal){
  return this.locked(this.pool(definition),async()=>{
   signal?.throwIfAborted();await this.backend.ready({start:true});
   const pool=this.pool(definition);
   // Deterministic container names let restart reconcile an acknowledged create whose
   // reply was lost. An unfinished instance is removed before another is admitted.
   for(const slot of this.store.list<Slot>('oci-slot').filter(s=>s.pool===pool&&['preparing','cleanup-pending'].includes(s.state)))await this.remove(slot);
   const usable:Slot[]=[];
   for(const slot of this.store.list<Slot>('oci-slot').filter(s=>s.pool===pool&&s.state==='prepared')){const state=await this.backend.inspect(slot.containerId??slot.name);if(state?.running)usable.push(slot);else await this.remove(slot);}
   if(usable.length>=this.config.preparedContainerCapacity)return;
   await this.backend.docker(['pull',definition.container!.image],this.config.buildLimits.outputBytes);
   const image=z.array(z.object({Id:z.string().regex(/^sha256:[a-f0-9]{64}$/),Os:z.literal('linux'),Architecture:z.enum(['arm64','amd64'])}).passthrough()).parse(JSON.parse((await this.backend.docker(['image','inspect',definition.container!.image])).toString()))[0]!;
   if(image.Architecture!==(process.arch==='arm64'?'arm64':'amd64'))throw new RackFault('OCI_PLATFORM','Image platform differs from the qualified runtime');
   const limits=this.config.limits;
   while(usable.length<this.config.preparedContainerCapacity){
    signal?.throwIfAborted();
    if(this.store.list<Slot>('oci-slot').filter(s=>s.state!=='released').length>=this.config.maxMounts)throw new RackFault('OCI_CAPACITY','Prepared container capacity is full');
    const id=randomUUID(),slot:Slot={id,pool,name:`polariton-oci-${this.owner}-${id}`,containerId:null,state:'preparing',accessId:null,componentId:null,error:null};this.store.put('oci-slot',id,slot);
    try{
     const args=['create','--name',slot.name,'--label',`polariton.oci-owner=${this.owner}`,'--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',`${limits.memoryMb}m`,'--memory-swap',`${limits.memoryMb}m`,'--cpus',String(limits.cpus),'--pids-limit',String(limits.pids),'--tmpfs',`/tmp:rw,nosuid,size=${limits.scratchMb}m`,'--log-driver','local','--log-opt',`max-size=${limits.outputBytes}`,'--log-opt','max-file=1','--log-opt','compress=false','--interactive',...Object.entries(definition.env).flatMap(([name,value])=>['--env',`${name}=${value}`]),image.Id,...definition.args];
     slot.containerId=(await this.backend.docker(args)).toString().trim();this.store.put('oci-slot',id,slot);
     await this.backend.docker(['start',slot.containerId]);const observed=await this.backend.inspect(slot.containerId);if(!observed?.running)throw new RackFault('OCI_STARTUP','Prepared container exited before assignment');
     slot.state='prepared';this.store.put('oci-slot',id,slot);usable.push(slot);
    }catch(error){try{await this.remove(slot);}catch{throw new RackFault('OCI_CLEANUP_PENDING','Container preparation failed and removal remains pending');}throw error instanceof RackFault?error:new RackFault('OCI_PREPARATION','Container preparation failed');}
   }
  });
 }
 async available(definition:Definition,accessId:string,componentId:string){return this.store.list<Slot>('oci-slot').some(s=>s.pool===this.pool(definition)&&(s.state==='prepared'||s.state==='claimed'&&s.accessId===accessId&&s.componentId===componentId));}
 async claim(definition:Definition,accessId:string,componentId:string,name:string):Promise<AccessGrant['servers'][number]>{
  return this.locked(this.pool(definition),async()=>{
   // A prepared container does not authorize a changed local attach executable.
   await new Connections(this.config).resolve(definition,name);
   const slots=this.store.list<Slot>('oci-slot').filter(s=>s.pool===this.pool(definition));
   const slot=slots.find(s=>s.state==='claimed'&&s.accessId===accessId&&s.componentId===componentId)??slots.find(s=>s.state==='prepared');
   if(!slot)throw new RackFault('OCI_CAPACITY_UNAVAILABLE','Explicitly prepare another instance before assigning this environment');
   const state=await this.backend.inspect(slot.containerId!);if(!state?.running)throw new RackFault('OCI_UNAVAILABLE','Prepared container is no longer running; prepare the environment explicitly');
   slot.state='claimed';slot.accessId=accessId;slot.componentId=componentId;this.store.put('oci-slot',slot.id,slot);
   // The SDK's speculative auto probe cannot recreate this already prepared stdin
   // session. Its supported legacy handshake works directly on the retained stream.
   return {name,command:definition.command,args:[...this.flags(),'attach','--sig-proxy=false',slot.containerId!],env:[],protocol:'legacy'};
  });
 }
 private async remove(slot:Slot){
  slot.state='cleanup-pending';this.store.put('oci-slot',slot.id,slot);
  try{await this.backend.remove(slot.containerId??slot.name);slot.state='released';slot.error=null;this.store.put('oci-slot',slot.id,slot);}
  catch{slot.error='Container removal has not settled';this.store.put('oci-slot',slot.id,slot);throw new RackFault('OCI_CLEANUP_PENDING',slot.error);}
 }
 async release(accessId:string){for(const slot of this.store.list<Slot>('oci-slot').filter(s=>s.accessId===accessId&&s.state!=='released'))await this.locked(slot.pool,()=>this.remove(slot));}
 async close(){await Promise.allSettled(this.pending.values());for(const slot of this.store.list<Slot>('oci-slot').filter(s=>s.state!=='released'))await this.remove(slot);}
}
