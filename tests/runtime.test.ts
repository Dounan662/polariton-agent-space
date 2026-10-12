import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,readFile,access,chmod} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {command} from '../src/environment/backend.ts';
import {ContainerRuntime,type RuntimeCommand} from '../src/environment/runtime.ts';
import {RackConfig,RackFault} from '../src/environment/contracts.ts';
import {EnvironmentRack,type RackBackend} from '../src/environment/rack.ts';
import {loadRackConfig,createEnvironmentDaemon} from '../src/environment/daemon.ts';

function fixture(external=false){
 const config=RackConfig.parse({stateRoot:'/state',socketPath:'/rack.sock',dockerConfig:'/private/docker',dockerContext:'polariton-engine',dockerSocket:'/host/.colima/polariton/docker.sock',runtime:external?{kind:'external'}:{kind:'colima',profile:'polariton'},runtimeStartupTimeoutMs:100});
 const state={profiles:[{name:'polariton',runtime:'docker',status:'Stopped'}],engine:{ServerVersion:'29.6.0',OSType:'linux',SecurityOptions:['name=seccomp'],MemoryLimit:true,CpuCfsQuota:true,PidsLimit:true},socket:true,context:undefined as string|undefined,now:0,infoFailure:false,startFailure:undefined as Error|undefined,startGate:undefined as Promise<void>|undefined};
 const calls:Array<{executable:string;args:string[];timeout:number}>=[];
 const run:RuntimeCommand=async(executable,args,timeout)=>{
  calls.push({executable,args,timeout});
  if(executable==='colima'){
   if(args[0]==='list')return Buffer.from(state.profiles.map(profile=>JSON.stringify(profile)).join('\n'));
   assert.deepEqual(args,['start','--profile','polariton','--activate=false','--save-config=false']);
   await state.startGate;if(state.startFailure)throw state.startFailure;state.profiles[0]!.status='Running';return Buffer.alloc(0);
  }
  assert.equal(executable,'docker');
  const contextIndex=args.indexOf('context');
  if(contextIndex>=0){
   assert.deepEqual(args.slice(0,contextIndex),['--config','/private/docker','--context','default']);
   const operation=args[contextIndex+1];
   if(operation==='ls')return Buffer.from(state.context?'"polariton-engine"\n':'');
   if(operation==='create'){state.context=args.at(-1)!.slice('host='.length);return Buffer.alloc(0);}
   if(operation==='inspect')return Buffer.from(JSON.stringify(state.context));
   throw new Error(`Unexpected metadata mutation ${operation}`);
  }
  assert.deepEqual(args,['--config','/private/docker','--context','polariton-engine','info','--format','{{json .}}']);
  if(state.infoFailure)throw new RackFault('ENGINE_UNAVAILABLE','Configured engine stopped');
  return Buffer.from(JSON.stringify(state.engine));
 };
 const io={now:()=>state.now,home:()=>'/host',socket:async()=>state.socket,directory:async()=>{}};
 return {config,state,calls,run,io,runtime:new ContainerRuntime(config,run,io)};
}

test('owned runtime preparation shares one bounded start and never changes the active context or saved profile',async()=>{
 const f=fixture();let release!:()=>void;f.state.startGate=new Promise<void>(resolve=>{release=resolve;});
 const first=f.runtime.ready({start:true}),second=f.runtime.ready({start:true});assert.equal(first,second);
 release();await Promise.all([first,second]);
 assert.equal(f.calls.filter(call=>call.executable==='colima'&&call.args[0]==='start').length,1);
 assert.equal(f.state.context,'unix:///host/.colima/polariton/docker.sock');
 assert(f.calls.every(call=>call.timeout>0&&call.timeout<=f.config.runtimeStartupTimeoutMs));
 const before=f.calls.length;await f.runtime.ready();assert(f.calls.length>before,'Successful health is never cached indefinitely');
 f.state.profiles[0]!.status='Stopped';await assert.rejects(f.runtime.ready(),{code:'RUNTIME_STOPPED'});
 assert.equal(f.calls.filter(call=>call.args[0]==='start').length,1,'Access checks cannot restart a stopped runtime');
 await f.runtime.ready({start:true});assert.equal(f.calls.filter(call=>call.args[0]==='start').length,2);
});

test('external runtimes are check-only even during explicit preparation',async()=>{
 const f=fixture(true);await f.runtime.ready({start:true});assert(f.calls.every(call=>call.executable==='docker'));
 f.state.infoFailure=true;await assert.rejects(f.runtime.ready({start:true}),{code:'ENGINE_UNAVAILABLE'});
 f.state.infoFailure=false;await f.runtime.ready();assert(f.calls.every(call=>call.executable==='docker'));
});

test('engine readiness refuses unenforced limits and rootless profiles without switching engines',async()=>{
 const f=fixture(true);f.state.engine.MemoryLimit=false;
 await assert.rejects(f.runtime.ready(),{code:'ENGINE_LIMITS'});
 f.state.engine.MemoryLimit=true;f.state.engine.SecurityOptions.push('name=rootless');
 await assert.rejects(f.runtime.ready(),{code:'ENGINE_UNQUALIFIED'});
 assert(f.calls.every(call=>call.executable==='docker'));
 assert(!f.calls.some(call=>call.args.includes('use')||call.args.includes('update')));
});

for(const condition of ['missing','wrong-runtime','wrong-socket','missing-software'] as const)test(`runtime ${condition} fails explicitly without provisioning or fallback`,async()=>{
 const f=fixture();let runtime=f.runtime,code:string;
 if(condition==='missing'){f.state.profiles=[];code='RUNTIME_PROFILE_MISSING';}
 else if(condition==='wrong-runtime'){f.state.profiles[0]!.runtime='containerd';code='RUNTIME_PROFILE_CONFLICT';}
 else if(condition==='wrong-socket'){runtime=new ContainerRuntime({...f.config,dockerSocket:'/other/docker.sock'},f.run,f.io);code='RUNTIME_CONFIGURATION';}
 else{runtime=new ContainerRuntime(f.config,async()=>{throw Object.assign(new Error('Absent'),{code:'ENOENT'});},f.io);code='RUNTIME_SOFTWARE_MISSING';}
 await assert.rejects(runtime.ready({start:true}),{code});assert(!f.calls.some(call=>call.args[0]==='start'));
});

test('timed-out startup reports uncertainty and a new explicit attempt first observes actual profile state',async()=>{
 const f=fixture();f.state.startFailure=new RackFault('COMMAND_TIMEOUT','colima exceeded its deadline');
 await assert.rejects(f.runtime.ready({start:true}),error=>error instanceof RackFault&&error.code==='RUNTIME_START_UNCERTAIN'&&error.message.includes('COMMAND_TIMEOUT'));
 f.state.profiles[0]!.status='Starting';await assert.rejects(f.runtime.ready({start:true}),{code:'RUNTIME_STARTING'});
 assert.equal(f.calls.filter(call=>call.args[0]==='start').length,1);
 f.state.profiles[0]!.status='Stopped';f.state.startFailure=undefined;await f.runtime.ready({start:true});
 assert.equal(f.calls.filter(call=>call.args[0]==='start').length,2);
});

test('one overall deadline bounds readiness after startup, and a later call rechecks health',async()=>{
 const f=fixture(),runtime=new ContainerRuntime(f.config,async(executable,args,...rest)=>{const result=await f.run(executable,args,...rest);if(executable==='colima'&&args[0]==='start')f.state.now=101;return result;},f.io);
 await assert.rejects(runtime.ready({start:true}),{code:'RUNTIME_TIMEOUT'});
 assert(!f.calls.some(call=>call.args.includes('info')));await runtime.ready();
});

test('a conflicting private context is never redirected',async()=>{
 const f=fixture();f.state.profiles[0]!.status='Running';f.state.context='unix:///another-engine.sock';
 await assert.rejects(f.runtime.ready({start:true}),{code:'DOCKER_CONTEXT_CONFLICT'});
 assert(!f.calls.some(call=>call.args.includes('create')||call.args.includes('update')||call.args.includes('use')||call.args.includes('info')));
});

test('runtime ownership is explicit and loaded socket paths match the configured profile',async t=>{
 assert.equal(RackConfig.parse({stateRoot:'/state',socketPath:'/socket'}).runtime.kind,'external');
 assert.throws(()=>RackConfig.parse({stateRoot:'/state',socketPath:'/socket',runtime:{kind:'colima',profile:'default'}}));
 assert.throws(()=>RackConfig.parse({stateRoot:'/state',socketPath:'/socket',runtime:{kind:'colima',profile:'polariton'}}));
 const root=await mkdtemp(join(tmpdir(),'polariton-runtime-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'environment.json');await writeFile(path,JSON.stringify({stateRoot:'state',socketPath:'rack.sock',dockerConfig:'docker',dockerSocket:'~/.colima/polariton/docker.sock',runtime:{kind:'colima',profile:'polariton'},runtimeStartupTimeoutMs:123}));
 const config=await loadRackConfig(path);assert.equal(config.dockerSocket,join(homedir(),'.colima/polariton/docker.sock'));assert.equal(config.dockerConfig,join(root,'docker'));assert.equal(config.runtimeStartupTimeoutMs,123);
});

test('environment restart recreates an ephemeral private socket directory and refuses a shared parent',async t=>{
 const root=await mkdtemp('/tmp/polariton-environment-runtime-');t.after(()=>rm(root,{recursive:true,force:true}));
 const socketPath=join(root,'run','environment.sock'),config=RackConfig.parse({stateRoot:join(root,'state'),socketPath});
 let daemon=await createEnvironmentDaemon(config);await daemon.app.close();
 await rm(join(root,'run'),{recursive:true,force:true});
 daemon=await createEnvironmentDaemon(config);await daemon.app.close();
 await chmod(join(root,'run'),0o755);
 await assert.rejects(createEnvironmentDaemon(config),{code:'SOCKET_DIRECTORY'});
});

test('administrative runtime errors survive operation persistence and receipt reads',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-runtime-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=RackConfig.parse({stateRoot:root,socketPath:join(root,'rack.sock')}),starts:boolean[]=[];
 const backend:RackBackend={ready:async options=>{starts.push(Boolean(options?.start));throw new RackFault('RUNTIME_PROFILE_MISSING','Provision the dedicated profile');},owned:async()=>[],remove:async()=>{},install:async()=>{throw new Error('Must not build');},publishAuthority:async()=>{},start:async()=>{throw new Error('Must not launch');},inspect:async()=>null};
 let rack=await new EnvironmentRack(config,()=>backend).open();
 try{
  await assert.rejects(rack.execute({kind:'mount.create',operationId:'request',id:'mount',component:{id:'component',name:'Component',releaseId:'release',configuration:{}}}),{code:'RUNTIME_PROFILE_MISSING'});
  assert.deepEqual(starts,[true]);assert.equal(rack.operation('request').error?.code,'RUNTIME_PROFILE_MISSING');
  assert.equal(rack.operation('request').attempts[0]!.code,'RUNTIME_PROFILE_MISSING');
  await rack.close();rack=await new EnvironmentRack(config,()=>backend).open();
  assert.equal(rack.operation('request').error?.code,'RUNTIME_PROFILE_MISSING');assert.deepEqual(starts,[true],'Restart does not prepare unused infrastructure');
 }finally{await rack.close();}
});


for(const failure of ['timeout','output'] as const)test(`bounded command ${failure} settles while a helper still owns inherited pipes`,{timeout:10000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-command-bound-')),pidFile=join(root,'helper.pid'),finished=join(root,'helper-finished');
 let helper:number|undefined;
 t.after(async()=>{if(helper)try{process.kill(helper,'SIGKILL');}catch{}await rm(root,{recursive:true,force:true});});
 const child=`setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(finished)},'done');},5000)`;
 const parent=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));${failure==='output'?"process.stdout.write('overflow');":""}setInterval(()=>{},1000);`;
 await assert.rejects(command(process.execPath,['-e',parent],1000,failure==='output'?1:1024),{code:failure==='output'?'OUTPUT_LIMIT':'COMMAND_TIMEOUT'});
 helper=Number(await readFile(pidFile,'utf8'));assert(helper>0);process.kill(helper,0);
 await assert.rejects(access(finished),{code:'ENOENT'},'Command must settle before an inherited-pipe helper exits');
});
