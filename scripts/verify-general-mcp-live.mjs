import assert from 'node:assert/strict';
import {appendFile,copyFile,mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';
import {EnvironmentClient,loadRackConfig} from '../src/environment/daemon.ts';
import {readHistory} from '../harness/history.mjs';
import {serveHttp,recorder} from '../tests/fixtures/adr011/server.mjs';

/** Reproducible fixture and evidence boundary. Only --serve --live enables the
 * existing shared provider admission ledger; browser actions are never fabricated.
 * --prepare owns the external HTTP listener until its process is stopped. */
const args=process.argv.slice(2),mode=args[0];
assert(['--prepare','--apply','--cli-import','--serve','--snapshot'].includes(mode),'Expected --prepare, --apply, --cli-import, --serve, or --snapshot LABEL');
const root=sourceRoot,base=join(root,'.local/adr011'),config=await loadConfig(join(root,'config/adr011-app.json'));
const limits=CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8')));
assert.equal(limits.id,'adr011');
const rackConfig=await loadRackConfig(config.environmentConfig),rack=new EnvironmentClient(rackConfig),exec=promisify(execFile);
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const admin=command=>rack.call('/v1/command',command);
const git=async(repository,...argv)=>(await exec('git',['-C',repository,...argv],{timeout:rackConfig.operationTimeoutMs,maxBuffer:rackConfig.maxBodyBytes})).stdout.trim();
await mkdir(base,{recursive:true,mode:0o700});

async function identity(){
  const paths=[];
  async function scan(directory){for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.isFile())paths.push(path);}}
  for(const directory of ['src','web','harness','config','dist','tests/fixtures/adr011'])await scan(directory);
  paths.push('package.json','package-lock.json','scripts/verify-general-mcp-live.mjs','scripts/verify-general-mcp-cases.mjs','scripts/audit-general-mcp-evidence.mjs');
  const files=await Promise.all(paths.sort().map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
  return {digest:sha(JSON.stringify(files)),files,dsh:(await json(join(root,'node_modules/@deepseek-ai/dsh/package.json'))).version};
}

async function prepare(){
  let setup;
  try{setup=await json(join(base,'setup.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!setup){
    const repository=join(base,'capability-source'),fixture=join(root,'tests/fixtures/adr010');await mkdir(repository,{recursive:true});
    for(const name of ['fixture.mjs','server.mjs','test.mjs','version.json','polariton-capability.json','package.json','package-lock.json'])await copyFile(join(fixture,name),join(repository,name));
    await copyFile(join(root,'environment/server.mjs'),join(repository,'server-support.mjs'));
    await git(repository,'init');await git(repository,'add','.');await git(repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','ADR011 managed measurement fixture');
    setup={repository,commit:await git(repository,'rev-parse','HEAD'),seed:randomBytes(24).toString('hex'),port:0,application:join(base,'ControlledApplication.fixture'),createdAt:new Date().toISOString()};
    await save(join(base,'setup.json'),setup);
    await writeFile(setup.application,'ADR011 controlled prerequisite; this is not a named desktop application.\n',{mode:0o600});
    await save(rackConfig.credentialFile,{format:1,credentials:{ADR011_TOKEN:{account:'adr011-researcher',authority:'adr011-external',value:`adr011-private-${randomBytes(24).toString('hex')}`}}});
  }
  const secrets=await json(rackConfig.credentialFile),token=secrets.credentials.ADR011_TOKEN.value;
  const service=await serveHttp({port:setup.port,token,record:recorder(join(base,'external-receipts.jsonl'))});
  setup.port=Number(new URL(service.url).port);setup.endpoint=service.url;await save(join(base,'setup.json'),setup);
  const mcpServers={
    'ADR011 Remote':{url:service.url,headers:{Authorization:'Bearer ${ADR011_TOKEN}'}},
    'ADR011 Local':{command:await realpath(process.execPath),args:[join(root,'tests/fixtures/adr011/server.mjs')],env:{ADR011_RECEIPTS:join(base,'stdio-receipts.jsonl'),ADR011_APPLICATION:setup.application},requirements:{execution:'foreground-host',files:[setup.application],identityFiles:[]}},
  };
  await save(join(base,'mcp-configuration.json'),{mcpServers});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void service.close();});
  console.log(JSON.stringify({prepared:true,repository:setup.repository,configuration:join(base,'mcp-configuration.json'),endpoint:service.url,prerequisite:setup.application,providerRequests:0}));
}

async function cliImport(){
  const configuration=await json(join(base,'mcp-configuration.json'));
  configuration.mcpServers=Object.fromEntries(Object.entries(configuration.mcpServers).map(([name,value])=>[`${name} CLI`,value]));
  const path=join(base,'cli-mcp.json');await save(path,configuration);
  const cliArgs=['bin/harnessctl','--config',config.configPath];
  const file=JSON.parse((await exec(process.execPath,[...cliArgs,'capability','preview','--input',path],{cwd:root,maxBuffer:rackConfig.maxBodyBytes})).stdout).data;
  const stdin=await new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,[...cliArgs,'capability','preview','--input','-'],{cwd:root,stdio:['pipe','pipe','pipe']});let output='',error='';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});child.once('error',reject);child.once('exit',code=>code===0?resolveResult(JSON.parse(output).data):reject(new Error(`CLI preview failed (${code}): ${error}`)));child.stdin.end(JSON.stringify(configuration));
  });
  assert.deepEqual(file,stdin);assert.deepEqual(file.errors,[]);
  const operationId=crypto.randomUUID(),command={entries:file.entries},commandPath=join(base,'cli-import.json');await save(commandPath,command);
  const first=JSON.parse((await exec(process.execPath,[...cliArgs,'capability','import','--details','--request-id',operationId,'--input',commandPath],{cwd:root,maxBuffer:rackConfig.maxBodyBytes})).stdout);
  const replay=JSON.parse((await exec(process.execPath,[...cliArgs,'capability','import','--details','--request-id',operationId,'--input',commandPath],{cwd:root,maxBuffer:rackConfig.maxBodyBytes})).stdout);
  assert.deepEqual(first,replay);await save(join(base,'cli-parity.json'),{passed:true,preview:file,result:first,receiptReplayEqual:true,fileStdinEqual:true});console.log(JSON.stringify({cliParity:true,capabilities:first.data.result.capabilities.map(value=>value.id),providerRequests:0}));
}

async function apply(){
  const setup=await json(join(base,'setup.json')),inventory=await rack.call('/v1/inventory');
  const managed=inventory.capabilities.find(value=>value.kind==='managed'&&value.repository===setup.repository);
  assert(managed,'Add the prepared repository through Capabilities → From repository first');
  const remote=inventory.capabilities.find(value=>value.name==='ADR011 Remote'&&value.kind==='http'),local=inventory.capabilities.find(value=>value.name==='ADR011 Local'&&value.kind==='stdio');
  assert(remote&&local,'Add the prepared MCP configuration through Capabilities → From MCP configuration first');
  const releaseId='adr011-managed-r1';await admin({kind:'release.install',operationId:releaseId,packageId:managed.id,commit:setup.commit});
  const components=[{id:'managed',name:'Managed measurement',releaseId,configuration:{role:'measurement',seed:setup.seed,slowMs:30000}},...[[remote,'remote'],[local,'local']].map(([value,id])=>({id,name:value.name,definition:{capabilityId:value.id,revisionId:value.revisionId}}))];
  const document={format:2,environmentId:'adr011-mixed',name:'ADR011 Mixed',description:'Managed measurement, external HTTP transform and local stdio transform',components};
  const revision=await admin({kind:'environment.publish',operationId:'adr011-mixed-r1',expectedBase:null,document});
  const realization=await admin({kind:'environment.apply',operationId:'adr011-apply-r1',environmentId:document.environmentId,revisionId:revision.revisionId});
  assert.equal(realization.status,'ready',JSON.stringify(realization));
  await save(join(base,'prepared.json'),{revision,realization});console.log(JSON.stringify({ready:true,environment:document.environmentId,providerRequests:0}));
}

async function sanitize(value){
  const secrets=await json(rackConfig.credentialFile);let encoded=JSON.stringify(value,null,2);
  for(const credential of Object.values(secrets.credentials))assert(!encoded.includes(credential.value),'Private credential appeared in evidence; export stopped');
  if(process.env.DEEPSEEK_API_KEY)assert(!encoded.includes(process.env.DEEPSEEK_API_KEY),'Provider credential appeared in evidence; export stopped');
  assert(!/Bearer\s+[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}/i.test(encoded),'Credential-like literal appeared in evidence; export stopped');
  return JSON.parse(encoded.replaceAll(root,'<V5>'));
}

async function snapshot(label){
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(label??''),'Snapshot requires a stable label');const path=join(base,'snapshots',label,'evidence.json');
  await assert.rejects(stat(path),{code:'ENOENT'},'Snapshot evidence is immutable');
  const inventory=await rack.call('/v1/inventory'),invocations=[];
  for(const name of ['external-receipts.jsonl','stdio-receipts.jsonl'])try{for(const line of (await readFile(join(base,name),'utf8')).trim().split('\n').filter(Boolean))invocations.push({source:name,...JSON.parse(line)});}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const mount of inventory.mounts){if(!mount.containerId)continue;
    const {stdout,stderr}=await exec('docker',[...(rackConfig.dockerConfig?['--config',rackConfig.dockerConfig]:[]),'--context',rackConfig.dockerContext,'logs',mount.containerId],{timeout:rackConfig.operationTimeoutMs,maxBuffer:rackConfig.limits.outputBytes});
    for(const line of (stdout+'\n'+stderr).split('\n')){if(!line.startsWith('{'))continue;let value;try{value=JSON.parse(line);}catch{continue;}if(value.fixture==='adr010')invocations.push({...value,source:'managed',mountId:mount.id,generation:mount.generation});}
  }
  const workers=[];let budget=null;
  try{const db=new DatabaseSync(join(config.stateRoot,'agents.sqlite'),{readOnly:true});try{for(const row of db.prepare('SELECT data FROM workers').all()){
    const worker=JSON.parse(row.data),{id,projectId,nodeId,harnessSessionId,title,state,model,environment,error,processId}=worker;
    const cleanupPending=worker.activation?.phase==='cleanup';
    const submissions=db.prepare('SELECT data FROM submissions WHERE worker_id=?').all(id).map(row=>JSON.parse(row.data));
    const history=harnessSessionId?await readHistory(join(config.stateRoot,'harness',id,'sessions'),harnessSessionId,{limit:config.maxHistoryEvents}):null;
    workers.push({id,projectId,nodeId,harnessSessionId,title,state,model,environment,error,cleanupPending,processId,submissions,history});
  }}finally{db.close();}}catch(error){if(error.code!=='ERR_SQLITE_ERROR'||!String(error).includes('unable to open database'))throw error;}
  try{const db=new DatabaseSync(resolve(dirname(config.campaign),limits.ledger),{readOnly:true});try{budget=db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}}catch(error){if(error.code!=='ERR_SQLITE_ERROR'||!String(error).includes('unable to open database'))throw error;}
  let runtime=null;
  try{const runs=(await readFile(join(base,'runs.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),launch=await json(join(base,'launch.json'));const started=runs.findLast(value=>value.event==='started'&&value.pid===launch.pid);if(started)runtime={runId:started.runId,pid:started.pid,startedAt:started.at,identity:started.identity,stoppedAt:runs.findLast(value=>value.runId===started.runId&&value.event==='stopped')?.at??null};}catch(error){if(error.code!=='ENOENT')throw error;}
  await save(path,await sanitize({label,at:new Date().toISOString(),identity:await identity(),runtime,inventory,invocations,workers,budget}));
  console.log(JSON.stringify({snapshot:label,workers:workers.length,invocations:invocations.length,budget}));
}

if(mode==='--prepare')await prepare();
else if(mode==='--apply')await apply();
else if(mode==='--cli-import')await cliImport();
else if(mode==='--snapshot')await snapshot(args[1]);
else{
  assert(args.includes('--live'),'Campaign startup requires --serve --live');assert(process.env.DEEPSEEK_API_KEY?.trim(),'Missing configured provider credential');
  await stat(join(root,'dist/web/index.html'));await rack.call('/v1/health');if(args.includes('--repair'))config.verificationRerun=true;
  const {createApp}=await import('../src/main.ts'),{serveControl}=await import('../src/control.ts'),runtime=await createApp(config),runId=randomUUID();let writes=Promise.resolve(),closeControl;
  runtime.agents.on('observation',value=>{writes=writes.then(async()=>appendFile(join(base,'live-observation.jsonl'),JSON.stringify(await sanitize({observedAt:Date.now(),runId,...value}))+'\n'));writes.catch(()=>{console.error('Evidence persistence failed');void runtime.app.close();});});
  let closing;const stop=()=>closing??=(async()=>{await runtime.app.close();await closeControl?.();await writes;await appendFile(join(base,'runs.jsonl'),JSON.stringify({runId,event:'stopped',at:new Date().toISOString()})+'\n');})();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop().catch(()=>{console.error('Campaign shutdown failed');process.exitCode=1;});});
  await runtime.app.listen({host:'127.0.0.1',port:config.port});await appendFile(join(base,'runs.jsonl'),JSON.stringify({runId,event:'started',at:new Date().toISOString(),pid:process.pid,corrective:config.verificationRerun,identity:await identity()})+'\n');await save(join(base,'launch.json'),{url:runtime.launchUrl,pid:process.pid});console.log(runtime.launchUrl);
  closeControl=await serveControl(config.stateRoot,()=>({ready:true,pid:process.pid,launchUrl:runtime.renewLaunch()}),stop);
}
