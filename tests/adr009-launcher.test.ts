import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,access,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {temporaryDirectory} from './fixtures/storage.ts';
import {loadConfig} from '../src/config.ts';
import {EnvironmentClient,loadRackConfig} from '../src/environment/daemon.ts';
import {mainControl} from '../src/control.ts';
const exec=promisify(execFile),enabled=process.env.POLARITON_RACK_TESTS==='1';
test('shared startup, duplicate owners, independent Main restart, and Docker-independent registration',{skip:!enabled,timeout:90000},async t=>{
  const base=await temporaryDirectory('polariton-launcher-');
  t.after(()=>rm(base,{recursive:true,force:true}));
  const app=await loadConfig(),environment=await loadRackConfig(process.env.POLARITON_RACK_CONFIG);
  const rackConfig={...environment,stateRoot:join(base,'environment'),socketPath:`/tmp/polariton-launch-${process.pid}.sock`};
  const rackPath=join(base,'environment.json'),appPath=join(base,'app.json');
  await writeFile(rackPath,JSON.stringify(rackConfig));
  const config={...app,stateRoot:join(base,'main'),environmentConfig:rackPath,port:4319,startupTimeoutMs:10000};await writeFile(appPath,JSON.stringify(config));
  const client=new EnvironmentClient(rackConfig),results:unknown[]=[];
  const start=()=>exec(process.execPath,['src/system.ts','start',appPath,'--no-open','--detach'],{timeout:30000});
  const status=()=>mainControl<{pid:number;launchUrl:string}>(config.stateRoot,'/status',config.startupTimeoutMs,config.maxBodyBytes);
  try{
    await start();const main1=await status(),rack1=await client.call<{pid:number}>('/v1/health');
    await start();assert.equal((await status()).pid,main1.pid);assert.equal((await client.call<{pid:number}>('/v1/health')).pid,rack1.pid);results.push({name:'shared-start-duplicate-owners',status:'pass'});
    const origin=`http://127.0.0.1:${config.port}`;
    assert.equal((await fetch(`${origin}/api/environment/inventory`)).status,401);
    const launch=await status(),token=new URLSearchParams(new URL(launch.launchUrl).hash.slice(1)).get('token');
    const login=await fetch(`${origin}/api/bootstrap`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const browserCommand=(command:unknown)=>fetch(`${origin}/api/environment/command`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(command)});
    const published=await browserCommand({kind:'environment.publish',operationId:'browser-export',expectedBase:null,document:{format:2,environmentId:'browser',name:'Browser environment',description:'',components:[]}});assert.equal(published.status,200);
    const exported=await fetch(`${origin}/api/environment/revisions/browser/browser-export`,{headers:{cookie}});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition')!,/attachment; filename="browser-browser-export.json"/);assert.equal((await exported.json()).revisionId,'browser-export');
    const denied=await browserCommand({kind:'binding.create',operationId:'browser-grant',mountId:'unavailable',principal:'browser',access:'call'});assert.equal(denied.status,403);
    results.push({name:'browser-authenticated-export-and-grant-boundary',status:'pass'});
    await mainControl(config.stateRoot,'/stop',config.shutdownTimeoutMs,config.maxBodyBytes);
    const deadline=Date.now()+config.shutdownTimeoutMs;while(true){try{await status();if(Date.now()>deadline)throw new Error('Main failed to stop');await new Promise(r=>setTimeout(r,config.interruptPollMs));}catch(error){if((error as Error).message==='Main failed to stop')throw error;break;}}
    assert.equal((await client.call<{pid:number}>('/v1/health')).pid,rack1.pid);await start();assert.notEqual((await status()).pid,main1.pid);assert.equal((await client.call<{pid:number}>('/v1/health')).pid,rack1.pid);results.push({name:'independent-main-restart',status:'pass'});
  }finally{await exec(process.execPath,['src/system.ts','stop',appPath],{timeout:30000}).catch(()=>{});}
  const partialRack={...rackConfig,stateRoot:join(base,'bad-environment'),socketPath:`/tmp/polariton-partial-${process.pid}.sock`,dockerContext:'polariton-nonexistent-verification-context',dockerSocket:undefined};
  await writeFile(rackPath,JSON.stringify(partialRack));await writeFile(appPath,JSON.stringify({...config,startupTimeoutMs:3000}));
  try{
    await start();assert.ok((await status()).pid);
    const independent=new EnvironmentClient(partialRack);assert.equal((await independent.call<{ready:boolean}>('/v1/health')).ready,true);
    const preview=await independent.call<{entries:unknown[];errors:unknown[]}>('/v1/capabilities/preview',{configuration:{mcpServers:{remote:{url:'https://fixture.invalid/mcp'}}}});assert.deepEqual(preview.errors,[]);
    const imported=await independent.call<{capabilities:Array<{id:string;revisionId:string}>}>('/v1/command',{kind:'capability.import',operationId:'without-docker',entries:preview.entries});
    const capability=imported.capabilities[0]!;
    await independent.call('/v1/command',{kind:'environment.publish',operationId:'external-revision',expectedBase:null,document:{format:2,environmentId:'external',name:'External',description:'',components:[{id:'remote',name:'Remote',definition:{capabilityId:capability.id,revisionId:capability.revisionId}}]}});
    const prepared=await independent.call<{status:string}>('/v1/command',{kind:'environment.apply',operationId:'external-apply',environmentId:'external',revisionId:'external-revision'});assert.equal(prepared.status,'ready');
    const grant=await independent.acquire({id:'external-worker',owner:'main',principal:'worker',workspace:base,environment:{environmentId:'external',revisionId:'external-revision',name:'External'},requireHead:true});assert.equal(grant.servers.length,1);await independent.release({id:grant.id,owner:'main'});
    const repository=join(base,'unavailable-managed');await mkdir(repository);await exec('git',['init','--quiet',repository]);
    await independent.call('/v1/command',{kind:'capability.register',operationId:'managed-registration',id:'managed',repository});
    await assert.rejects(independent.call('/v1/command',{kind:'release.install',operationId:'managed-install',packageId:'managed',commit:'1'.repeat(40)}),{code:'COMMAND_FAILED'});
    assert.equal((await independent.call<{ready:boolean}>('/v1/health')).ready,true);
    results.push({name:'docker-outage-preserves-registration-and-external-access',status:'pass'});
  }finally{await exec(process.execPath,['src/system.ts','stop',appPath],{timeout:30000}).catch(()=>{});t.diagnostic(JSON.stringify(results));}
});


/** A process-group signal matches a terminal Ctrl+C through npm and its script shell.
 * Peers have their own groups; only the launcher can complete whole-system cleanup. */
test('npm start stays attached and signals stop fresh, reused and partially started peers', {skip:!enabled,timeout:120000}, async t => {
  const base=await temporaryDirectory('polariton-foreground-');
  const app=await loadConfig(), environment=await loadRackConfig(process.env.POLARITON_RACK_CONFIG);
  const rackConfig={...environment,stateRoot:join(base,'environment'),socketPath:`/tmp/polariton-foreground-${process.pid}.sock`};
  const rackPath=join(base,'environment.json'),appPath=join(base,'app.json');
  const config={...app,stateRoot:join(base,'main'),environmentConfig:rackPath,port:4329,startupTimeoutMs:10000};
  await writeFile(rackPath,JSON.stringify(rackConfig)); await writeFile(appPath,JSON.stringify(config));
  const rack=new EnvironmentClient(rackConfig),checks:unknown[]=[];
  const status=()=>mainControl<{pid:number}>(config.stateRoot,'/status',config.startupTimeoutMs,config.maxBodyBytes);
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
  const wait=async(predicate:()=>boolean|Promise<boolean>)=>{const end=Date.now()+30000;while(!await predicate()){assert.ok(Date.now()<end,'Lifecycle condition exceeded its deadline');await new Promise(r=>setTimeout(r,config.interruptPollMs));}};
  const launch=()=>{
    const child=spawn('npm',['start','--',appPath,'--no-open'],{detached:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{output+=value;});
    const exit=new Promise<void>((resolveExit,reject)=>{child.once('error',reject);child.once('exit',()=>resolveExit());});
    return {child,exit,output:()=>output,signal:(signal:NodeJS.Signals)=>process.kill(-child.pid!,signal)};
  };
  let current:ReturnType<typeof launch>|undefined;
  t.after(async()=>{
    if(current&&current.child.exitCode===null&&current.child.signalCode===null)current.signal('SIGTERM');
    await exec(process.execPath,['src/system.ts','stop',appPath],{timeout:30000}).catch(()=>{});
    t.diagnostic(JSON.stringify(checks));await rm(base,{recursive:true,force:true});
  });
  for(const reuse of [false,true]){
    if(reuse)await exec(process.execPath,['src/system.ts','start',appPath,'--no-open','--detach'],{timeout:30000});
    const before=reuse?[(await status()).pid,(await rack.call<{pid:number}>('/v1/health')).pid]:null;
    current=launch();await wait(()=>current!.output().includes('Press Ctrl+C to stop both daemons.'));
    assert.equal(current.child.exitCode,null);assert.equal(current.child.signalCode,null);
    const pids=[(await status()).pid,(await rack.call<{pid:number}>('/v1/health')).pid];if(before)assert.deepEqual(pids,before);
    current.signal('SIGINT');await current.exit;await wait(()=>pids.every(pid=>!alive(pid)));
    await assert.rejects(status());await assert.rejects(rack.call('/v1/health'));
    checks.push({name:reuse?'ctrl-c-stops-reused-peers':'ctrl-c-stops-fresh-peers',status:'pass'});
  }
  current=launch();await wait(()=>current!.output().includes('Press Ctrl+C to stop both daemons.'));
  const pids=[(await status()).pid,(await rack.call<{pid:number}>('/v1/health')).pid];
  current.signal('SIGTERM');await current.exit;await wait(()=>pids.every(pid=>!alive(pid)));
  checks.push({name:'sigterm-stops-both-peers',status:'pass'});

  current=launch();await wait(()=>current!.output().includes('Press Ctrl+C to stop both daemons.'));
  await exec(process.execPath,['src/system.ts','stop',appPath],{timeout:30000});await current.exit;
  checks.push({name:'npm-stop-releases-foreground-launcher',status:'pass'});

  // An admitted real build outlives the old idle-only shutdown allowance.
  await writeFile(rackPath,JSON.stringify({...rackConfig,shutdownTimeoutMs:500,maxMounts:1,operationTimeoutMs:20000}));
  const repository=join(base,'slow-capability');await mkdir(repository);
  await writeFile(join(repository,'lock.json'),'{}');
  await writeFile(join(repository,'polariton-capability.json'),JSON.stringify({format:1,name:'Shutdown fixture',description:'Build drain qualification',image:'node@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152',build:[['node','-e','setTimeout(() => console.log("build drained"), 3000)']],entrypoint:['node','--version'],lockfiles:['lock.json'],configSchema:{type:'object',additionalProperties:false},mcpPath:'/mcp',port:8080,state:'scratch'}));
  await exec('git',['init','--quiet',repository]);await exec('git',['-C',repository,'add','.']);await exec('git',['-C',repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','--quiet','-m','Shutdown build fixture']);
  const commit=(await exec('git',['-C',repository,'rev-parse','HEAD'])).stdout.trim();
  current=launch();await wait(()=>current!.output().includes('Press Ctrl+C to stop both daemons.'));
  await rack.call('/v1/command',{kind:'capability.register',operationId:'shutdown-package',id:'shutdown-package',repository});
  const install=rack.call('/v1/command',{kind:'release.install',operationId:'shutdown-install',packageId:'shutdown-package',commit}).then(value=>({value}),error=>({error}));
  await wait(async()=>{const inventory=await rack.call<{operations:Array<{id:string;state:string}>}>('/v1/inventory');return inventory.operations.some(value=>value.id==='shutdown-install'&&value.state==='running');});
  const buildPid=(await rack.call<{pid:number}>('/v1/health')).pid;
  current.signal('SIGINT');await current.exit;
  const installed=await install;assert.ok('value' in installed,JSON.stringify(installed));
  assert.equal(alive(buildPid),false);assert.match(current.output(),/"environment":\s*\{\s*"state": "stopped"/);
  assert.equal(JSON.parse(await readFile(join(rackConfig.stateRoot,'releases','shutdown-install','release.json'),'utf8')).commit,commit);
  checks.push({name:'ctrl-c-waits-for-admitted-build-before-exiting',status:'pass'});
  await writeFile(rackPath,JSON.stringify(rackConfig));

  // A real listener-path conflict still yields partial readiness; Docker absence no longer does.
  const blockedSocket=`/tmp/polariton-occupied-${process.pid}.sock`;await writeFile(blockedSocket,'User-owned non-socket data');t.after(()=>rm(blockedSocket,{force:true}));
  await writeFile(rackPath,JSON.stringify({...rackConfig,socketPath:blockedSocket}));
  current=launch();await wait(()=>current!.output().includes('Startup incomplete. Ctrl+C stops both daemons.'));
  const partialPid=(await status()).pid;assert.equal(current.child.exitCode,null);
  current.signal('SIGINT');await current.exit;await wait(()=>!alive(partialPid));
  checks.push({name:'ctrl-c-stops-partial-startup',status:'pass'});

  const earlyRoot=join(base,'early-main');await writeFile(appPath,JSON.stringify({...config,stateRoot:earlyRoot}));
  await writeFile(rackPath,JSON.stringify(rackConfig));
  current=launch();await wait(async()=>{try{await access(join(earlyRoot,'main.log'));return true;}catch{return false;}});
  current.signal('SIGINT');await current.exit;
  await assert.rejects(mainControl(earlyRoot,'/status',config.startupTimeoutMs,config.maxBodyBytes));await assert.rejects(rack.call('/v1/health'));
  checks.push({name:'ctrl-c-cancels-inflight-startup',status:'pass'});
});


/** Reset disposable application state without relying on pre-created Docker metadata. */
test('first managed preparation reconstructs a deleted Docker context and refuses endpoint substitution', {skip:!enabled,timeout:60000}, async t => {
  const base=await temporaryDirectory('polariton-reset-'),local=join(base,'data');
  const environment=await loadRackConfig(process.env.POLARITON_RACK_CONFIG),app=await loadConfig();
  assert.ok(environment.dockerSocket,'Qualified configuration declares its engine socket');
  const rackConfig={...environment,stateRoot:join(local,'environment'),dockerConfig:join(local,'docker'),socketPath:`/tmp/polariton-reset-${process.pid}.sock`};
  const rackPath=join(base,'environment.json'),appPath=join(base,'app.json');
  const config={...app,stateRoot:join(local,'main'),environmentConfig:rackPath,port:4339,startupTimeoutMs:10000};
  await writeFile(rackPath,JSON.stringify(rackConfig));await writeFile(appPath,JSON.stringify(config));
  const start=()=>exec(process.execPath,['src/system.ts','start',appPath,'--no-open','--detach'],{timeout:30000});
  const stop=()=>exec(process.execPath,['src/system.ts','stop',appPath],{timeout:30000});
  const client=new EnvironmentClient(rackConfig),checks:unknown[]=[];
  const repository=join(base,'context-capability');await mkdir(repository);
  await writeFile(join(repository,'lock.json'),'{}');
  await writeFile(join(repository,'polariton-capability.json'),JSON.stringify({format:1,name:'Context fixture',description:'Lazy backend qualification',image:'node@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152',build:[],entrypoint:['node','--version'],lockfiles:['lock.json'],configSchema:{type:'object',additionalProperties:false},mcpPath:'/mcp',port:8080,state:'scratch'}));
  await exec('git',['init','--quiet',repository]);await exec('git',['-C',repository,'add','.']);await exec('git',['-C',repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','--quiet','-m','Context preparation fixture']);
  const commit=(await exec('git',['-C',repository,'rev-parse','HEAD'])).stdout.trim();
  const prepare=async(operationId:string)=>{
    await client.call('/v1/command',{kind:'capability.register',operationId:`register-${operationId}`,id:'context-fixture',repository});
    return client.call<{commit:string}>('/v1/command',{kind:'release.install',operationId,packageId:'context-fixture',commit});
  };
  const docker=async(...args:string[])=>(await exec('docker',['--config',rackConfig.dockerConfig,'--context','default','context',...args],{timeout:10000})).stdout.trim();
  t.after(async()=>{await stop().catch(()=>{});t.diagnostic(JSON.stringify(checks));await rm(base,{recursive:true,force:true});});
  for(const reset of [false,true]){
    if(reset)await rm(local,{recursive:true,force:true});
    await start();assert.equal((await client.call<{ready:boolean}>('/v1/health')).ready,true);
    await assert.rejects(docker('inspect',rackConfig.dockerContext));
    assert.equal((await prepare(reset?'prepare-after-reset':'first-preparation')).commit,commit);
    assert.equal(JSON.parse(await docker('inspect',rackConfig.dockerContext,'--format','{{json .Endpoints.docker.Host}}')),`unix://${environment.dockerSocket}`);
    await stop();checks.push({name:reset?'managed-preparation-after-local-reset':'first-managed-preparation-without-context',status:'pass'});
  }
  const wrong='unix:///tmp/polariton-intentionally-wrong.sock';
  await docker('update',rackConfig.dockerContext,'--docker',`host=${wrong}`);
  await start();assert.equal((await client.call<{ready:boolean}>('/v1/health')).ready,true);
  await assert.rejects(prepare('wrong-endpoint'),{code:'DOCKER_CONTEXT_CONFLICT'});
  assert.equal((await client.call<{ready:boolean}>('/v1/health')).ready,true);
  assert.equal(JSON.parse(await docker('inspect',rackConfig.dockerContext,'--format','{{json .Endpoints.docker.Host}}')),wrong);
  checks.push({name:'existing-context-is-never-retargeted',status:'pass'});
});
