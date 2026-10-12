import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readdir, realpath, rm, stat, lstat, readlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { durable, json } from './storage.ts';
import { RackFault, type RackConfig, type ConnectionRevision, type StdioDefinition, type PackageInstallation } from './contracts.ts';

type Recipe=NonNullable<z.infer<typeof StdioDefinition>['package']>;
const fail=(code:string,message:string)=>new RackFault(code,message,400);
const npmSpecifier=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9*^~.+_-]+)?$/;
const uvSpecifier=/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:==[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/;
const executable=/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Recognize a deliberately small, non-shell subset of the common package launch syntax.
 * The original launch remains in the definition; preparation replaces it only at acquisition. */
export function packageLaunch(command:string,args:string[]):{recipe:Recipe,args:string[]}|undefined{
  const runner=basename(command).replace(/\.exe$/i,'');
  if(runner==='npx'||runner==='npx-cli.js'){
    const remaining=[...args];if(remaining[0]==='-y'||remaining[0]==='--yes')remaining.shift();
    const specifier=remaining.shift();
    if(!specifier||!npmSpecifier.test(specifier))throw fail('PACKAGE_SPECIFIER','Use npx [-y] registry-package[@version] followed by server arguments; runner flags, URLs and local packages are unsupported');
    const name=specifier.replace(/@[^/]*$/,'')||specifier;
    return {recipe:{manager:'npm',specifier,executable:basename(name)},args:remaining};
  }
  if(runner==='uvx'){
    const remaining=[...args],from=remaining[0]==='--from';if(from)remaining.shift();
    const requested=remaining.shift(),specifier=requested?.replace(/@latest$/,'').replace(/@(?=[A-Za-z0-9])/,'=='),entry=from?remaining.shift():specifier?.split('==')[0];
    if(!specifier||!uvSpecifier.test(specifier)||!entry||!executable.test(entry))throw fail('PACKAGE_SPECIFIER','Use uvx package[@version|@latest|==version], or uvx --from package[==version] executable, followed by server arguments');
    return {recipe:{manager:'uv',specifier,executable:entry},args:remaining};
  }
}
const File=z.object({path:z.string(),sha256:z.string(),mode:z.number()}).strict();
const Identity=z.object({path:z.string(),realpath:z.string(),sha256:z.string()}).strict();
const Receipt=z.object({format:z.literal(1),definition:z.string(),platform:z.string(),arch:z.string(),command:z.string(),args:z.array(z.string()),tree:z.string(),tools:z.array(Identity),resolved:z.array(z.object({name:z.string(),version:z.string()}).strict())}).strict();
type Receipt=z.infer<typeof Receipt>;
export type PackageCommand={command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal};
export type PackageExecutor=(command:PackageCommand)=>Promise<string>;

/** Owns durable package installations, their bounded preparation and their retained identity.
 * Only prepare may execute tools or use the network. resolve checks an existing sealed receipt
 * and never repairs missing or changed bytes. Each revision has one permanent installation path. */
export class Packages {
  private config:RackConfig;
  private executor:PackageExecutor;
  private pending=new Map<string,Promise<void>>();
  private active=0;
  constructor(config:RackConfig,executor?:PackageExecutor){this.config=config;this.executor=executor??(request=>this.execute(request));}
  private location(revision:ConnectionRevision){return join(this.config.stateRoot,'packages',revision.id,revision.revisionId);}
  private fingerprint(revision:ConnectionRevision){return createHash('sha256').update(json(revision)).digest('hex');}
  private async tool(name:'npm'|'node'|'uv'|'python'){
    const specified=this.config.packageTools[name],candidates=specified?[specified]:this.config.executablePaths.flatMap(path=>(name==='python'?['python3','python']:[name]).map(value=>join(path,value)));
    for(const candidate of candidates){try{if(!isAbsolute(candidate))continue;const canonical=await realpath(candidate);await access(canonical,constants.X_OK);if((await stat(canonical)).isFile())return canonical;}catch{}}
    throw fail('PACKAGE_TOOL_MISSING',`Package preparation requires an installed ${name} tool in packageTools or executablePaths`);
  }
  private async fileIdentity(path:string){
    const canonical=await realpath(path),file=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const before=await file.stat();if(!before.isFile()||before.size>this.config.maxPackageBytes)throw fail('PACKAGE_IDENTITY','Package tool identity is not a bounded regular file');
      const hash=createHash('sha256');let size=0;for await(const chunk of file.createReadStream({autoClose:false})){size+=chunk.length;if(size>this.config.maxPackageBytes)throw fail('PACKAGE_LIMIT','Package identity exceeds the configured byte limit');hash.update(chunk);}
      const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw fail('PACKAGE_DRIFT','A package tool changed during inspection');return {path,realpath:canonical,sha256:hash.digest('hex')};
    }finally{await file.close();}
  }
  private async tree(root:string,external:string[],seal=false):Promise<string>{
    const files:z.infer<typeof File>[]=[{path:'/',sha256:'',mode:seal?0o555:(await lstat(root)).mode&0o777}],canonicalRoot=await realpath(root);let bytes=0,entries=0;
    const walk=async(directory:string)=>{
      for(const entry of (await readdir(directory)).sort()){
        const path=join(directory,entry),info=await lstat(path);if(++entries>this.config.maxPackageEntries)throw fail('PACKAGE_LIMIT','Package installation exceeds the configured entry limit');
        const local=relative(root,path);
        if(info.isSymbolicLink()){
          const target=await realpath(path);if(target!==canonicalRoot&&!target.startsWith(canonicalRoot+sep)&&!external.includes(target))throw fail('PACKAGE_LINK','Package installation contains an unsupported external symbolic link');
          files.push({path:local,sha256:createHash('sha256').update(await readlink(path)).digest('hex'),mode:info.mode&0o777});
        }else if(info.isDirectory()){await walk(path);if(seal){await chmod(path,0o555);await this.sync(path,true);}files.push({path:local+'/',sha256:'',mode:seal?0o555:info.mode&0o777});}
        else if(info.isFile()){
          bytes+=info.size;if(bytes>this.config.maxPackageBytes)throw fail('PACKAGE_LIMIT','Package installation exceeds the configured byte limit');
          const identity=await this.fileIdentity(path),mode=info.mode&0o111?0o555:0o444;if(seal){await chmod(path,mode);await this.sync(path,false);}
          files.push({path:local,sha256:identity.sha256,mode:seal?mode:info.mode&0o777});
        }else throw fail('PACKAGE_FILE','Package installation contains an unsupported special file');
      }
    };
    await walk(root);if(seal){await chmod(root,0o555);await this.sync(root,true);}
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  }
  /** Concurrent requests for one revision share the same result. Other work is capacity bounded. */
  async prepare(revision:ConnectionRevision):Promise<void>{
    if(revision.kind!=='stdio'||!revision.package)return;
    const key=this.location(revision),existing=this.pending.get(key);if(existing)return existing;
    const work=this.prepareOne(revision);this.pending.set(key,work);
    try{await work;}finally{this.pending.delete(key);}
  }
  private async prepareOne(revision:ConnectionRevision&{kind:'stdio'}){
    const directory=this.location(revision);
    try{await stat(directory);await this.resolve(revision);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.active>=this.config.maxPackageConcurrent)throw fail('PACKAGE_BUSY','Package preparation capacity is occupied; retry Apply after it completes');
    this.active++;
    try{
      const launch=packageLaunch(revision.command,revision.args);if(!launch||json(launch.recipe)!==json(revision.package))throw fail('PACKAGE_DEFINITION','Package recipe does not match its recorded launcher');
      const names=launch.recipe.manager==='npm'?['npm','node'] as const:['uv','python'] as const;
      const paths=await Promise.all(names.map(name=>this.tool(name))),tools=await Promise.all(paths.map(path=>this.fileIdentity(path)));
      await mkdir(dirname(directory),{recursive:true,mode:0o700});
      try{await mkdir(directory,{mode:0o700});}catch{throw fail('PACKAGE_INCOMPLETE','Package revision already has an incomplete preparation; create a new definition revision');}
      const install=join(directory,'installation'),scratch=join(directory,'preparation');await mkdir(install,{mode:0o700});await mkdir(scratch,{mode:0o700});
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.config.packageTimeoutMs);
      const env:NodeJS.ProcessEnv={PATH:[...new Set(paths.map(dirname)),...this.config.executablePaths].join(':'),HOME:scratch,TMPDIR:scratch,LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1',UV_NO_CONFIG:'1',UV_NO_CACHE:'1',UV_PYTHON_DOWNLOADS:'never',NPM_CONFIG_USERCONFIG:join(scratch,'npmrc'),NPM_CONFIG_GLOBALCONFIG:join(scratch,'global-npmrc'),NPM_CONFIG_CACHE:join(scratch,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false',NPM_CONFIG_LOGS_MAX:'0',NPM_CONFIG_LOGLEVEL:'error'};
      let monitoring:Promise<void>|undefined,monitorFailure:unknown;
      const monitor=setInterval(()=>{if(monitoring)return;monitoring=this.budget(directory).catch(error=>{monitorFailure=error;controller.abort();}).finally(()=>{monitoring=undefined;});},this.config.monitorMs);
      const run=async(command:string,args:string[])=>{if(controller.signal.aborted)throw monitorFailure??fail('PACKAGE_TIMEOUT','Package preparation exceeded its configured deadline');const output=await this.executor({command,args,cwd:install,env,signal:controller.signal});await this.budget(directory);return output;};
      let command:string,args:string[],resolved:Receipt['resolved']=[];
      try{
        if(launch.recipe.manager==='npm'){
          const [npm,node]=paths as [string,string];
          await writeFile(join(install,'package.json'),JSON.stringify({name:'polariton-prepared-capability',private:true,version:'1.0.0'}));
          await run(node,[npm,'install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund','--save-exact','--registry',this.config.packageRegistry,'--',launch.recipe.specifier]);
          const lock=JSON.parse(await this.boundedText(join(install,'package-lock.json')));
          if(!lock.packages||typeof lock.packages!=='object')throw fail('PACKAGE_LOCK','Package manager did not produce a supported dependency lock');
          for(const [key,value] of Object.entries(lock.packages) as [string,{version?:string,resolved?:string,link?:boolean}][]){
            if(!key)continue;
            if(value.link||!value.version||!value.resolved||!this.registryDownload(value.resolved)||!/^\d[^\s]*$/.test(value.version))throw fail('PACKAGE_DEPENDENCY','Only registry dependencies with locked versions are supported');
            resolved.push({name:key,version:value.version});
          }
          await run(node,[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry',this.config.packageRegistry]);
          const packageName=launch.recipe.specifier.replace(/@[^/]*$/,'')||launch.recipe.specifier;
          const packageDirectory=join(install,'node_modules',packageName),metadata=JSON.parse(await this.boundedText(join(packageDirectory,'package.json')));
          const bins=typeof metadata.bin==='string'?{[launch.recipe.executable]:metadata.bin}:metadata.bin;
          if(!bins||typeof bins!=='object')throw fail('PACKAGE_ENTRYPOINT','Installed package does not declare an executable');
          const values=[...new Set(Object.values(bins))],entry=bins[launch.recipe.executable]??(values.length===1?values[0]:undefined);
          if(typeof entry!=='string')throw fail('PACKAGE_ENTRYPOINT','Package has ambiguous executables; use a package with one default executable');
          const path=await realpath(resolve(packageDirectory,entry));if(!path.startsWith(await realpath(packageDirectory)+sep))throw fail('PACKAGE_ENTRYPOINT','Package executable escapes its installation');
          const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let first:string;
          try{const bytes=Buffer.alloc(this.config.maxObservationBytes),read=await file.read(bytes,0,bytes.length,0);first=bytes.subarray(0,read.bytesRead).toString('utf8').split('\n',1)[0]!;}finally{await file.close();}
          if(!/^#!.*\bnode(?:\s|$)/.test(first))throw fail('PACKAGE_ENTRYPOINT','npm packages must expose a Node.js executable; shell and native launchers are unsupported');
          command=node;args=[path,...launch.args];
        }else{
          const [uv,python]=paths as [string,string],venv=join(install,'venv');
          await run(uv,['venv','--no-project','--python',python,venv]);
          await run(uv,['pip','install','--python',join(venv,'bin','python'),'--only-binary',':all:','--index-url',this.config.packageIndexUrl,launch.recipe.specifier]);
          const output=await run(uv,['pip','list','--python',join(venv,'bin','python'),'--format','json']);
          resolved=z.array(z.object({name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/)})).parse(JSON.parse(output));
          await writeFile(join(install,'requirements.lock'),resolved.map(value=>`${value.name}==${value.version}`).sort().join('\n')+'\n');
          command=join(venv,'bin',launch.recipe.executable);await access(command,constants.X_OK);args=launch.args;
        }
        if(controller.signal.aborted)throw monitorFailure??fail('PACKAGE_TIMEOUT','Package preparation exceeded its configured deadline');
        clearInterval(monitor);await monitoring;if(monitorFailure)throw monitorFailure;
        await rm(scratch,{recursive:true,force:true});
        const tree=await this.tree(install,tools.map(tool=>tool.realpath),true);
        // Flush both content and its directory ancestry before the receipt can acknowledge it.
        const stateRoot=resolve(this.config.stateRoot);
        for(let parent=resolve(directory);;parent=dirname(parent)){await this.sync(parent,true);if(parent===stateRoot)break;}
        if(controller.signal.aborted)throw fail('PACKAGE_TIMEOUT','Package preparation exceeded its configured deadline');
        const receipt:Receipt={format:1,definition:this.fingerprint(revision),platform:process.platform,arch:process.arch,command,args,tree,tools,resolved:resolved.sort((a,b)=>a.name.localeCompare(b.name))};
        if(Buffer.byteLength(json(receipt))>this.config.maxBodyBytes)throw fail('PACKAGE_RECEIPT_LIMIT','Package receipt exceeds the configured metadata limit');
        await durable(join(directory,'receipt.json'),receipt);await chmod(join(directory,'receipt.json'),0o400);
      }catch(error){if(monitorFailure)throw monitorFailure;if(error instanceof RackFault)throw error;if(controller.signal.aborted)throw fail('PACKAGE_TIMEOUT','Package preparation exceeded its configured deadline');throw fail('PACKAGE_PREPARATION','Package preparation failed; check package compatibility and tool configuration, then create a new definition revision');}
      finally{clearTimeout(timer);clearInterval(monitor);await monitoring;}
    }finally{this.active--;}
  }
  private async sync(path:string,directory:boolean){
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));
    try{await file.sync();}finally{await file.close();}
  }
  private registryDownload(value:string){
    try{const url=new URL(value);return !url.username&&!url.password&&!url.hash&&(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)));}catch{return false;}
  }
  private async budget(root:string){
    let bytes=0,entries=0;
    const walk=async(path:string)=>{let children:string[];try{children=await readdir(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const entry of children){const file=join(path,entry);let info;try{info=await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(++entries>this.config.maxPackageEntries||(bytes+=info.size)>this.config.maxPackageBytes)throw fail('PACKAGE_LIMIT','Package preparation exceeds configured storage limits');if(info.isDirectory())await walk(file);}};
    await walk(root);
  }
  private async boundedText(path:string){
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const info=await file.stat();if(!info.isFile()||info.size>this.config.maxBodyBytes)throw fail('PACKAGE_METADATA','Package metadata exceeds the configured document limit');let bytes=0;const chunks:Buffer[]=[];for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>this.config.maxBodyBytes)throw fail('PACKAGE_METADATA','Package metadata exceeds the configured document limit');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}finally{await file.close();}
  }
  async resolve(revision:ConnectionRevision):Promise<{command:string,args:string[],installation:PackageInstallation}>{
    if(revision.kind!=='stdio'||!revision.package)throw fail('PACKAGE_DEFINITION','A retained package definition revision is required');
    const directory=this.location(revision);let receipt:Receipt;
    try{receipt=Receipt.parse(JSON.parse(await this.boundedText(join(directory,'receipt.json'))));}catch{throw fail('PACKAGE_UNPREPARED','Package revision has no complete preparation; Apply it, or create a new revision if an earlier preparation was interrupted');}
    if(receipt.definition!==this.fingerprint(revision)||receipt.platform!==process.platform||receipt.arch!==process.arch)throw fail('PACKAGE_IDENTITY','Prepared package identity does not match this retained definition');
    try{
      for(const expected of receipt.tools){const actual=await this.fileIdentity(expected.path);if(json(actual)!==json(expected))throw new Error();}
      if(await this.tree(join(directory,'installation'),receipt.tools.map(tool=>tool.realpath))!==receipt.tree)throw new Error();
      await access(receipt.command,constants.X_OK);
    }catch(error){if(error instanceof RackFault&&error.code==='PACKAGE_LIMIT')throw error;throw fail('PACKAGE_DRIFT','Prepared package or runtime changed; register and Apply a new definition revision');}
    return {command:receipt.command,args:receipt.args,installation:{digest:receipt.tree,platform:receipt.platform,arch:receipt.arch,packages:receipt.resolved.map(value=>({name:value.name.replace(/^.*node_modules\//,''),version:value.version}))}};
  }
  private execute(request:PackageCommand):Promise<string>{
    return new Promise((resolve,reject)=>{
      let bytes=0,output='',failure:RackFault|undefined,kill:NodeJS.Timeout|undefined;
      const child=spawn(request.command,request.args,{cwd:request.cwd,env:request.env,stdio:['ignore','pipe','pipe'],detached:true});
      const terminate=()=>{failure??=fail('PACKAGE_TIMEOUT','Package preparation was cancelled or exceeded its deadline');try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}kill??=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},this.config.packageKillGraceMs);};
      request.signal.addEventListener('abort',terminate,{once:true});if(request.signal.aborted)terminate();
      child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>this.config.maxObservationBytes){failure=fail('PACKAGE_OUTPUT','Package tool exceeded the configured output limit');terminate();}else output+=data.toString('utf8');});
      child.stderr.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>this.config.maxObservationBytes){failure=fail('PACKAGE_OUTPUT','Package tool exceeded the configured output limit');terminate();}});
      child.on('error',()=>{failure=fail('PACKAGE_TOOL','Package preparation tool could not start');});
      child.on('close',code=>{request.signal.removeEventListener('abort',terminate);if(kill)clearTimeout(kill);if(failure)reject(failure);else if(code!==0)reject(fail('PACKAGE_TOOL','Package preparation tool failed; verify the package supports script-free installation'));else resolve(output);});
    });
  }
}
