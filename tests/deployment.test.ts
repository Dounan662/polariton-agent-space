import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access,appendFile,chmod,lstat,mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRelease,inspectRelease,installationPaths,installRelease,serviceUnits} from '../src/deployment.ts';

const execute=promisify(execFile),source=fileURLToPath(new URL('../',import.meta.url));
const installationHost=()=>({profile:'ubuntu-24.04-amd64' as const,nodeVersion:'24.21.0'});
const version:string=JSON.parse(await readFile(join(source,'package.json'),'utf8')).version;
async function bundle(t:{after:(fn:()=>Promise<void>)=>void}){
  const root=await mkdtemp('/tmp/polariton-deployment-');t.after(()=>rm(root,{recursive:true,force:true}));
  // Model the short system runtime directory separately from long release paths.
  const runtime=await mkdtemp('/tmp/p-run-');t.after(()=>rm(runtime,{recursive:true,force:true}));
  const packaged=await createRelease(source,join(root,'archives'),version);
  await execute('tar',['-xzf',packaged.archive,'-C',root]);
  return {root,runtime,source:join(root,`polariton-${version}`),packaged};
}

test('source release has verifiable integrity and excludes installation state and raw evidence',async t=>{
  const f=await bundle(t),release=await inspectRelease(f.source);
  assert.equal(release.version,version);assert.match(f.packaged.sha256,/^[a-f0-9]{64}$/);
  assert(release.files.some(entry=>entry.path==='harness/polariton-prompt.json'));
  assert(release.files.some(entry=>entry.path==='skills/make-polariton-tool/SKILL.md'));
  assert(release.files.every(entry=>!entry.path.startsWith('skills/operate-labra/')));
  assert(release.files.every(entry=>!/(^|\/)(node_modules|\.env|\.local|\.cache)(\/|$)/.test(entry.path)));
  for(const required of ['LICENSE','THIRD_PARTY_NOTICES.md','README.md','CONTRIBUTING.md','SECURITY.md','docs/GETTING_STARTED.md','docs/MAINTAINING.md','docs/STORAGE.md','docs/ARCHITECTURE.md','docs/COMPATIBILITY.md'])assert(release.files.some(entry=>entry.path===required),`Missing public release documentation: ${required}`);
  assert(release.files.every(entry=>!/^docs\/(?:evidence|adr|research|future_updates)\//.test(entry.path)));
  const path=join(f.source,'src/caller.ts'),original=await readFile(path);
  await appendFile(path,'\n// Changed after packaging\n');
  await assert.rejects(inspectRelease(f.source),/integrity check failed/);
  await writeFile(path,original);await writeFile(join(f.source,'.env'),'PRIVATE_SENTINEL');
  await assert.rejects(inspectRelease(f.source),/undeclared files/);
});

test('release traversal rejects linked source and never follows it outside the source boundary',async t=>{
  const f=await bundle(t);await symlink('/etc/passwd',join(f.source,'src/external.ts'));
  await assert.rejects(createRelease(f.source,join(f.root,'bad'),version),/regular file or directory/);
});

test('installation paths honor absolute XDG overrides and are stable across releases',()=>{
  const paths=installationPaths({XDG_STATE_HOME:'/state',XDG_CONFIG_HOME:'/config',XDG_RUNTIME_DIR:'/run/user/1001'},'/home/scientist',1001);
  assert.equal(paths.state,'/state/polariton');assert.equal(paths.config,'/config/polariton');assert.match(paths.runtime,/^\/run\/user\/1001\/polariton\/[a-f0-9]{16}$/);
  assert.equal(paths.releases,'/home/scientist/.local/share/polariton/releases');
  assert.equal(installationPaths({XDG_STATE_HOME:'relative'},'/home/scientist',1001).state,'/home/scientist/.local/state/polariton');
  assert.equal(paths.data,'/home/scientist/.local/share/polariton/data');
});

for(const profile of ['ubuntu-24.04-amd64','ubuntu-26.04-amd64'] as const)test(`${profile} installation publishes peer services after verification and preserves later state`,async t=>{
  const installationHost=()=>({profile,nodeVersion:'24.21.0'});
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  const commands:string[][]=[];
  const result=await installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    commands.push([command,...args]);
    // The dependency installer is an adjacent boundary: use the test host's
    // dependencies while real release config owners validate generated files.
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
  }});
  assert.equal(JSON.parse(await readFile(join(paths.config,'installation.json'),'utf8')).profile,profile);
  const app=JSON.parse(await readFile(join(paths.config,'app.json'),'utf8'));
  assert.equal(app.stateRoot,join(paths.data,'app'));assert.equal('credentialFile' in app,false);
  await assert.rejects(access(join(paths.config,'credentials.env')),{code:'ENOENT'});
  const environment=JSON.parse(await readFile(join(paths.config,'environment.json'),'utf8'));
  assert(environment.executablePaths.includes(dirname(process.execPath)));
  assert(!app.stateRoot.startsWith(result.release));assert.equal(app.runtimeDirectory,paths.runtime);
  const unit=await readFile(join(paths.services,'polariton-main.service'),'utf8');
  assert(unit.includes('src/main.ts'));assert(!unit.includes('src/system.ts'));assert(unit.includes('KillMode=mixed'));
  assert(unit.includes(`Environment="PATH=${dirname(process.execPath)}:`));
  assert(!unit.includes('--env-file'));assert(!unit.includes('EnvironmentFile='));
  assert(commands.some(args=>args[0]==='systemctl'&&args.includes('daemon-reload')));
  assert(!commands.some(args=>args.includes('start')||args.includes('enable')));
  await writeFile(join(paths.data,'retained-research'),'keep');
  await writeFile(join(paths.config,'credentials.env'),'RETAINED_OPERATOR_SENTINEL',{mode:0o600});
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async()=>{throw new Error('Must not execute on an existing installation');}}),/Existing installation preserved/);
  assert.equal(await readFile(join(paths.data,'retained-research'),'utf8'),'keep');
  assert.equal(await readFile(join(paths.config,'credentials.env'),'utf8'),'RETAINED_OPERATOR_SENTINEL');
});

test('a dependency/build failure leaves no active installation or partially published services',async t=>{
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async(command,args)=>{if(command==='npm'&&args[0]==='ci')throw new Error('registry unavailable');}}),/registry unavailable/);
  for(const path of [paths.config,paths.data,join(paths.services,'polariton-main.service'),join(paths.releases,version)])await assert.rejects(access(path),{code:'ENOENT'});
});

for(const failure of [false,true])test(`a private empty verification data root is preserved when installation ${failure?'rolls back':'succeeds'}`,async t=>{
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  await mkdir(paths.data,{recursive:true,mode:0o700});
  const before=await lstat(paths.data);
  const installation=installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
    if(failure&&command==='systemctl'&&args.includes('daemon-reload'))throw new Error('reload failed');
  }});
  if(failure)await assert.rejects(installation,/reload failed/);else await installation;
  const after=await lstat(paths.data);
  assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
  assert.equal(after.mode,before.mode);assert.deepEqual(await readdir(paths.data),[]);
  if(failure)for(const path of [paths.config,join(paths.services,'polariton-main.service'),join(paths.releases,version)])await assert.rejects(access(path),{code:'ENOENT'});
  else assert.equal(JSON.parse(await readFile(join(paths.config,'app.json'),'utf8')).stateRoot,join(paths.data,'app'));
});

test('preexisting data is refused before commands unless it is an empty private real directory',async t=>{
  const f=await bundle(t);
  for(const kind of ['nonempty','public','symlink','file','legacy-state','configuration']){
    const paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,kind),process.getuid?.());
    await mkdir(dirname(paths.data),{recursive:true});
    if(kind==='symlink')await symlink(f.runtime,paths.data);
    else if(kind==='file')await writeFile(paths.data,'preserved');
    else{
      await mkdir(paths.data,{mode:0o700});
      if(kind==='nonempty')await writeFile(join(paths.data,'research'),'preserved');
      if(kind==='public')await chmod(paths.data,0o755);
      if(kind==='legacy-state')await mkdir(paths.state,{recursive:true,mode:0o700});
      if(kind==='configuration')await mkdir(paths.config,{recursive:true,mode:0o700});
    }
    await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async()=>assert.fail('Preflight must refuse before running commands')}),/Existing installation preserved/);
    if(kind==='nonempty')assert.equal(await readFile(join(paths.data,'research'),'utf8'),'preserved');
    if(kind==='file')assert.equal(await readFile(paths.data,'utf8'),'preserved');
    if(kind==='symlink')assert.equal((await lstat(paths.data)).isSymbolicLink(),true);
  }
});

test('data arriving during the build is preserved and prevents configuration publication',async t=>{
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  await mkdir(paths.data,{recursive:true,mode:0o700});
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
    if(command==='systemd-analyze')await writeFile(join(paths.data,'research'),'arrived during installation');
  }}),/Existing installation preserved/);
  assert.equal(await readFile(join(paths.data,'research'),'utf8'),'arrived during installation');
  for(const path of [paths.config,join(paths.services,'polariton-main.service'),join(paths.releases,version)])await assert.rejects(access(path),{code:'ENOENT'});
});

test('an empty data directory substituted during installation is preserved and not adopted',async t=>{
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  await mkdir(paths.data,{recursive:true,mode:0o700});
  const replacement=join(dirname(paths.data),'replacement');await mkdir(replacement,{mode:0o700});
  const expected=await lstat(replacement);
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
    if(command==='systemd-analyze'){
      await rm(paths.data,{recursive:true});
      await rename(replacement,paths.data);
    }
  }}),/Data directory changed during installation/);
  assert.equal((await lstat(paths.data)).ino,expected.ino);assert.deepEqual(await readdir(paths.data),[]);
  await assert.rejects(access(paths.config),{code:'ENOENT'});
});

test('service commands preserve paths containing spaces, systemd specifiers and variable characters',()=>{
  const limits={installTimeoutMs:1,commandOutputBytes:1,serviceRestartMs:2500,serviceStartLimitMs:60000,serviceStartLimitBurst:3,socketPathBytes:100};
  const units=serviceUnits({release:'/home/a researcher/100%/$release',node:'/home/a researcher/100%/$runtime/node',appConfig:'/config/app.json',environmentConfig:'/config/environment.json',mainShutdownMs:15000,environmentShutdownMs:675000,limits});
  assert(units['polariton-main.service']!.includes('100%%/$$release/src/main.ts'));
  assert(units['polariton-main.service']!.includes('TimeoutStopSec=15000ms'));
  assert(units['polariton-main.service']!.includes('Environment="PATH=/home/a researcher/100%%/$runtime:'));
  assert(units['polariton-main.service']!.includes('WorkingDirectory=/home/a researcher/100%%/$release\n'));
  assert(units['polariton-environment.service']!.includes('TimeoutStopSec=675000ms'));
  assert(!units['polariton-main.service']!.includes('Requires=polariton-environment'));
});


test('installation timeout kills the command foreground group before rollback',async t=>{
  const f=await bundle(t),limitsPath=join(f.source,'config/deployment.json');
  const limits=JSON.parse(await readFile(limitsPath,'utf8'));limits.installTimeoutMs=1000;
  await writeFile(limitsPath,JSON.stringify(limits));
  const manifestPath=join(f.source,'release.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.files.find((entry:{path:string})=>entry.path==='config/deployment.json').sha256=createHash('sha256').update(await readFile(limitsPath)).digest('hex');
  await writeFile(manifestPath,JSON.stringify(manifest));
  const commands=join(f.root,'commands'),receipt=join(f.root,'processes.json');await mkdir(commands);
  await writeFile(join(commands,'git'),`#!${process.execPath}\nconst {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);\n`);
  await chmod(join(commands,'git'),0o755);
  const prior=process.env.PATH;process.env.PATH=commands+':'+prior;t.after(()=>{process.env.PATH=prior;});
  await assert.rejects(installRelease(f.source,{paths:installationPaths({},join(f.root,'home'),process.getuid?.()),host:installationHost}),/command exceeded its deadline/);
  const pids:number[]=JSON.parse(await readFile(receipt,'utf8'));
  for(const pid of pids){
    let state='';try{state=(await execute('ps',['-o','stat=','-p',String(pid)])).stdout.trim();}catch(error){assert.equal((error as {code:number}).code,1);}
    assert(!state||state.startsWith('Z'),`Timed-out installation process ${pid} remains running: ${state}`);
  }
});


test('installation rejects a runtime directory that fits the daemon socket but exceeds guardian capacity',async t=>{
  const f=await bundle(t),runtime=join(f.root,'r'.repeat(32));
  assert(Buffer.byteLength(join(runtime,'environment.sock'))<100);
  const paths={...installationPaths({},join(f.root,'home'),process.getuid?.()),runtime};
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
  }}),/too long for guardian Unix sockets/);
  for(const path of [paths.config,paths.data,join(paths.services,'polariton-main.service')])await assert.rejects(access(path),{code:'ENOENT'});
});


test('unsupported installer OS or Node versions fail before commands or installation writes',async t=>{
  const f=await bundle(t),paths=installationPaths({},join(f.root,'home'),process.getuid?.());
  for(const host of [{profile:'macos-arm64' as const,nodeVersion:'24.21.0'},...['24.11.0','23.99.0','25.0.0'].map(nodeVersion=>({profile:'ubuntu-24.04-amd64' as const,nodeVersion}))]){
    await assert.rejects(installRelease(f.source,{paths,host:()=>host,run:async()=>{assert.fail('An unsupported installation must not execute commands');}}),/requires/);
    for(const path of [paths.config,paths.data,paths.releases])await assert.rejects(access(path),{code:'ENOENT'});
  }
});


test('target service parser rejection prevents installation publication',async t=>{
  const f=await bundle(t),paths=installationPaths({XDG_RUNTIME_DIR:f.runtime},join(f.root,'home'),process.getuid?.());
  await assert.rejects(installRelease(f.source,{paths,host:installationHost,run:async(command,args,options)=>{
    if(command==='npm'&&args[0]==='ci')await symlink(join(source,'node_modules'),join(options.cwd,'node_modules'));
    if(command==='systemd-analyze')throw new Error('Invalid service unit');
  }}),/Invalid service unit/);
  for(const path of [paths.config,paths.data,join(paths.services,'polariton-main.service'),join(paths.releases,version)])await assert.rejects(access(path),{code:'ENOENT'});
});
