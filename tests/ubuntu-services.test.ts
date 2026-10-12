import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../src/config.ts';
import {mainControl} from '../src/control.ts';
import {executionHost} from '../src/host-support.ts';
import {EnvironmentClient,loadRackConfig} from '../src/environment/daemon.ts';

const enabled=process.env.POLARITON_SERVICE_TESTS==='1',execute=promisify(execFile);

/** Opt-in only: run on the disposable Ubuntu qualification installation. Services
 * must point at the explicit config before any lifecycle operation is admitted. */
test('installed Ubuntu peer services preserve manual-path access, failure isolation and stopped backup recovery',{skip:!enabled,timeout:240000},async t=>{
  assert(['ubuntu-24.04-amd64','ubuntu-26.04-amd64'].includes(executionHost()));
  const configPath=process.env.POLARITON_SERVICE_CONFIG;assert(configPath,'POLARITON_SERVICE_CONFIG must identify a disposable installed configuration');
  const config=await loadConfig(configPath),stateParent=dirname(config.stateRoot);
  const command=async(...args:string[])=>execute('systemctl',['--user',...args],{timeout:config.startupTimeoutMs,maxBuffer:config.maxBodyBytes});
  const nodeDirectory=dirname(await realpath(process.execPath));
  for(const [unit,path] of [['polariton-main.service',configPath],['polariton-environment.service',config.environmentConfig]]){
    const declared=(await command('show',unit!,'--property=ExecStart','--value')).stdout;
    const escaped=path!.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    assert.match(declared,new RegExp('(?:^|[\\s"])'+escaped+'(?=[\\s";]|$)'),`The ${unit} service must own exactly the supplied installation`);
    const environment=(await command('show',unit!,'--property=Environment','--value')).stdout;
    assert(environment.includes(`PATH=${nodeDirectory}:`),`The ${unit} service must resolve the installed Node toolchain`);
  }
  const rackConfig=await loadRackConfig(config.environmentConfig),environment=new EnvironmentClient({...rackConfig,operationTimeoutMs:config.shutdownTimeoutMs});
  assert(rackConfig.executablePaths.includes(nodeDirectory),'Environment executable discovery must include the installed Node toolchain');
  // A target stop acknowledges that target's job before its PartOf peers finish.
  // Naming all owners waits for their jobs and makes stopped-state copy atomic
  // with respect to these services' SQLite shutdown/checkpoint work.
  const stop=async()=>{
    await command('stop','polariton.target','polariton-main.service','polariton-environment.service');
    for(const unit of ['polariton-main.service','polariton-environment.service']){
      assert.equal((await command('show',unit,'--property=ActiveState','--value')).stdout.trim(),'inactive');
      assert.equal((await command('show',unit,'--property=MainPID','--value')).stdout.trim(),'0');
    }
  };
  const environmentReady=async(previous?:number)=>{
    const deadline=performance.now()+config.startupTimeoutMs;let failure:unknown;
    while(performance.now()<deadline){
      try{const health=await environment.call<{pid:number;ready:boolean}>('/v1/health');if(health.ready&&health.pid!==previous)return health.pid;}catch(error){failure=error;}
      await delay(config.interruptPollMs);
    }
    throw new Error('Environment did not become ready within its configured startup budget',{cause:failure});
  };
  // Quarantine uses rename, so its disposable destination must share the state
  // filesystem. Ubuntu may mount /tmp separately; never turn this into copy/delete.
  const root=await mkdtemp(join(dirname(stateParent),'.polariton-services-')),projectRoot=join(root,'project');await mkdir(projectRoot);
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const ready=async()=>{
    const end=performance.now()+config.startupTimeoutMs;
    while(performance.now()<end){try{return await mainControl<{pid:number;launchUrl:string}>(config.stateRoot,'/status',config.shutdownTimeoutMs,config.maxBodyBytes);}catch{await delay(config.interruptPollMs);}}
    throw new Error('Main did not become ready within its configured startup budget');
  };
  const origin=`http://127.0.0.1:${config.port}`;
  const login=async()=>{
    const status=await ready(),token=new URLSearchParams(new URL(status.launchUrl).hash.slice(1)).get('token');
    const response=await fetch(origin+'/api/bootstrap',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token})});
    assert.equal(response.status,200);return {pid:status.pid,cookie:response.headers.get('set-cookie')!.split(';')[0]!};
  };
  await command('start','polariton.target');let owner=await login();
  const api=(path:string,body?:unknown)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:owner.cookie,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await fetch(origin+'/api/projects')).status,401);
  assert.equal((await fetch(origin+'/')).status,200);
  const policy=await api('/api/browser-policy');assert.equal(policy.status,200);const nativePickerAvailable=(await policy.json()).nativePicker.available;assert.equal(typeof nativePickerAvailable,'boolean');
  const id=randomUUID(),created=await api('/api/projects',{id,name:'Ubuntu service recovery fixture',root:projectRoot});assert.equal(created.status,200,await created.text());
  await command('stop','polariton-environment.service');
  assert.equal((await command('is-active','polariton-main.service')).stdout.trim(),'active');assert.equal((await api('/api/projects')).status,200);
  assert.equal((await api('/api/environment/inventory')).status,503);
  await command('start','polariton-environment.service');
  const formerEnvironment=await environmentReady(),mainBeforeEnvironmentCrash=owner.pid;
  await command('kill','--kill-whom=main','--signal=SIGKILL','polariton-environment.service');
  const recoveredEnvironment=await environmentReady(formerEnvironment);assert.notEqual(recoveredEnvironment,formerEnvironment);
  assert.equal((await ready()).pid,mainBeforeEnvironmentCrash);assert.equal((await api('/api/projects')).status,200);assert.equal((await api('/api/environment/inventory')).status,200);
  const former=owner.pid;await command('kill','--kill-whom=main','--signal=SIGKILL','polariton-main.service');
  const deadline=performance.now()+config.startupTimeoutMs;
  while(performance.now()<deadline){await delay(config.interruptPollMs);try{const current=await ready();if(current.pid!==former)break;}catch{}}
  owner=await login();assert.notEqual(owner.pid,former);assert((await (await api('/api/projects')).json()).some((project:{id:string})=>project.id===id));
  await stop();
  const backup=join(root,'backup');
  await cp(stateParent,join(backup,'state'),{recursive:true});await cp(dirname(configPath),join(backup,'configuration'),{recursive:true});
  // Application rollback never overwrites research files changed after backup.
  const external=join(projectRoot,'newer-research.txt');await writeFile(external,'preserve external work');
  await rename(stateParent,join(root,'retired-state'));await cp(join(backup,'state'),stateParent,{recursive:true});
  await command('start','polariton.target');owner=await login();
  assert((await (await api('/api/projects')).json()).some((project:{id:string})=>project.id===id));
  assert.equal(await readFile(external,'utf8'),'preserve external work');
  t.diagnostic(JSON.stringify({gate:'ubuntu-installed-services',manualPathAccess:true,installedNodeDiscovery:true,nativePickerAvailable,independentEnvironmentFailure:true,environmentCrashRecovery:true,mainCrashRecovery:true,stoppedStateRestore:true,researchFilesPreserved:true,providerRequests:0}));
});
