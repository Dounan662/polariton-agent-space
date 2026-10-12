import assert from 'node:assert/strict';
import {appendFile,copyFile,mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';
import {EnvironmentClient,loadRackConfig} from '../src/environment/daemon.ts';
import {readHistory} from '../harness/history.mjs';

/** Prepare capabilities and retain evidence without impersonating browser actions.
 * Only --serve --live opens the authorized provider ledger. Selection, Send, retry,
 * model changes and resume must be driven through the built UI by the verifier.
 */
const args=process.argv.slice(2),mode=args[0];
const modes=['--prepare','--upgrade','--serve','--snapshot','--unavailable','--restore'];
assert(modes.includes(mode),`Expected one of ${modes.join(', ')}`);
const root=sourceRoot,base=join(root,'.local/adr010'),fixture=join(root,'tests/fixtures/adr010');
const config=await loadConfig(join(root,'config/adr010-app.json'));
const limits=CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8')));
const rackConfig=await loadRackConfig(config.environmentConfig),rack=new EnvironmentClient(rackConfig);
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
await mkdir(base,{recursive:true,mode:0o700});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const admin=command=>rack.call('/v1/command',command);
const git=async(repository,...argv)=>(await exec('git',['-C',repository,...argv],{timeout:rackConfig.operationTimeoutMs,maxBuffer:rackConfig.maxBodyBytes})).stdout.trim();
const component=(role,version,seed,shared=true,suffix='',releaseId=`adr010-r${version}`)=>({id:role,name:role==='measurement'?'Measurement':'Transform',releaseId,configuration:{role,seed,slowMs:30000},...(shared?{sharedMountId:`adr010-${role}-r${version}${suffix}`}:{})});
const document=(id,name,components)=>({format:2,environmentId:id,name,description:'Prepared ADR-010 assignment fixture',components});

async function identity(){
  const paths=[];
  async function scan(directory){for(const entry of await readdir(join(root,directory),{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.isFile())paths.push(path);}}
  for(const directory of ['src','web','harness','config','dist'])await scan(directory);
  paths.push('package.json','package-lock.json');
  const files=await Promise.all(paths.sort().map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
  return {digest:sha(JSON.stringify(files)),files,dsh:JSON.parse(await readFile(join(root,'node_modules/@deepseek-ai/dsh/package.json'),'utf8')).version};
}

async function setup(){
  try{return await json(join(base,'setup.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const seed=randomBytes(24).toString('hex'),repository=join(base,'capability-source');
  await mkdir(repository,{recursive:true});
  for(const name of ['fixture.mjs','server.mjs','test.mjs','version.json','polariton-capability.json','package.json','package-lock.json'])await copyFile(join(fixture,name),join(repository,name));
  await copyFile(join(root,'environment/server.mjs'),join(repository,'server-support.mjs'));
  await git(repository,'init');await git(repository,'add','.');
  await git(repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','ADR-010 prepared fixture R1');
  const value={seed,repository,r1:await git(repository,'rev-parse','HEAD'),r2:null,createdAt:new Date().toISOString()};
  await save(join(base,'setup.json'),value);return value;
}

async function prepare(upgrade){
  await rack.call('/v1/health');const value=await setup();
  await exec(process.execPath,['--test',join(fixture,'test.mjs')],{timeout:config.requestTimeoutMs,maxBuffer:config.maxBodyBytes});
  await admin({kind:'capability.register',operationId:'adr010-register',id:'adr010-fixture',repository:value.repository});
  if(args.includes('--repair-fixture')){
    assert(!upgrade,'Repair the initial fixture before publishing upgrades');
    const inventory=await rack.call('/v1/inventory');assert(!inventory.environments.length,'Prepared environments already exist; do not rewrite their fixture source');
    for(const name of ['fixture.mjs','server.mjs','test.mjs','version.json','polariton-capability.json','package.json','package-lock.json'])await copyFile(join(fixture,name),join(value.repository,name));
    await git(value.repository,'add','.');await git(value.repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','Correct prepared fixture build dependencies');
    value.r1=await git(value.repository,'rev-parse','HEAD');value.release1=`adr010-r1-${value.r1.slice(0,12)}`;
    await save(join(base,'setup.json'),value);
  }
  if(upgrade&&!value.r2){
    await save(join(value.repository,'version.json'),{version:2});await git(value.repository,'add','version.json');
    await git(value.repository,'-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','ADR-010 prepared fixture R2');
    value.r2=await git(value.repository,'rev-parse','HEAD');await save(join(base,'setup.json'),value);
  }
  const version=upgrade?2:1;
  const releaseId=version===1?(value.release1??'adr010-r1'):'adr010-r2';
  await admin({kind:'release.install',operationId:releaseId,packageId:'adr010-fixture',commit:value[`r${version}`]});
  const measurement=component('measurement',version,value.seed,true,'',releaseId),transform=component('transform',version,value.seed,true,'',releaseId);
  const components=upgrade?[measurement,transform]:[measurement,transform,component('measurement',1,value.seed,true,'-fault',releaseId),component('transform',1,value.seed,true,'-fault',releaseId)];
  for(const entry of components)await admin({kind:'mount.create',operationId:`create-${entry.sharedMountId}`,id:entry.sharedMountId,component:{...entry,sharedMountId:undefined}});
  const docs=upgrade?[document('adr010-pair','ADR010 Pair',[measurement,transform])]:[
    document('adr010-pair','ADR010 Pair',[measurement,transform]),
    document('adr010-measure','ADR010 Measurement',[measurement]),
    document('adr010-transform','ADR010 Transform',[transform]),
    document('adr010-fault','ADR010 Retry',[component('measurement',1,value.seed,true,'-fault',releaseId),component('transform',1,value.seed,true,'-fault',releaseId)]),
  ];
  for(const doc of docs){
    const revisionId=`${doc.environmentId}-r${version}`;
    await admin({kind:'environment.publish',operationId:revisionId,expectedBase:upgrade?`${doc.environmentId}-r1`:null,document:doc});
    const realization=await admin({kind:'environment.apply',operationId:`apply-${revisionId}`,environmentId:doc.environmentId,revisionId});
    assert.equal(realization.status,'ready',JSON.stringify(realization));
  }
  await save(join(base,`prepared-r${version}.json`),{at:new Date().toISOString(),version,commit:value[`r${version}`],inventory:await rack.call('/v1/inventory')});
  console.log(JSON.stringify({prepared:version,environments:docs.map(value=>value.environmentId),providerRequests:0}));
}

// Evidence has an explicit projection; reject unexpected secret markers before export.
function sanitize(value){
  let encoded=JSON.stringify(value,null,2).replaceAll(root,'<V5>');
  if(process.env.DEEPSEEK_API_KEY)encoded=encoded.replaceAll(process.env.DEEPSEEK_API_KEY,'<REDACTED>');
  assert(!/Bearer\s+[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|"authorization"\s*:/i.test(encoded),'Credential-like content in evidence; export stopped');
  return JSON.parse(encoded);
}

async function snapshot(label){
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(label??''),'Snapshot requires a stable label');
  const directory=join(base,'snapshots',label);
  try{await stat(directory);throw new Error(`Snapshot ${label} already exists; evidence is immutable`);}catch(error){if(error.code!=='ENOENT')throw error;}
  const inventory=await rack.call('/v1/inventory'),invocations=[];
  for(const mount of inventory.mounts){if(!mount.containerId)continue;
    const {stdout,stderr}=await exec('docker',[...(rackConfig.dockerConfig?['--config',rackConfig.dockerConfig]:[]),'--context',rackConfig.dockerContext,'logs',mount.containerId],{timeout:rackConfig.operationTimeoutMs,maxBuffer:rackConfig.limits.outputBytes});
    for(const line of (stdout+'\n'+stderr).split('\n')){if(!line.startsWith('{'))continue;let value;try{value=JSON.parse(line);}catch{continue;}if(value.fixture==='adr010')invocations.push({...value,mountId:mount.id,generation:mount.generation,releaseId:mount.component.releaseId});}
  }
  let workers=[],budget=null;
  try{
    const db=new DatabaseSync(join(config.stateRoot,'agents.sqlite'),{readOnly:true});
    try{for(const row of db.prepare('SELECT data FROM workers').all()){
      const value=JSON.parse(row.data),{id,projectId,nodeId,harnessSessionId,title,state,model,environment,error,cleanupPending}=value;
      const submissions=db.prepare('SELECT data FROM submissions WHERE worker_id=?').all(id).map(row=>JSON.parse(row.data));
      const history=harnessSessionId?await readHistory(join(config.stateRoot,'harness',id,'sessions'),harnessSessionId,{limit:config.maxHistoryEvents}):null;
      workers.push({id,projectId,nodeId,harnessSessionId,title,state,model,environment,error,cleanupPending,submissions,history});
    }}finally{db.close();}
  }catch(error){if(error.code!=='ERR_SQLITE_ERROR'||!String(error).includes('unable to open database'))throw error;}
  try{const db=new DatabaseSync(resolve(dirname(config.campaign),limits.ledger),{readOnly:true});try{budget=db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}}catch(error){if(error.code!=='ERR_SQLITE_ERROR'||!String(error).includes('unable to open database'))throw error;}
  const evidence=sanitize({label,at:new Date().toISOString(),identity:await identity(),inventory,invocations,workers,budget});
  await save(join(directory,'evidence.json'),evidence);
  console.log(JSON.stringify({snapshot:label,workers:workers.length,invocations:invocations.length,budget}));
}

if(mode==='--prepare'||mode==='--upgrade')await prepare(mode==='--upgrade');
else if(mode==='--snapshot')await snapshot(args[1]);
else if(mode==='--unavailable'||mode==='--restore'){
  const value=await setup(),id='adr010-transform-r1-fault',operationId=`${mode.slice(2)}-${randomUUID()}`;
  const command=mode==='--unavailable'?{kind:'mount.stop',operationId,id,force:true}:{kind:'mount.create',operationId,id,component:component('transform',1,value.seed,false,'',value.release1??'adr010-r1')};
  await snapshot(`${mode.slice(2)}-before-${operationId}`);
  const result=await admin(command);
  await appendFile(join(base,'interventions.jsonl'),JSON.stringify({at:new Date().toISOString(),command,result})+'\n');
  console.log(JSON.stringify({intervention:mode.slice(2),mountId:id,state:result.state}));
}else if(mode==='--serve'){
  assert(args.includes('--live'),'Starting the provider campaign requires --serve --live');
  assert(process.env.DEEPSEEK_API_KEY?.trim(),'Missing provider credential');
  await stat(join(root,'dist/web/index.html'));await rack.call('/v1/health');
  if(args.includes('--repair'))config.verificationRerun=true;
  const {createApp}=await import('../src/main.ts'),runtime=await createApp(config);
  const runId=randomUUID();let writes=Promise.resolve();
  const record=value=>{writes=writes.then(()=>appendFile(join(base,'live-observation.jsonl'),JSON.stringify(sanitize({observedAt:Date.now(),runId,...value}))+'\n'));writes.catch(error=>{console.error('Evidence write failed:',error.message);void runtime.app.close();});};
  runtime.agents.on('observation',record);
  // UI disables the selector during a turn. This separate verifier signal probes
  // the authoritative public module without impersonating a browser HTTP request.
  // Every attempt is retained, including selection ambiguity and unexpected success.
  let probePending=false;
  process.on('SIGUSR2',()=>{
    const probeId=randomUUID(),at=new Date().toISOString();
    const probe={source:'main-public-module',at,runId,probeId,passed:false};
    const work=(async()=>{
      if(probePending){probe.error='Another verifier probe is pending';return;}
      probePending=true;
      try{
        const running=runtime.tree.projects().flatMap(project=>runtime.tree.graph(project.id).nodes.flatMap(node=>runtime.agents.list(project.id,node.id))).filter(worker=>worker.state==='running');
        if(running.length!==1){probe.error=`Expected exactly one running worker; observed ${running.length}`;return;}
        const worker=running[0];Object.assign(probe,{workerId:worker.id,projectId:worker.projectId,nodeId:worker.nodeId,workerState:worker.state,selectedModel:worker.model});
        try{
          await runtime.agents.configure(worker.projectId,worker.nodeId,worker.id,'model',worker.model);
          probe.error='Active-turn model configuration unexpectedly succeeded';
        }catch(error){
          const {Fault}=await import('../src/contracts.ts');
          if(error instanceof Fault){probe.status=error.status;probe.body={error:{code:error.code,message:error.message}};probe.passed=error.status===409&&error.code==='MODEL_BUSY';}
          else probe.error='Unexpected non-domain failure from configuration boundary';
        }
      }finally{probePending=false;}
    })().then(async()=>{
      const path=join(base,'rejections',`model-${Date.now()}-${probeId}.json`);await save(path,sanitize(probe));
      console.log(JSON.stringify({verificationProbe:'active-model-rejection',passed:probe.passed,evidence:path.replaceAll(root,'<V5>')}));
    });
    writes=Promise.all([writes,work]).then(()=>{});
    writes.catch(error=>{console.error('Rejection evidence write failed:',error.message);void runtime.app.close();});
  });
  let closing;
  const stop=()=>closing??=(async()=>{await runtime.app.close();await writes;await appendFile(join(base,'runs.jsonl'),JSON.stringify({runId,event:'stopped',at:new Date().toISOString()})+'\n');})();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop().catch(error=>{console.error(error);process.exitCode=1;});});
  await runtime.app.listen({host:'127.0.0.1',port:config.port});
  await appendFile(join(base,'runs.jsonl'),JSON.stringify({runId,event:'started',at:new Date().toISOString(),pid:process.pid,corrective:config.verificationRerun,identity:await identity()})+'\n');
  console.log(runtime.launchUrl);
}
