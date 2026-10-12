import {stat,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {RackFault,type RackConfig} from './contracts.ts';

export type RuntimeCommand=(executable:string,args:string[],timeout:number,maxBytes:number)=>Promise<Buffer>;
type RuntimeIO={now:()=>number;home:()=>string;socket:(path:string)=>Promise<boolean>;directory:(path:string)=>Promise<void>};
const host:RuntimeIO={now:Date.now,home:homedir,socket:async path=>(await stat(path)).isSocket(),directory:async path=>{await mkdir(path,{recursive:true,mode:0o700});}};
const Profile=z.object({name:z.string(),status:z.enum(['Running','Stopped','Broken','Starting']),runtime:z.string()});
const Engine=z.object({ServerVersion:z.string().min(1),OSType:z.literal('linux'),SecurityOptions:z.array(z.string()),MemoryLimit:z.boolean(),CpuCfsQuota:z.boolean(),PidsLimit:z.boolean()});

/** Readiness owns only the explicitly configured engine. Administrative preparation
 * may start an existing dedicated Colima profile; access checks never start one.
 * Concurrent preparation shares its bounded work. Settled success is not cached,
 * so a later operation observes a stopped engine instead of trusting stale health.
 * Runtime shutdown and software/profile installation remain external operations. */
export class ContainerRuntime{
 private preparing:Promise<void>|null=null;
 private checking:Promise<void>|null=null;
 private config:RackConfig;private run:RuntimeCommand;private io:RuntimeIO;
 constructor(config:RackConfig,run:RuntimeCommand,io:RuntimeIO=host){this.config=config;this.run=run;this.io=io;}
 ready(options:{start?:boolean}={}):Promise<void>{
  if(this.preparing)return this.preparing;
  if(!options.start&&this.checking)return this.checking;
  const preparation=Boolean(options.start),previous=this.checking,deadline=this.io.now()+this.config.runtimeStartupTimeoutMs;
  const task=(async()=>{if(preparation&&previous)await previous.catch(()=>{});await this.ensure(preparation,deadline);})();
  if(preparation)this.preparing=task;else this.checking=task;
  void task.finally(()=>{if(this.preparing===task)this.preparing=null;if(this.checking===task)this.checking=null;}).catch(()=>{});
  return task;
 }
 private async ensure(start:boolean,deadline:number){
  const config=this.config;
  const call=async(executable:string,args:string[])=>{
   const remaining=deadline-this.io.now();
   if(remaining<=0)throw new RackFault('RUNTIME_TIMEOUT','Container runtime readiness exceeded its configured deadline');
   try{return await this.run(executable,args,remaining,config.maxBodyBytes);}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new RackFault('RUNTIME_SOFTWARE_MISSING',`${executable} is not installed or is unavailable on the daemon PATH; provision it before preparing managed capabilities`);throw error;}
  };
  if(config.runtime.kind==='colima'){
   const profile=config.runtime.profile,expected=join(this.io.home(),'.colima',profile,'docker.sock');
   if(!config.dockerConfig||!config.dockerSocket||resolve(config.dockerSocket)!==expected)throw new RackFault('RUNTIME_CONFIGURATION',`Owned Colima profile ${profile} requires a private dockerConfig and its exact socket ${expected}`);
   let profiles:z.infer<typeof Profile>[];
   try{profiles=(await call('colima',['list','--json'])).toString().split('\n').filter(line=>line.trim()).map(line=>Profile.parse(JSON.parse(line)));}
   catch(error){if(error instanceof RackFault)throw error;throw new RackFault('RUNTIME_PROFILE_STATUS','Colima did not return a valid profile inventory');}
   const selected=profiles.find(value=>value.name===profile);
   if(!selected)throw new RackFault('RUNTIME_PROFILE_MISSING',`Dedicated Colima profile ${profile} has not been provisioned; Polariton will not create a profile`);
   if(selected.runtime!=='docker')throw new RackFault('RUNTIME_PROFILE_CONFLICT',`Colima profile ${profile} uses ${selected.runtime}; Polariton requires its provisioned Docker runtime and will not change it`);
   if(selected.status==='Starting')throw new RackFault('RUNTIME_STARTING',`Colima profile ${profile} is already starting; inspect the configured profile before retrying preparation`);
   if(selected.status!=='Running'){
    if(!start)throw new RackFault('RUNTIME_STOPPED',`Colima profile ${profile} is ${selected.status.toLowerCase()}; install a release or apply its environment to prepare the configured runtime`);
    // Preserve the user's active context and the provisioned profile settings.
    try{await call('colima',['start','--profile',profile,'--activate=false','--save-config=false']);}
    catch(error){
     if(error instanceof RackFault&&['COMMAND_TIMEOUT','OUTPUT_LIMIT'].includes(error.code))throw new RackFault('RUNTIME_START_UNCERTAIN',`Colima profile ${profile} startup may continue after ${error.code}; inspect the configured profile before retrying. No fallback or automatic repeat was attempted`);
     throw error;
    }
   }
  }
  const docker=(args:string[])=>call('docker',[...(config.dockerConfig?['--config',config.dockerConfig]:[]),'--context',config.dockerContext,...args]);
  if(config.dockerSocket){
   if(!config.dockerConfig)throw new RackFault('RUNTIME_CONFIGURATION','Socket provisioning requires an explicit private Docker config');
   const endpoint=`unix://${config.dockerSocket}`;
   let available=false;try{available=await this.io.socket(config.dockerSocket);}catch{}
   if(!available)throw new RackFault('DOCKER_SOCKET_UNAVAILABLE',`Configured Docker socket is unavailable: ${config.dockerSocket}; inspect the configured runtime`);
   await this.io.directory(config.dockerConfig);
   // The built-in default is used only for metadata, never for an engine request.
   const metadata=(args:string[])=>call('docker',['--config',config.dockerConfig!,'--context','default','context',...args]);
   const names=(await metadata(['ls','--format','{{json .Name}}'])).toString().trim().split('\n').filter(Boolean).map(value=>z.string().parse(JSON.parse(value)));
   const inspect=async()=>z.string().parse(JSON.parse((await metadata(['inspect',config.dockerContext,'--format','{{json .Endpoints.docker.Host}}'])).toString()));
   if(!names.includes(config.dockerContext)){
    try{await metadata(['create',config.dockerContext,'--docker',`host=${endpoint}`]);}
    catch(error){let actual:string|undefined;try{actual=await inspect();}catch{}if(actual!==endpoint)throw error;}
   }
   if(await inspect()!==endpoint)throw new RackFault('DOCKER_CONTEXT_CONFLICT',`Docker context ${config.dockerContext} does not match the configured socket; existing context was not changed`);
  }
  let engine:z.infer<typeof Engine>;
  try{engine=Engine.parse(JSON.parse((await docker(['info','--format','{{json .}}'])).toString()));}
  catch(error){if(error instanceof SyntaxError||error instanceof z.ZodError)throw new RackFault('ENGINE_CAPABILITIES','Docker did not report the required Linux resource-control capabilities');throw error;}
  if(engine.SecurityOptions.some(option=>option==='rootless'||option.startsWith('name=rootless')))throw new RackFault('ENGINE_UNQUALIFIED','Rootless Docker is not in this release profile; select an explicitly provisioned qualified engine. Polariton will not switch engines.');
  if(!engine.MemoryLimit||!engine.CpuCfsQuota||!engine.PidsLimit)throw new RackFault('ENGINE_LIMITS','Selected Docker engine cannot enforce the required memory, CPU and process limits');
 }
}
