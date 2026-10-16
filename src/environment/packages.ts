import {constants} from 'node:fs';
import {access,chmod,mkdir,open,readdir,realpath,rm,stat,lstat,readlink,writeFile,readFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {durable,json} from './storage.ts';
import {RackFault,PackageRequest,type RackConfig,type ConnectionRevision} from './contracts.ts';
import {fileIdentity,packageTool,toolDirectories,type ToolName,type ToolCandidates} from './toolchains.ts';
import {prepareBundle} from './bundles.ts';
import type {PackageInstallation} from './preparation-contracts.ts';

type Recipe=z.infer<typeof PackageRequest>;
const fail=(code:string,message:string)=>new RackFault(code,message,400);
const npmSpecifier=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9*^~.+_-]+)?$/;
const uvSpecifier=/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:==[a-zA-Z0-9][a-zA-Z0-9.+_-]*)?$/;
const executable=/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Familiar launch configurations are import syntax. They never run package managers
 * at worker activation; the daemon replaces them with the retained launch contract. */
export function packageLaunch(command:string,args:string[]):{recipe:Recipe,args:string[]}|undefined{
  const runner=basename(command).replace(/\.exe$/i,'');
  if(runner==='npx'||runner==='npx-cli.js'){
    const remaining=[...args];if(remaining[0]==='-y'||remaining[0]==='--yes')remaining.shift();const specifier=remaining.shift();
    if(!specifier||!npmSpecifier.test(specifier))throw fail('PACKAGE_SPECIFIER','Use npx [-y] registry-package[@version] followed by server arguments; runner flags, URLs and local packages are unsupported');
    const name=specifier.replace(/@[^/]*$/,'')||specifier;return {recipe:{manager:'npm',specifier,executable:basename(name)},args:remaining};
  }
  if(runner==='uvx'){
    const remaining=[...args],from=remaining[0]==='--from';if(from)remaining.shift();const requested=remaining.shift(),specifier=requested?.replace(/@latest$/,'').replace(/@(?=[A-Za-z0-9])/,'=='),entry=from?remaining.shift():specifier?.split('==')[0];
    if(!specifier||!uvSpecifier.test(specifier)||!entry||!executable.test(entry))throw fail('PACKAGE_SPECIFIER','Use uvx package[@version|@latest|==version], or uvx --from package[==version] executable, followed by server arguments');
    return {recipe:{manager:'uv',specifier,executable:entry},args:remaining};
  }
}
const Identity=z.object({path:z.string(),realpath:z.string(),sha256:z.string()}).strict();
const Version=z.object({name:z.string(),version:z.string()}).strict();
const Receipt=z.object({format:z.literal(2),artifact:z.string(),attempt:z.string().regex(/^attempt-[a-f0-9-]+$/),platform:z.string(),arch:z.string(),command:z.string(),args:z.array(z.string()),env:z.record(z.string(),z.string()),tree:z.string(),tools:z.array(Identity),runtimes:z.array(Version),resolved:z.array(Version)}).strict();
type Receipt=z.infer<typeof Receipt>;
const Attempt=z.object({state:z.enum(['preparing','failed','ready']),id:z.string().regex(/^attempt-[a-f0-9-]+$/),code:z.string().nullable()}).strict();
const Effect=z.object({state:z.enum(['starting','running','settled']),pid:z.number().int().positive().nullable()}).strict();
export type PackageCommand={command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,effectPath?:string};
export type PackageExecutor=(command:PackageCommand)=>Promise<string>;

/** Owns immutable private artifacts, retained dependency selections and bounded attempts.
 * Compatible definitions converge on one artifact; a failed settled attempt can retry its
 * retained lock. Acquisition only verifies published bytes and never repairs or installs. */
export class Packages{
  private config:RackConfig;private executor:PackageExecutor;private pending=new Map<string,Promise<void>>();private active=0;
  constructor(config:RackConfig,executor?:PackageExecutor){this.config=config;this.executor=executor??(request=>this.execute(request));}
  private key(recipe:Recipe){return createHash('sha256').update(json({recipe,platform:process.platform,arch:process.arch,registry:this.config.packageRegistry,index:this.config.packageIndexUrl})).digest('hex');}
  private location(recipe:Recipe){return join(this.config.stateRoot,'packages',this.key(recipe));}
  private launch(revision:ConnectionRevision&{kind:'stdio'}){
    const recipe=PackageRequest.parse(revision.package);
    if(revision.command===`package:${recipe.manager}`)return {recipe,args:revision.args};
    const launch=packageLaunch(revision.command,revision.args);if(!launch||json(launch.recipe)!==json(recipe))throw fail('PACKAGE_DEFINITION','Package recipe does not match its recorded launcher');return launch;
  }
  async prepare(revision:ConnectionRevision,signal?:AbortSignal,candidates:ToolCandidates={}):Promise<void>{
    if(revision.kind!=='stdio'||!revision.package)return;
    const key=this.location(revision.package),existing=this.pending.get(key);
    // One actor cancelling its observation must not cancel another actor's shared effect.
    if(existing){await existing;if(signal?.aborted)throw fail('PACKAGE_CANCELLED','Preparation observer was cancelled');return;}
    const work=this.prepareOne(revision,signal,candidates);this.pending.set(key,work);try{await work;}finally{this.pending.delete(key);}
  }
  private async prepareOne(revision:ConnectionRevision&{kind:'stdio'},signal:AbortSignal|undefined,candidates:ToolCandidates){
    const {recipe}=this.launch(revision),directory=this.location(recipe),receiptPath=join(directory,'receipt.json');
    try{await stat(receiptPath);await this.resolve(revision);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(signal?.aborted)throw fail('PACKAGE_CANCELLED','Preparation was cancelled before execution');
    if(this.active>=this.config.maxPackageConcurrent)throw fail('PACKAGE_BUSY','Package preparation capacity is occupied; continue after its current operation settles');
    this.active++;
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.config.packageTimeoutMs);let monitoring:Promise<void>|undefined,monitorFailure:unknown,monitor:NodeJS.Timeout|undefined,attempt:string|undefined;
    try{
      await mkdir(directory,{recursive:true,mode:0o700});
      let previous:z.infer<typeof Attempt>|undefined;try{previous=Attempt.parse(JSON.parse(await this.boundedText(join(directory,'attempt.json'))));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(previous&&previous.state!=='ready'){
        let effect:z.infer<typeof Effect>|undefined;try{effect=Effect.parse(JSON.parse(await this.boundedText(join(directory,previous.id,'effect.json'))));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(previous.state==='preparing'&&!effect||effect?.state==='starting'||effect?.state==='running'&&effect.pid&&this.alive(effect.pid))throw fail('PACKAGE_CLEANUP_PENDING','Interrupted preparation has an uncertain process effect; inspect and settle its retained attempt before continuing');
      }
      if(recipe.manager==='cargo'&&!recipe.nativeBuild)throw fail('PACKAGE_BUILD_AUTHORITY','Cargo requires an explicit nativeBuild recipe granting build-script execution with host-user authority');
      const names:ToolName[]=recipe.manager==='npm'?['node','npm']:recipe.manager==='uv'?['uv','python']:recipe.manager==='nuget'?['dotnet']:recipe.manager==='cargo'?['cargo','rustc']:[];
      const tools=await Promise.all(names.map(async name=>fileIdentity(await packageTool(this.config,name,candidates),this.config.maxIdentityBytes)));
      attempt='attempt-'+randomUUID();const root=join(directory,attempt),install=join(root,'installation'),scratch=join(root,'preparation');await mkdir(install,{recursive:true,mode:0o700});await mkdir(scratch,{mode:0o700});
      await durable(join(directory,'attempt.json'),{state:'preparing',id:attempt,code:null});
      const env:NodeJS.ProcessEnv={PATH:[...new Set([...tools.map(tool=>dirname(tool.path)),...await toolDirectories(this.config)])].join(':'),HOME:scratch,TMPDIR:scratch,LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1',UV_NO_CONFIG:'1',UV_NO_CACHE:'1',UV_PYTHON_DOWNLOADS:'never',NPM_CONFIG_USERCONFIG:join(scratch,'npmrc'),NPM_CONFIG_GLOBALCONFIG:join(scratch,'global-npmrc'),NPM_CONFIG_CACHE:join(scratch,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false',NPM_CONFIG_LOGS_MAX:'0',NPM_CONFIG_LOGLEVEL:'error',NPM_CONFIG_ENGINE_STRICT:'true',DOTNET_CLI_HOME:scratch,DOTNET_NOLOGO:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1',NUGET_PACKAGES:join(scratch,'nuget'),NUGET_HTTP_CACHE_PATH:join(scratch,'nuget-cache'),CARGO_HOME:join(scratch,'cargo'),CARGO_TARGET_DIR:join(scratch,'target'),RUSTUP_HOME:join(homedir(),'.rustup')};
      monitor=setInterval(()=>{if(monitoring)return;monitoring=this.budget(root).catch(error=>{monitorFailure=error;controller.abort();}).finally(()=>{monitoring=undefined;});},this.config.monitorMs);
      const run=async(command:string,args:string[])=>{
        if(controller.signal.aborted)throw monitorFailure??fail(signal?.aborted?'PACKAGE_CANCELLED':'PACKAGE_TIMEOUT','Package preparation was cancelled or exceeded its deadline');
        const output=await this.executor({command,args,cwd:install,env,signal:controller.signal,effectPath:join(root,'effect.json')});await this.budget(root);return output;
      };
      const runtimes:Receipt['runtimes']=[];
      for(let index=0;index<names.length;index++){
        const name=names[index]!,tool=tools[index]!.path,output=await run(name==='npm'?tools[names.indexOf('node')]!.path:tool,name==='npm'?[tool,'--version']:['--version']);
        const version=/\b[vV]?(\d+\.\d+\.\d+)/.exec(output)?.[1];if(!version)throw fail('PACKAGE_TOOL_VERSION',`The ${name} candidate did not report a valid version`);runtimes.push({name,version});
      }
      let command:string,args:string[]=[],launchEnv:Record<string,string>={},resolved:Receipt['resolved']=[];
      if(recipe.manager==='npm'){
        const [node,npm]=tools.map(tool=>tool.path) as [string,string];
        await writeFile(join(install,'package.json'),JSON.stringify({name:'polariton-prepared-capability',private:true,version:'1.0.0'}));
        const lockPath=join(directory,'npm-lock.json');let lockText:string;
        try{lockText=await this.boundedText(lockPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await run(node,[npm,'install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund','--save-exact','--registry',this.config.packageRegistry,'--',recipe.specifier]);lockText=await this.boundedText(join(install,'package-lock.json'));}
        const lock=JSON.parse(lockText);if(!lock.packages||typeof lock.packages!=='object'||!lock.packages['']?.dependencies)throw fail('PACKAGE_LOCK','npm did not produce a complete dependency lock');
        for(const [key,value] of Object.entries(lock.packages) as [string,{version?:string,resolved?:string,integrity?:string,link?:boolean}][]){if(!key)continue;if(value.link||!value.version||!value.resolved||!value.integrity||!this.registryDownload(value.resolved)||!/^\d[^\s]*$/.test(value.version))throw fail('PACKAGE_DEPENDENCY','Only registry dependencies with locked versions and integrity are supported');resolved.push({name:key,version:value.version});}
        await durable(lockPath,lock);await writeFile(join(install,'package-lock.json'),json(lock));await writeFile(join(install,'package.json'),JSON.stringify({name:'polariton-prepared-capability',private:true,version:'1.0.0',dependencies:lock.packages[''].dependencies}));
        await run(node,[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--registry',this.config.packageRegistry]);
        const name=recipe.specifier.replace(/@[^/]*$/,'')||recipe.specifier,packageDirectory=join(install,'node_modules',name),metadata=JSON.parse(await this.boundedText(join(packageDirectory,'package.json'))),bins=typeof metadata.bin==='string'?{[recipe.executable]:metadata.bin}:metadata.bin;
        if(!bins||typeof bins!=='object')throw fail('PACKAGE_ENTRYPOINT','Installed npm package declares no executable');
        const values=[...new Set(Object.values(bins))],entry=bins[recipe.executable]??(values.length===1?values[0]:undefined);if(typeof entry!=='string')throw fail('PACKAGE_ENTRYPOINT','Package has multiple executables; select its executable explicitly');
        const path=await realpath(resolve(packageDirectory,entry));if(!path.startsWith(await realpath(packageDirectory)+sep))throw fail('PACKAGE_ENTRYPOINT','Package executable escapes its installation');
        const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let first:string;try{const bytes=Buffer.alloc(this.config.maxObservationBytes),read=await file.read(bytes,0,bytes.length,0);first=bytes.subarray(0,read.bytesRead).toString('utf8').split('\n',1)[0]!;}finally{await file.close();}
        if(!/^#!.*\bnode(?:\s|$)/.test(first))throw fail('PACKAGE_ENTRYPOINT','npm package must expose a Node executable; shell/native launchers need an explicit recipe');
        command=node;args=[path];
        for(const asset of recipe.assets??[]){
          const playwright=join(install,'node_modules','playwright','cli.js');await access(playwright);const browsers=join(install,'browsers');env.PLAYWRIGHT_BROWSERS_PATH=browsers;env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='0';await run(node,[playwright,'install',asset.browser]);launchEnv.PLAYWRIGHT_BROWSERS_PATH=browsers;
        }
      }else if(recipe.manager==='uv'){
        if(recipe.assets?.length)throw fail('PACKAGE_RECIPE','Python packages do not support the declared browser asset recipe');
        const [uv,python]=tools.map(tool=>tool.path) as [string,string],venv=join(install,'venv'),lockPath=join(directory,'python-lock.json');let lock:string;
        try{lock=z.string().parse(JSON.parse(await this.boundedText(lockPath)));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writeFile(join(install,'requirements.in'),recipe.specifier+'\n');await run(uv,['pip','compile','--python',python,'--generate-hashes','--only-binary',':all:','--index-url',this.config.packageIndexUrl,'requirements.in','--output-file','requirements.lock']);lock=await this.boundedText(join(install,'requirements.lock'));}
        if(!lock.includes('--hash=sha256:')||/(?:^-e|git\+|https?:\/\/|file:)/m.test(lock.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n')))throw fail('PACKAGE_LOCK','Python dependencies require a registry-only hash-locked wheel selection');
        await durable(lockPath,lock);await writeFile(join(install,'requirements.lock'),lock);await run(uv,['venv','--no-project','--python',python,venv]);
        await run(uv,['pip','install','--python',join(venv,'bin','python'),'--only-binary',':all:','--require-hashes','--no-deps','--index-url',this.config.packageIndexUrl,'--requirement',join(install,'requirements.lock')]);
        resolved=z.array(Version).parse(JSON.parse(await run(uv,['pip','list','--python',join(venv,'bin','python'),'--format','json'])));command=join(venv,'bin',recipe.executable);await access(command,constants.X_OK);
      }else if(recipe.manager==='nuget'){
        const dotnet=tools[0]!.path,configPath=join(scratch,'NuGet.Config');await writeFile(configPath,'<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources><disabledPackageSources><clear/></disabledPackageSources></configuration>');
        await run(dotnet,['tool','install',recipe.identifier,'--version',recipe.version,'--tool-path',install,'--configfile',configPath,'--no-cache','--disable-parallel']);
        const entries=(await readdir(install,{withFileTypes:true})).filter(value=>(value.isFile()||value.isSymbolicLink())&&!value.name.startsWith('.'));
        const selected=recipe.executable??(entries.length===1?entries[0]!.name:undefined);if(!selected)throw fail('PACKAGE_ENTRYPOINT','NuGet package has multiple tools; select its executable');command=join(install,selected);await access(command,constants.X_OK);resolved=[{name:recipe.identifier,version:recipe.version}];launchEnv.DOTNET_ROOT=dirname(await realpath(dotnet));
      }else if(recipe.manager==='cargo'){
        const cargo=tools[0]!.path;
        await run(cargo,['install','--locked','--version',`=${recipe.version}`,'--root',install,'--jobs',String(this.config.packageBuildJobs),'--',recipe.identifier]);
        const entries=(await readdir(join(install,'bin'),{withFileTypes:true})).filter(value=>value.isFile());const selected=recipe.executable??(entries.length===1?entries[0]!.name:undefined);if(!selected)throw fail('PACKAGE_ENTRYPOINT','Cargo package has multiple executables; select its executable');
        command=join(install,'bin',selected);await access(command,constants.X_OK);resolved=[{name:recipe.identifier,version:recipe.version}];
        // The published Cargo.lock is retained independently of its disposable compilation tree.
        const registry=join(scratch,'cargo','registry','src');let retained=false;for(const registryDir of await readdir(registry)){const lock=join(registry,registryDir,`${recipe.identifier}-${recipe.version}`,'Cargo.lock');try{await writeFile(join(install,'Cargo.lock'),await readFile(lock));retained=true;break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
        if(!retained)throw fail('PACKAGE_LOCK','Cargo package did not retain the required published dependency lock');
      }else if(recipe.manager==='mcpb'){
        const bundle=await prepareBundle(recipe,join(install,'bundle'),this.config,controller.signal);resolved=[{name:bundle.name,version:bundle.version}];args=bundle.args;launchEnv=bundle.env;
        if(bundle.runtime==='binary')command=bundle.entry;
        else{
          command=await packageTool(this.config,bundle.runtime,candidates);tools.push(await fileIdentity(command,this.config.maxIdentityBytes));
          const version=await run(command,['--version']);this.compatibility(version,bundle.constraint);runtimes.push({name:bundle.runtime,version:version.trim()});if(bundle.runtime==='python')launchEnv.PYTHONDONTWRITEBYTECODE='1';
        }
      }else throw fail('PACKAGE_RECIPE','Package manager has no supported preparation recipe');
      if(recipe.manager==='cargo'||recipe.manager==='nuget')launchEnv.PATH=[...new Set([dirname(command),...tools.map(tool=>dirname(tool.path)),...this.config.executablePaths])].join(':');
      if(recipe.manager==='cargo'){launchEnv.CARGO_HOME='${POLARITON_RUNTIME}/cargo';launchEnv.RUSTC=tools[1]!.path;}
      if(controller.signal.aborted)throw monitorFailure??fail(signal?.aborted?'PACKAGE_CANCELLED':'PACKAGE_TIMEOUT','Package preparation was cancelled or exceeded its deadline');
      if(monitor)clearInterval(monitor);await monitoring;if(monitorFailure)throw monitorFailure;
      await rm(scratch,{recursive:true,force:true});const tree=await this.tree(install,tools.map(tool=>tool.realpath),true);
      for(const tool of tools)if(json(await fileIdentity(tool.path,this.config.maxIdentityBytes))!==json(tool))throw fail('PACKAGE_DRIFT','A preparation tool changed during installation');
      const receipt:Receipt={format:2,artifact:this.key(recipe),attempt,platform:process.platform,arch:process.arch,command,args,env:launchEnv,tree,tools,runtimes,resolved:resolved.sort((a,b)=>a.name.localeCompare(b.name))};
      if(Buffer.byteLength(json(receipt))>this.config.maxBodyBytes)throw fail('PACKAGE_RECEIPT_LIMIT','Package provenance exceeds its configured metadata limit');
      const stateRoot=resolve(this.config.stateRoot);for(let parent=resolve(root);;parent=dirname(parent)){await this.sync(parent,true);if(parent===stateRoot)break;}
      await durable(receiptPath,receipt);await chmod(receiptPath,0o400);await durable(join(directory,'attempt.json'),{state:'ready',id:attempt,code:null});
    }catch(error){
      const code=monitorFailure instanceof RackFault?monitorFailure.code:error instanceof RackFault?error.code:controller.signal.aborted?signal?.aborted?'PACKAGE_CANCELLED':'PACKAGE_TIMEOUT':'PACKAGE_PREPARATION';
      if(attempt)await durable(join(directory,'attempt.json'),{state:'failed',id:attempt,code});
      if(monitorFailure)throw monitorFailure;if(error instanceof RackFault)throw error;throw fail(code,'Package preparation failed; inspect its retained attempt and continue after resolving its dependency or toolchain requirement');
    }finally{clearTimeout(timer);if(monitor)clearInterval(monitor);await monitoring;signal?.removeEventListener('abort',abort);this.active--;}
  }
  private compatibility(output:string,constraint:string|undefined){
    if(!constraint)return;const actual=/\b[vV]?(\d+)\.(\d+)\.(\d+)/.exec(output),parts=/^(>=|>|<=|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(constraint.trim());
    if(!actual||!parts)throw fail('PACKAGE_RUNTIME_VERSION','Bundle runtime constraint is not a supported single numeric comparison');
    const current=actual.slice(1).map(Number),required=parts.slice(2).map(Number);let order=0;for(let i=0;i<current.length&&!order;i++)order=Math.sign(current[i]!-required[i]!);
    if(!(parts[1]==='>='?order>=0:parts[1]==='>'?order>0:parts[1]==='<='?order<=0:parts[1]==='<'?order<0:order===0))throw fail('PACKAGE_RUNTIME_VERSION',`Bundle requires runtime ${constraint}`);
  }
  private registryDownload(value:string){try{const url=new URL(value);return !url.username&&!url.password&&!url.hash&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));}catch{return false;}}
  private async sync(path:string,directory:boolean){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory?constants.O_DIRECTORY:0));try{await file.sync();}finally{await file.close();}}
  private async tree(root:string,external:string[],seal=false):Promise<string>{
    const files:Array<{path:string,sha256:string,mode:number}>=[{path:'/',sha256:'',mode:seal?0o555:(await lstat(root)).mode&0o777}],canonicalRoot=await realpath(root);let bytes=0,entries=0;
    const walk=async(directory:string)=>{for(const entry of (await readdir(directory)).sort()){
      const path=join(directory,entry),info=await lstat(path);if(++entries>this.config.maxPackageEntries)throw fail('PACKAGE_LIMIT','Package installation exceeds its configured entry limit');const local=relative(root,path);
      if(info.isSymbolicLink()){const target=await realpath(path);if(target!==canonicalRoot&&!target.startsWith(canonicalRoot+sep)&&!external.includes(target))throw fail('PACKAGE_LINK','Package installation contains an unsupported external link');files.push({path:local,sha256:createHash('sha256').update(await readlink(path)).digest('hex'),mode:info.mode&0o777});}
      else if(info.isDirectory()){await walk(path);if(seal){await chmod(path,0o555);await this.sync(path,true);}files.push({path:local+'/',sha256:'',mode:seal?0o555:info.mode&0o777});}
      else if(info.isFile()){bytes+=info.size;if(bytes>this.config.maxPackageBytes)throw fail('PACKAGE_LIMIT','Package installation exceeds its configured byte limit');const identity=await fileIdentity(path,this.config.maxPackageBytes),mode=info.mode&0o111?0o555:0o444;if(seal){await chmod(path,mode);await this.sync(path,false);}files.push({path:local,sha256:identity.sha256,mode:seal?mode:info.mode&0o777});}
      else throw fail('PACKAGE_FILE','Package installation contains an unsupported special file');
    }};
    await walk(root);if(seal){await chmod(root,0o555);await this.sync(root,true);}return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  }
  private async budget(root:string){let bytes=0,entries=0;const walk=async(path:string)=>{let children:string[];try{children=await readdir(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const entry of children){const file=join(path,entry);let info;try{info=await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}if(++entries>this.config.maxPackageEntries||(bytes+=info.size)>this.config.maxPackageBytes)throw fail('PACKAGE_LIMIT','Preparation exceeds its configured storage budget');if(info.isDirectory())await walk(file);}};await walk(root);}
  private async boundedText(path:string){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await file.stat();if(!info.isFile()||info.size>this.config.maxBodyBytes)throw fail('PACKAGE_METADATA','Package metadata exceeds its document budget');let size=0;const chunks:Buffer[]=[];for await(const chunk of file.createReadStream({autoClose:false})){size+=chunk.length;if(size>this.config.maxBodyBytes)throw fail('PACKAGE_METADATA','Package metadata exceeds its document budget');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}finally{await file.close();}}
  async resolve(revision:ConnectionRevision):Promise<{command:string,args:string[],env:Record<string,string>,installation:PackageInstallation}>{
    if(revision.kind!=='stdio'||!revision.package)throw fail('PACKAGE_DEFINITION','A retained package definition is required');
    const launch=this.launch(revision),directory=this.location(launch.recipe);let receipt:Receipt;try{receipt=Receipt.parse(JSON.parse(await this.boundedText(join(directory,'receipt.json'))));}catch{throw fail('PACKAGE_UNPREPARED','Package has no published artifact; prepare or continue its retained operation');}
    if(receipt.artifact!==this.key(launch.recipe)||receipt.platform!==process.platform||receipt.arch!==process.arch)throw fail('PACKAGE_IDENTITY','Prepared artifact does not match this definition or platform');
    try{for(const expected of receipt.tools)if(json(await fileIdentity(expected.path,this.config.maxIdentityBytes))!==json(expected))throw new Error();if(await this.tree(join(directory,receipt.attempt,'installation'),receipt.tools.map(tool=>tool.realpath))!==receipt.tree)throw new Error();await access(receipt.command,constants.X_OK);}
    catch(error){if(error instanceof RackFault&&error.code==='PACKAGE_LIMIT')throw error;throw fail('PACKAGE_DRIFT','Prepared artifact or runtime changed; inspect its retained identity before revalidation');}
    const recipe=launch.recipe,normalize=(name:string)=>name.toLowerCase().replace(/[-_.]+/g,'-');
    const primary=recipe.manager==='npm'?receipt.resolved.find(value=>value.name===`node_modules/${recipe.specifier.replace(/@[^/]*$/,'')||recipe.specifier}`):recipe.manager==='uv'?receipt.resolved.find(value=>normalize(value.name)===normalize(recipe.specifier.split('==')[0]!)):receipt.resolved[0];
    return {command:receipt.command,args:[...receipt.args,...launch.args],env:receipt.env,installation:{digest:receipt.tree,platform:receipt.platform,arch:receipt.arch,...primary?{primary:{name:primary.name.replace(/^.*node_modules\//,''),version:primary.version}}:{},packages:receipt.resolved.map(value=>({name:value.name.replace(/^.*node_modules\//,''),version:value.version}))}};
  }
  private alive(pid:number){try{process.kill(-pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;return true;}}
  private async settle(pid:number){
    for(const signal of ['SIGTERM','SIGKILL'] as const){
      if(!this.alive(pid))return;
      try{process.kill(-pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;}
      const deadline=Date.now()+this.config.packageKillGraceMs;
      while(this.alive(pid)&&Date.now()<deadline)await new Promise<void>(done=>setTimeout(done,Math.min(this.config.monitorMs,Math.max(1,deadline-Date.now()))));
    }
    if(this.alive(pid))throw fail('PACKAGE_CLEANUP_PENDING','Preparation descendants could not be confirmed stopped; retain and inspect their process ownership before retrying');
  }
  private async execute(request:PackageCommand):Promise<string>{
    if(request.effectPath)await durable(request.effectPath,{state:'starting',pid:null});
    return new Promise((accept,reject)=>{
      let bytes=0,output='',failure:RackFault|undefined,kill:NodeJS.Timeout|undefined;const child=spawn(request.command,request.args,{cwd:request.cwd,env:request.env,stdio:['ignore','pipe','pipe'],detached:true});
      const journal=child.pid&&request.effectPath?durable(request.effectPath,{state:'running',pid:child.pid}):Promise.resolve();
      const terminate=()=>{failure??=fail('PACKAGE_TIMEOUT','Package preparation was cancelled or exceeded its deadline');try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}kill??=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},this.config.packageKillGraceMs);};
      void journal.catch(()=>{failure=fail('PACKAGE_JOURNAL','Cannot retain preparation process ownership');terminate();});
      request.signal.addEventListener('abort',terminate,{once:true});if(request.signal.aborted)terminate();
      child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>this.config.maxObservationBytes){failure=fail('PACKAGE_OUTPUT','Preparation output exceeds its configured budget');terminate();}else output+=data.toString('utf8');});
      child.stderr.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>this.config.maxObservationBytes){failure=fail('PACKAGE_OUTPUT','Preparation output exceeds its configured budget');terminate();}});
      child.on('error',()=>{failure=fail('PACKAGE_TOOL','Preparation tool could not start');});
      child.on('close',code=>{void(async()=>{
        request.signal.removeEventListener('abort',terminate);if(kill)clearTimeout(kill);await journal;
        if(child.pid)await this.settle(child.pid);
        if(request.effectPath)await durable(request.effectPath,{state:'settled',pid:child.pid??null});
        if(failure)throw failure;if(code!==0)throw fail('PACKAGE_TOOL','Preparation tool failed; inspect the declared package/runtime requirements');return output;
      })().then(accept,reject);});
    });
  }
}
