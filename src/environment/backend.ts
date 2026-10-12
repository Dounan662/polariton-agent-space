import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, chmod, readdir, open, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as tar from 'tar';
import { z } from 'zod';
import { Manifest, CapabilitySource, RackFault, type RackConfig, type Limits, type Release, type Mount } from './contracts.ts';
import { digest, durable } from './storage.ts';
import {ContainerRuntime} from './runtime.ts';

/** A bounded external command. No shell interpolation or inherited application secrets. */
export async function command(executable:string,args:string[],timeout:number,maxBytes:number,cwd?:string,input?:string):Promise<Buffer>{
  return new Promise((resolveResult,reject)=>{
    const child=spawn(executable,args,{cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:process.env.DOCKER_CONFIG},stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined){child.stdin!.on('error',()=>{});child.stdin!.end(input);}
    let size=0,settled=false;const chunks:Buffer[]=[],errors:Buffer[]=[];
    const finish=(error?:Error,value?:Buffer)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveResult(value!);};
    // The CLI may leave a VM/helper owning inherited pipes. End our observation
    // at the deadline without pretending we own or have stopped those descendants.
    const stop=(error:Error)=>{
      if(settled)return;
      child.kill('SIGKILL');child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();finish(error);
    };
    const timer=setTimeout(()=>stop(new RackFault('COMMAND_TIMEOUT',`${executable} exceeded its deadline`)),timeout);
    child.stdout!.on('data',(chunk:Buffer)=>{if(settled)return;size+=chunk.length;if(size>maxBytes)stop(new RackFault('OUTPUT_LIMIT',`${executable} output exceeded its budget`));else chunks.push(chunk);});
    child.stderr!.on('data',(chunk:Buffer)=>{if(settled)return;size+=chunk.length;if(size>maxBytes)stop(new RackFault('OUTPUT_LIMIT',`${executable} output exceeded its budget`));else errors.push(chunk);});
    child.on('error',error=>finish(error));
    child.on('close',code=>{if(code!==0)finish(new RackFault('COMMAND_FAILED',`${executable} failed (${code}): ${Buffer.concat([...errors,...chunks]).toString('utf8')}`));else finish(undefined,Buffer.concat(chunks));});
  });
}
export interface ContainerState {id:string;running:boolean;exitCode:number;oom:boolean;endpoint:string|null;labels:Record<string,string>}
/** Container identity and cgroups contain entire process trees. The host never executes package scripts. */
export class ContainerBackend {
  private config:RackConfig;private owner:string;private runtime:ContainerRuntime;
  constructor(config:RackConfig,owner:string){this.config=config;this.owner=owner;this.runtime=new ContainerRuntime(config,command);}
  async docker(args:string[],budget=this.config.maxBodyBytes,timeout=this.config.operationTimeoutMs,input?:string){return command('docker',[...(this.config.dockerConfig?['--config',this.config.dockerConfig]:[]),'--context',this.config.dockerContext,...args],timeout,budget,undefined,input);}
  /** Administrative preparation may start the owned runtime; ordinary access is check-only. */
  ready(options:{start?:boolean}={}){return this.runtime.ready(options);}
  private isolation(limits:Limits){return ['--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',`${limits.memoryMb}m`,'--memory-swap',`${limits.memoryMb}m`,'--cpus',String(limits.cpus),'--pids-limit',String(limits.pids),'--tmpfs',`/tmp:rw,noexec,nosuid,size=${limits.scratchMb}m,uid=1000,gid=1000`,'--log-driver','local','--log-opt',`max-size=${limits.outputBytes}`,'--log-opt','max-file=1','--log-opt','compress=false'];}
  async inspect(id:string):Promise<ContainerState|null>{
    try{const [value]=JSON.parse((await this.docker(['inspect',id])).toString()) as Array<{Id:string;State:{Running:boolean;ExitCode:number;OOMKilled:boolean};Config:{Labels:Record<string,string>};NetworkSettings:{Ports:Record<string,Array<{HostIp:string;HostPort:string}>|null>}}>;
      const port=value.NetworkSettings.Ports['8080/tcp']?.[0];return {id:value.Id,running:value.State.Running,exitCode:value.State.ExitCode,oom:value.State.OOMKilled,labels:value.Config.Labels,endpoint:port?`http://127.0.0.1:${port.HostPort}/mcp`:null};
    }catch(error){if(error instanceof Error&&/No such (object|container)/i.test(error.message))return null;throw error;}
  }
  async owned(){const ids=(await this.docker(['ps','-aq','--filter',`label=polariton.owner=${this.owner}`])).toString().trim().split(/\s+/).filter(Boolean);return (await Promise.all(ids.map(id=>this.inspect(id)))).filter((value):value is ContainerState=>value!==null);}
  async remove(id:string){try{await this.docker(['rm','--force',id],this.config.maxBodyBytes,this.config.shutdownTimeoutMs);}catch(error){if(!(error instanceof Error&&/No such (object|container)/i.test(error.message)))throw error;}}
  private authorityVolume(mount:Mount){return `polariton-auth-${this.owner}-${mount.id}`;}
  /** Publish on the engine filesystem: host-shared filesystem caches cannot tear the authority handoff. */
  async publishAuthority(mount:Mount,release:Release,value:unknown,configuration:unknown){
    const volume=this.authorityVolume(mount);
    await this.docker(['volume','create','--label',`polariton.owner=${this.owner}`,volume]);
    const script="const fs=require('node:fs');let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>{const data=JSON.parse(text);for(const [name,value]of Object.entries(data)){const path='/authority/'+name+'.json',temp=path+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o644});const fd=fs.openSync(temp,'r');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(temp,path);}const fd=fs.openSync('/authority','r');fs.fsyncSync(fd);fs.closeSync(fd);});";
    const helper=`polariton-auth-write-${this.owner}-${randomUUID()}`;
    try{await this.docker(['run','--rm','--name',helper,...this.isolation(this.config.limits),'--user','0:0','--label',`polariton.owner=${this.owner}`,'--label','polariton.auxiliary=true','--mount',`type=volume,src=${volume},dst=/authority`,'--entrypoint','node','-i',release.imageId,'-e',script],this.config.maxBodyBytes,this.config.startupTimeoutMs,JSON.stringify({auth:value,config:configuration}));}
    finally{await this.remove(helper);}
  }
  async start(mount:Mount,release:Release):Promise<ContainerState>{
    const args=['create','--name',`polariton-${this.owner}-${mount.generation}`,...this.isolation(this.config.limits),
      '--label',`polariton.owner=${this.owner}`,'--label',`polariton.mount=${mount.id}`,'--label',`polariton.generation=${mount.generation}`,'--label',`polariton.release=${release.id}`,
      '--publish','127.0.0.1::8080','--tmpfs',`/state:rw,nosuid,size=${this.config.limits.scratchMb}m,uid=1000,gid=1000`,
      '--mount',`type=bind,src=${join(this.config.stateRoot,'releases',release.id,'artifact')},dst=/app,readonly`,
      '--mount',`type=volume,src=${this.authorityVolume(mount)},dst=/run/polariton,readonly`,
      '--env','PORT=8080','--env','POLARITON_AUTH_FILE=/run/polariton/auth.json','--env','POLARITON_CONFIG_FILE=/run/polariton/config.json',
      '--env',`POLARITON_MAX_BODY_BYTES=${this.config.maxBodyBytes}`,'--env',`POLARITON_MAX_BINDINGS=${this.config.maxBindings}`,
      '--workdir','/app',release.imageId,...release.manifest.entrypoint];
    const id=(await this.docker(args)).toString().trim();
    try{await this.docker(['start',id]);const state=await this.inspect(id);if(!state)throw new Error('Container disappeared during startup');return state;}catch(error){await this.remove(id);throw error;}
  }
  /** Build only the selected committed directory; surrounding workspace files never enter the container. */
  async install(rawSource:CapabilitySource,commit:string,releaseId:string):Promise<Omit<Release,'id'|'packageId'|'createdAt'>>{
    const identity=CapabilitySource.parse(rawSource),repository=identity.repository;
    if(await realpath(repository)!==repository)throw new RackFault('SOURCE_IDENTITY','Repository path no longer identifies the registered directory');
    const root=(await command('git',['--no-replace-objects','-C',repository,'rev-parse','--show-toplevel'],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim();
    if(await realpath(root)!==repository)throw new RackFault('SOURCE_IDENTITY','Registered source is no longer a Git repository root');
    const staging=join(this.config.stateRoot,'staging',releaseId),source=join(staging,'source'),artifact=join(staging,'artifact');
    await mkdir(source,{recursive:true});await mkdir(artifact,{recursive:true});
    const deadline=Date.now()+this.config.operationTimeoutMs;
    let container:string|undefined;
    try{
      const resolved=(await command('git',['--no-replace-objects','-C',repository,'rev-parse','--verify',`${commit}^{commit}`],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim();
      if(resolved!==commit)throw new RackFault('SOURCE_IDENTITY','Source commit did not resolve exactly');
      const tree=(await command('git',['--no-replace-objects','-C',repository,'rev-parse','--verify',`${commit}:${identity.subdirectory}`],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim();
      const listing=await command('git',['--no-replace-objects','-C',repository,'ls-tree','-r','-t','-l','-z',tree],this.config.operationTimeoutMs,this.config.maxSourceBytes);
      const files=new Map<string,{oid:string;size:number}>();let count=0,total=0;
      // git archive omits gitlinks; enumerate first so submodules and symlinks cannot
      // disappear silently. Validate the whole selected tree, never its siblings.
      for(const record of listing.toString('utf8').split('\0').filter(Boolean)){
        const match=/^(\d+) (blob|tree|commit) ([a-f0-9]{40}) +(-|\d+)\t([\s\S]+)$/.exec(record);
        if(!match)throw new RackFault('SOURCE_TREE','Source tree metadata is invalid');
        const [,mode,type,oid,size,path]=match;
        if(!['040000','100644','100755'].includes(mode!)||!['blob','tree'].includes(type!)||path!.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')||path!.includes('\\'))throw new RackFault('SOURCE_TREE','Source contains a symlink, submodule, or unsupported path');
        count++;if(type==='blob'){const bytes=Number(size);total+=bytes;files.set(path!,{oid:oid!,size:bytes});}
        if(count>this.config.maxArchiveEntries||total>this.config.maxSourceBytes)throw new RackFault('SOURCE_LIMIT','Committed package exceeds configured source bounds');
      }
      // Root archives retain Git's commit metadata. A subtree is a bare tree to
      // Git, so pin its archive timestamps explicitly rather than using wall time.
      const timestamp=identity.subdirectory?(await command('git',['--no-replace-objects','-C',repository,'show','--no-patch','--no-show-signature','--format=%ct',commit],this.config.operationTimeoutMs,this.config.maxBodyBytes)).toString().trim():null;
      if(timestamp!==null&&!/^-?\d+$/.test(timestamp))throw new RackFault('SOURCE_IDENTITY','Commit timestamp is invalid');
      const archive=await command('git',['--no-replace-objects','-C',repository,'archive','--format=tar',...(timestamp===null?[]:[`--mtime=@${timestamp}`]),identity.subdirectory?tree:commit],this.config.operationTimeoutMs,this.config.maxSourceBytes);
      await this.extract(archive,source,staging,'source.tar',this.config.maxSourceBytes);
      // Attributes may omit or substitute archive members. Refuse such transformations:
      // every committed regular file must reach the build with its exact Git blob bytes.
      for(const [path,expected] of files){
        let bytes:Buffer;try{bytes=await readFile(join(source,path));}catch{throw new RackFault('SOURCE_ARCHIVE','Source archive omitted a committed file; remove export-ignore attributes from the package');}
        if(bytes.length!==expected.size||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==expected.oid)throw new RackFault('SOURCE_ARCHIVE','Source archive changed committed file contents');
      }
      const manifest=Manifest.parse(JSON.parse(await readFile(join(source,'polariton-capability.json'),'utf8')));
      if(manifest.build.length>this.config.maxBuildCommands)throw new RackFault('BUILD_LIMIT','Build command count exceeds configured budget');
      const locks:Record<string,string>={};
      for(const file of manifest.lockfiles){const path=resolve(source,file);if(isAbsolute(file)||relative(source,path).startsWith('..'))throw new RackFault('MANIFEST_PATH','Lockfile must belong to the source snapshot');locks[file]=digest(await readFile(path));}
      await this.docker(['pull',manifest.image],this.config.buildLimits.outputBytes);
      const imageId=JSON.parse((await this.docker(['image','inspect',manifest.image,'--format','{{json .Id}}'])).toString()) as string;
      container=(await this.docker(['create','--name',`polariton-build-${this.owner}-${releaseId}`,...this.isolation(this.config.buildLimits),
        '--label',`polariton.owner=${this.owner}`,'--label','polariton.build=true','--mount',`type=bind,src=${source},dst=/source,readonly`,
        '--tmpfs',`/build:rw,exec,nosuid,size=${this.config.buildLimits.scratchMb}m,uid=1000,gid=1000`,
        '--env','HOME=/tmp','--workdir','/build',imageId,'sleep','infinity'])).toString().trim();
      await this.docker(['start',container]);
      await this.docker(['exec',container,'cp','-R','/source/.','/build/'],this.config.buildLimits.outputBytes);
      const builds:Array<{argv:string[];output:string}>=[];
      for(const argv of manifest.build){const remaining=deadline-Date.now();if(remaining<=0)throw new RackFault('BUILD_TIMEOUT','Installation exceeded its deadline');const output=await this.docker(['exec','--workdir','/build',container,...argv],this.config.buildLimits.outputBytes,remaining);builds.push({argv,output:output.toString('utf8')});}
      const built=await this.docker(['exec',container,'tar','-C','/build','-chf','-','.'],this.config.maxArtifactBytes);
      await this.extract(built,artifact,staging,'artifact.tar',this.config.maxArtifactBytes);
      const syncTree=async(path:string):Promise<void>=>{for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isDirectory())await syncTree(child);else{const file=await open(child,'r');try{await file.sync();}finally{await file.close();}}}const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}};
      await syncTree(artifact);
      const artifactDigest=digest(built);
      const target=join(this.config.stateRoot,'releases',releaseId);await mkdir(target,{recursive:true});
      const {rename}=await import('node:fs/promises');await rename(artifact,join(target,'artifact'));
      await writeFile(join(target,'artifact.tar'),built,{mode:0o400});const archiveFile=await open(join(target,'artifact.tar'),'r');try{await archiveFile.sync();}finally{await archiveFile.close();}
      await writeFile(join(target,'source.tar'),archive,{mode:0o400});
      const sourceFile=await open(join(target,'source.tar'),'r');try{await sourceFile.sync();}finally{await sourceFile.close();}
      // npm's installed lock is the resolved dependency closure, independently retained
      // from a build's potentially modified source lockfile.
      let dependencies:unknown=null;try{dependencies=JSON.parse(await readFile(join(target,'artifact','node_modules','.package-lock.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const provenance={source:identity,sourceDigest:digest(archive),artifactDigest,imageId,image:manifest.image,commit,manifest,locks,builds,dependencies};
      await durable(join(target,'provenance.json'),provenance);
      return {source:identity,commit,artifactDigest,imageId,image:manifest.image,manifest,locks};
    }finally{if(container)await this.remove(container);await rm(staging,{recursive:true,force:true});}
  }
  private async extract(bytes:Buffer,directory:string,staging:string,name:string,maxBytes:number){
    if(bytes.length>maxBytes)throw new RackFault('ARCHIVE_LIMIT','Archive exceeds its configured byte bound');
    const path=join(staging,name);await writeFile(path,bytes);let entries=0,total=0;let invalid:string|undefined;
    const seen=new Set<string>();
    await tar.t({file:path,strict:true,onReadEntry:entry=>{
      entries++;total+=entry.size;const target=resolve(directory,entry.path),key=relative(directory,target);
      if(entries>this.config.maxArchiveEntries||total>maxBytes||isAbsolute(entry.path)||entry.path.includes('\\')||entry.path.split('/').includes('..')||key==='..'||key.startsWith('../')||seen.has(key)||!['File','Directory'].includes(entry.type))invalid=entry.path;
      seen.add(key);
    }});
    if(invalid!==undefined)throw new RackFault('ARCHIVE_INVALID',`Archive contains unsupported or unsafe entry: ${invalid}`);
    await tar.x({file:path,cwd:directory,strict:true,noChmod:true,noMtime:true,preserveOwner:false});
  }
}
