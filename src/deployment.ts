import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {applicationPaths} from './paths.ts';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {executionHost} from './host-support.ts';

const trees=['src','harness','web','environment','native','skills','catalog','bin','tests','scripts'];
// Explicit public documentation/configuration: private records and generated
// verification output never become distribution inputs implicitly.
const files=[
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.harness.json",
  "vite.config.ts",
  "README.md",
  "AGENTS.md",
  ".env.example",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "config/adr006-app.json",
  "config/adr006-campaign.json",
  "config/adr007-app.json",
  "config/adr007-campaign.json",
  "config/adr009-campaign.json",
  "config/adr010-app.json",
  "config/adr010-campaign.json",
  "config/adr010-environment.json",
  "config/adr011-app.json",
  "config/adr011-campaign.json",
  "config/adr011-environment.json",
  "config/adr012-app.json",
  "config/adr012-campaign.json",
  "config/adr012-cases.json",
  "config/adr012-environment.json",
  "config/adr018-app.json",
  "config/adr018-campaign.json",
  "config/adr025-live.json",
  "config/adr027-validation.json",
  "config/app.json",
  "config/browser-verification.json",
  "config/deployment.json",
  "config/environment.json",
  "config/qualification.json",
  "skills/make-polariton-tool/assets/managed/.gitignore",
  ".nvmrc",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "docs/ARCHITECTURE.md",
  "docs/CLI.md",
  "docs/COMPATIBILITY.md",
  "docs/DEVELOPMENT.md",
  "docs/ENVIRONMENT.md",
  "docs/GETTING_STARTED.md",
  "docs/LIMITATIONS.md",
  "docs/MAINTAINING.md",
  "docs/README.md",
  "docs/STORAGE.md",
  "docs/UI_ORIGIN.md"
];
type Entry={path:string;sha256:string;mode:number};
type Release={format:1;version:string;files:Entry[]};
export type DeploymentLimits={installTimeoutMs:number;commandOutputBytes:number;serviceRestartMs:number;serviceStartLimitMs:number;serviceStartLimitBurst:number;socketPathBytes:number};
export type InstallationPaths=ReturnType<typeof applicationPaths>&{services:string};
type Run=(command:string,args:string[],options:{cwd:string;timeout:number;maxBuffer:number;env?:NodeJS.ProcessEnv})=>Promise<void>;
// npm owns a foreground process tree. Terminating only its parent would let a
// timed-out build keep writing into a staging directory that rollback removes.
const run:Run=(command,args,options)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:options.cwd,env:options.env,detached:true,stdio:['ignore','pipe','pipe']});
  const chunks:Buffer[]=[];let bytes=0,failure:Error|undefined;
  const stop=(error:Error)=>{
    if(failure)return;failure=error;
    try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch(killError){if((killError as NodeJS.ErrnoException).code!=='ESRCH')failure=new AggregateError([error,killError],'Installation could not terminate its command process group');}
  };
  const timer=setTimeout(()=>stop(new Error(`Installation command exceeded its deadline: ${command}`)),options.timeout);
  for(const stream of [child.stdout,child.stderr])stream!.on('data',(chunk:Buffer)=>{
    const remaining=options.maxBuffer-bytes;if(remaining>0)chunks.push(chunk.subarray(0,remaining));bytes+=chunk.length;
    if(bytes>options.maxBuffer)stop(new Error(`Installation command exceeded its output limit: ${command}`));
  });
  child.once('error',error=>{failure??=error;});
  child.once('close',(code,signal)=>{
    clearTimeout(timer);
    if(failure||code!==0){const detail=Buffer.concat(chunks).toString('utf8');reject(new Error(`${failure?.message??`Installation command failed: ${command} (${signal??code})`}${detail?'\n'+detail:''}`,{cause:failure}));}
    else{process.stdout.write(Buffer.concat(chunks));resolve();}
  });
});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Source archives are assembled from owned inputs only. Hidden files, symlinks,
 * state, dependency caches and evidence cannot enter through recursive copying. */
export async function createRelease(source:string,destination:string,version:string):Promise<{archive:string;sha256:string}>{
  if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw new Error('Release version must be a semantic version.');
  source=await realpath(source);destination=resolve(destination);
  const packageIdentity:unknown=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
  if(!packageIdentity||typeof packageIdentity!=='object'||(packageIdentity as Record<string,unknown>).version!==version)throw new Error('Archive version must match package.json; one release has one identity.');
  await mkdir(destination,{recursive:true});
  const temporary=await mkdtemp(join(destination,'.polariton-release-')),name=`polariton-${version}`,root=join(temporary,name);
  const entries:Entry[]=[];
  const copy=async(path:string):Promise<void>=>{
    const original=join(source,path),info=await lstat(original);
    if(info.isDirectory()){
      await mkdir(join(root,path),{recursive:true});
      for(const name of (await readdir(original)).sort()){
        if(name.startsWith('.')||['node_modules','dist'].includes(name))continue;
        await copy(join(path,name));
      }
    }else if(info.isFile()){
      const bytes=await readFile(original),mode=info.mode&0o111?0o755:0o644;
      await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes,{mode});
      entries.push({path:path.split('\\').join('/'),sha256:hash(bytes),mode});
    }else throw new Error(`Release input must be a regular file or directory: ${path}`);
  };
  try{
    for(const path of [...trees,...files])await copy(path);
    const manifest:Release={format:1,version,files:entries.sort((a,b)=>a.path.localeCompare(b.path))};
    await writeFile(join(root,'release.json'),JSON.stringify(manifest,null,2)+'\n');
    const archive=join(destination,`${name}.tar.gz`);
    const handle=await open(archive,'wx',0o644);await handle.close();
    try{
      const tar=await import('tar');
      await tar.c({gzip:true,file:archive,cwd:temporary,portable:true,mtime:new Date(0)},[name]);
    }catch(error){await rm(archive,{force:true});throw error;}
    return {archive,sha256:hash(await readFile(archive))};
  }finally{await rm(temporary,{recursive:true,force:true});}
}

/** Validate the complete unpacked source before installing any dependencies.
 * The manifest is integrity evidence for a trusted release, not a signature. */
export async function inspectRelease(source:string):Promise<Release>{
  const raw:unknown=JSON.parse(await readFile(join(source,'release.json'),'utf8'));
  if(!raw||typeof raw!=='object')throw new Error('Missing release manifest');
  const value=raw as Record<string,unknown>;
  if(value.format!==1||typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)||!Array.isArray(value.files))throw new Error('Unsupported release manifest');
  const entries:Entry[]=[],seen=new Set<string>();
  for(const rawEntry of value.files){
    const entry=rawEntry as Partial<Entry>;
    if(!entry||typeof entry.path!=='string'||entry.path.includes('\\')||isAbsolute(entry.path)||entry.path.split('/').some(part=>!part||part==='.'||part==='..')||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||![0o644,0o755].includes(entry.mode??0)||seen.has(entry.path))throw new Error('Invalid release file identity');
    const path=entry.path;
    if(!files.includes(path)&&!trees.some(tree=>path.startsWith(tree+'/')&&path.split('/').every(part=>!part.startsWith('.')&&!['node_modules','dist'].includes(part))))throw new Error(`Undeclared release source: ${path}`);
    seen.add(entry.path);entries.push(entry as Entry);
  }
  for(const required of files)if(!seen.has(required))throw new Error(`Release is missing ${required}`);
  const actual:string[]=[];
  const walk=async(directory:string):Promise<void>=>{for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile())actual.push(relative(source,path));else throw new Error(`Nonregular release input: ${path}`);
  }};
  await walk(source);
  if(actual.length!==entries.length+1||actual.some(path=>path!=='release.json'&&!seen.has(path)))throw new Error('Unpacked release contains undeclared files');
  for(const entry of entries){const path=join(source,entry.path),info=await lstat(path);if(!info.isFile()||hash(await readFile(path))!==entry.sha256||(info.mode&0o111)!==(entry.mode&0o111))throw new Error(`Release integrity check failed: ${entry.path}`);}
  return {format:1,version:value.version,files:entries};
}

/** Ubuntu services and source launches share the same data policy. The old
 * state location remains a preservation guard for pre-ADR-030 installations. */
export function installationPaths(env:NodeJS.ProcessEnv=process.env,home=homedir(),uid=process.getuid?.()):InstallationPaths{
  const paths=applicationPaths({env,home,uid,platform:'linux'});
  const configuration=env.XDG_CONFIG_HOME&&isAbsolute(env.XDG_CONFIG_HOME)?env.XDG_CONFIG_HOME:join(home,'.config');
  return {...paths,services:join(configuration,'systemd/user')};
}

/** Emit independent peer units. The service manager owns restart/cgroup cleanup;
 * each daemon retains graceful domain shutdown and uncertain-work recovery. */
export function serviceUnits(input:{release:string;node:string;appConfig:string;environmentConfig:string;mainShutdownMs:number;environmentShutdownMs:number;limits:DeploymentLimits}):Record<string,string>{
  const quote=(value:string,command=true)=>{if(/[\0\r\n]/.test(value))throw new Error('Service paths must not contain line breaks');return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=>command?'$$':'$')+'"';};
  if(!isAbsolute(input.release))throw new Error('Service working directory must be absolute');
  const nodeDirectory=dirname(input.node);
  if(nodeDirectory.includes(':'))throw new Error('Node directory cannot contain a PATH separator');
  const executablePath=[nodeDirectory,'/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin'].join(':');
  const common=(name:string,entry:string,config:string,timeout:number)=>`[Unit]\nDescription=Polariton ${name}\nPartOf=polariton.target\nStartLimitIntervalSec=${input.limits.serviceStartLimitMs}ms\nStartLimitBurst=${input.limits.serviceStartLimitBurst}\n\n[Service]\nType=exec\nExecStart=${quote(input.node)} ${quote(join(input.release,entry))} ${quote(config)}${name==='Main'?' --no-open':''}\nWorkingDirectory=${input.release.replaceAll('%','%%')}\nEnvironment=${quote(`PATH=${executablePath}`,false)}\nUMask=0077\nRestart=on-failure\nRestartSec=${input.limits.serviceRestartMs}ms\nKillMode=mixed\nTimeoutStopSec=${timeout}ms\n\n[Install]\nWantedBy=polariton.target\n`;
  return {'polariton-main.service':common('Main','src/main.ts',input.appConfig,input.mainShutdownMs),
    'polariton-environment.service':common('Environment','src/environment/daemon.ts',input.environmentConfig,input.environmentShutdownMs),
    'polariton.target':'[Unit]\nDescription=Polariton local research workspace\nWants=polariton-main.service polariton-environment.service\n\n[Install]\nWantedBy=default.target\n'};
}

/** A fresh installation builds a verified source copy before publishing any user
 * configuration or services. Existing installations and experiments are preserved;
 * this operation never activates services or migrates retained data. */
export async function installRelease(source:string,options:{paths?:InstallationPaths;run?:Run;host?:()=>{profile:ReturnType<typeof executionHost>;nodeVersion:string}}={}):Promise<{release:string;config:string;target:string}>{
  const manifest=await inspectRelease(source),paths=options.paths??installationPaths(),command=options.run??run;
  const host=options.host?.()??{profile:executionHost(),nodeVersion:process.versions.node};
  if(host.profile==='macos-arm64')throw new Error('The installed service profile requires Ubuntu 24.04 or 26.04 amd64');
  const nodeVersion=/^24\.(\d+)\.\d+$/.exec(host.nodeVersion);
  if(!nodeVersion||Number(nodeVersion[1])<21)throw new Error('Ubuntu installation requires Node 24.21 or later in the Node 24 series');
  const raw:unknown=JSON.parse(await readFile(join(source,'config/deployment.json'),'utf8'));
  const names=['installTimeoutMs','commandOutputBytes','serviceRestartMs','serviceStartLimitMs','serviceStartLimitBurst','socketPathBytes'] as const;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==names.length||Object.keys(raw).some(name=>!names.includes(name as typeof names[number])))throw new Error('Invalid deployment limits');
  // This bootstrap runs before npm ci: dependency schemas are intentionally not
  // imported. Every wire value is checked before constructing the typed limits.
  const positive=(name:typeof names[number]):number=>{const value=(raw as Record<string,unknown>)[name];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw new Error(`Invalid deployment limit: ${name}`);return value;};
  const limits:DeploymentLimits={installTimeoutMs:positive('installTimeoutMs'),commandOutputBytes:positive('commandOutputBytes'),serviceRestartMs:positive('serviceRestartMs'),serviceStartLimitMs:positive('serviceStartLimitMs'),serviceStartLimitBurst:positive('serviceStartLimitBurst'),socketPathBytes:positive('socketPathBytes')};
  const deadline=Date.now()+limits.installTimeoutMs;
  const invoke=async(executable:string,args:string[],cwd:string,env?:NodeJS.ProcessEnv)=>{
    const timeout=deadline-Date.now();if(timeout<=0)throw new Error('Installation exceeded its configured deadline');
    await command(executable,args,{cwd,env,timeout,maxBuffer:limits.commandOutputBytes});
  };
  for(const path of [paths.config,paths.state]){try{await lstat(path);throw new Error(`Existing installation preserved: ${path}. Use a tested stopped upgrade procedure.`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  // Storage qualification can leave an empty data root. Reuse only a private,
  // user-owned real directory; it remains operator-owned during rollback.
  const inspectDataDirectory=async()=>{
    let directory;
    try{directory=await lstat(paths.data);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    if(!directory.isDirectory()||directory.uid!==process.getuid?.()||(directory.mode&0o077)!==0||(await readdir(paths.data)).length!==0){
      throw new Error(`Existing installation preserved: ${paths.data}. Only an empty private data directory owned by the current user can be reused.`);
    }
    return directory;
  };
  const existingData=await inspectDataDirectory();
  for(const name of ['polariton-main.service','polariton-environment.service','polariton.target']){try{await lstat(join(paths.services,name));throw new Error(`Existing user service preserved: ${name}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  await invoke('git',['--version'],source);await invoke('npm',['--version'],source);await invoke('systemctl',['--user','show','--property=Version','--value'],source);
  await mkdir(paths.releases,{recursive:true,mode:0o700});await mkdir(paths.cache,{recursive:true,mode:0o700});
  const release=join(paths.releases,manifest.version),staging=await mkdtemp(join(paths.releases,'.install-'));
  let published=false;
  const created:string[]=[];
  try{
    for(const entry of manifest.files){const target=join(staging,entry.path);await mkdir(dirname(target),{recursive:true});await copyFile(join(source,entry.path),target);await chmod(target,entry.mode);}
    await copyFile(join(source,'release.json'),join(staging,'release.json'));
    await invoke('npm',['ci','--cache',join(paths.cache,'npm'),'--no-audit','--no-fund'],staging);
    await invoke('npm',['run','build'],staging);
    await invoke('npm',['test'],staging);
    // Config owners validate defaults and calculate the same drain bounds used by
    // interactive shutdown. Import only the freshly built, pinned installation.
    const appModule=await import(pathToFileURL(join(staging,'src/config.ts')).href) as typeof import('./config.ts');
    const rackModule=await import(pathToFileURL(join(staging,'src/environment/daemon.ts')).href) as typeof import('./environment/daemon.ts');
    const harnessSettings=await import(pathToFileURL(join(staging,'harness/settings.ts')).href) as typeof import('../harness/settings.ts');
    const app=await appModule.loadConfig(join(staging,'config/app.json'));
    const rack=await rackModule.loadRackConfig(join(staging,'config/environment.json'));
    harnessSettings.runtimeSocketPath(paths.runtime,randomUUID(),Math.min(limits.socketPathBytes,app.guardian.socketPathBytes));
    await mkdir(paths.runtime,{recursive:true,mode:0o700});
    const runtime=await lstat(paths.runtime);if(!runtime.isDirectory()||runtime.uid!==process.getuid?.()||(runtime.mode&0o077)!==0)throw new Error('Runtime directory must be private and owned by the current user');
    const socket=join(paths.runtime,'environment.sock');if(Buffer.byteLength(socket)>=limits.socketPathBytes)throw new Error('Runtime directory is too long for Unix sockets; select a shorter XDG_RUNTIME_DIR');
    try{await lstat(release);throw new Error(`Release already exists: ${release}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const appConfig=join(paths.config,'app.json'),environmentConfig=join(paths.config,'environment.json');
    const units=serviceUnits({release,node:await realpath(process.execPath),appConfig,environmentConfig,mainShutdownMs:app.shutdownTimeoutMs,
      environmentShutdownMs:rack.runtimeStartupTimeoutMs+rack.operationTimeoutMs+rack.startupTimeoutMs+rack.shutdownTimeoutMs*(rack.maxMounts+1),limits});
    // Let the target service manager parse its own format before publishing any
    // installation. Scalar paths and command words have different quoting rules.
    const unitCheck=await mkdtemp(join(paths.releases,'.units-'));
    try{
      for(const [name,content] of Object.entries(units))await writeFile(join(unitCheck,name),content);
      await invoke('systemd-analyze',['--user','verify',...Object.keys(units).map(name=>join(unitCheck,name))],staging);
    }finally{await rm(unitCheck,{recursive:true,force:true});}
    // Building can take minutes. Refuse new data or replacement of the directory
    // inspected before invoking tools, before publishing any configuration.
    const currentData=await inspectDataDirectory();
    if(currentData?.dev!==existingData?.dev||currentData?.ino!==existingData?.ino)throw new Error(`Existing installation preserved: ${paths.data}. Data directory changed during installation.`);
    await rename(staging,release);published=true;
    for(const directory of [paths.config,...(existingData?[]:[paths.data])]){await mkdir(dirname(directory),{recursive:true,mode:0o700});await mkdir(directory,{mode:0o700});created.push(directory);}
    await mkdir(paths.services,{recursive:true,mode:0o700});

    const original=JSON.parse(await readFile(join(release,'config/app.json'),'utf8')) as Record<string,unknown>;
    const appDocument={...original,stateRoot:join(paths.data,'app'),environmentConfig,runtimeDirectory:paths.runtime};
    const executablePaths=[...new Set([dirname(await realpath(process.execPath)),...rack.executablePaths])];
    const environmentDocument={executablePaths,stateRoot:join(paths.data,'environment'),socketPath:socket,dockerContext:'polariton',dockerConfig:join(paths.data,'environment','docker'),dockerSocket:'/var/run/docker.sock',runtime:{kind:'external'}};
    await writeFile(appConfig,JSON.stringify(appDocument,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(environmentConfig,JSON.stringify(environmentDocument,null,2)+'\n',{flag:'wx',mode:0o600});

    for(const [name,content] of Object.entries(units)){const path=join(paths.services,name);await writeFile(path,content,{flag:'wx',mode:0o600});created.push(path);}
    await writeFile(join(paths.config,'installation.json'),JSON.stringify({format:1,version:manifest.version,release,profile:host.profile,qualification:'not-established-by-installation'},null,2)+'\n',{flag:'wx',mode:0o600});
    await invoke('systemctl',['--user','daemon-reload'],release);
    return {release,config:appConfig,target:'polariton.target'};
  }catch(error){
    for(const path of created.reverse())await rm(path,{recursive:true,force:true});
    if(published)await rm(release,{recursive:true,force:true});
    throw error;
  }finally{if(!published)await rm(staging,{recursive:true,force:true});}
}
