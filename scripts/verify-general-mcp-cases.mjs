import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';
import {loadRackConfig} from '../src/environment/daemon.ts';
import {durable} from '../src/environment/storage.ts';

/** Public-API supplement to built-browser acceptance. Every model request flows
 * through the running Main and its one shared campaign ledger. This process owns
 * only its named project, connection definitions, environment and credential ref;
 * it never changes the browser campaign's environment or base credentials. */
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
assert(args.includes('--live'),'Use --live only within the approved ADR011 campaign');
const label=option('--label');assert(/^[a-z][a-z0-9-]{0,31}$/.test(label??''),'Supply a unique --label such as primary');
const root=sourceRoot,base=join(root,'.local/adr011'),config=await loadConfig(join(root,'config/adr011-app.json'));
const limits=CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8'))),rackConfig=await loadRackConfig(config.environmentConfig);
assert.equal(limits.id,'adr011');
const directory=join(base,'api-cases',label),reportPath=join(directory,'report.json');
await assert.rejects(stat(reportPath),{code:'ENOENT'},'A run label cannot overwrite previous evidence');await mkdir(directory,{recursive:true,mode:0o700});
const report={label,transport:'public-main-api',startedAt:new Date().toISOString(),projectId:null,cases:[],permissions:[],snapshots:[],complete:false};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const exec=promisify(execFile),workers=new Set(),allowedTools=new Set(['mcp__managed__measure','mcp__remote__transform','mcp__local__transform']);
const cookiePath=option('--cookie')??join(base,'api-cookie.json');
let origin,cookie,workerBase;
function budget(){const db=new DatabaseSync(resolve(dirname(config.campaign),limits.ledger),{readOnly:true});try{return db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}}
const initialBudget=budget();report.initialBudget=initialBudget;
assert(initialBudget.requests<limits.maxRequests-limits.reserveRequests,'Primary provider allowance exhausted');
async function save(){await durable(reportPath,report);}
async function authenticate(){
  if(args.includes('--bootstrap')){
    const launch=await json(join(base,'launch.json')),url=new URL(launch.url);origin=url.origin;
    const token=new URLSearchParams(url.hash.slice(1)).get('token');assert(token,'Launch file has no bootstrap token');
    const response=await fetch(`${origin}/api/bootstrap`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(config.requestTimeoutMs)});
    assert.equal(response.status,200,'Bootstrap unavailable; wait for a coordinated Main restart rather than reusing a browser token');
    cookie=response.headers.get('set-cookie')?.split(';')[0];assert(cookie?.startsWith('polariton='));
    await durable(cookiePath,{origin,cookie});
  }else{
    const info=await stat(cookiePath);assert.equal(info.mode&0o777,0o600,'API cookie file must be private');({origin,cookie}=await json(cookiePath));
  }
  assert.equal(origin,`http://127.0.0.1:${config.port}`);assert(typeof cookie==='string'&&cookie.startsWith('polariton='));
}
async function api(path,body,expected=200){
  const response=await fetch(`${origin}${path}`,{method:body===undefined?'GET':'POST',headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(config.requestTimeoutMs)});
  const value=await response.json();assert.equal(response.status,expected,`${path}: ${value.error?.code??'unexpected status'} ${value.error?.message??''}`);return value;
}
async function command(value){return api('/api/environment/command',{operationId:`api-${label}-${randomUUID()}`,...value});}
async function view(id){return (await api(workerBase)).find(worker=>worker.id===id);}
async function allowPending(){
  if(!workerBase)return;
  for(const worker of await api(workerBase))if(workers.has(worker.id))for(const permission of worker.permissions){
    assert(allowedTools.has(permission.title),`Unexpected requested tool: ${permission.title}`);
    const option=permission.options.find(value=>value.kind==='allow_once');assert(option,'Fixture tool lacks Allow once');
    report.permissions.push({workerId:worker.id,tool:permission.title,toolCallId:permission.toolCallId,arguments:permission.detail});
    await api(`${workerBase}/${worker.id}/permissions`,{id:permission.id,option:option.optionId});
  }
}
async function until(predicate,description){
  const deadline=Date.now()+config.requestTimeoutMs;
  while(Date.now()<deadline){await allowPending();const result=await predicate();if(result)return result;await delay(config.interruptPollMs);}
  throw new Error(`Timed out: ${description}`);
}
async function worker(name,selection){
  const value=await api(workerBase,{id:randomUUID(),title:`API ${label}: ${name}`});workers.add(value.id);
  await api(`${workerBase}/${value.id}/environment`,{selection});return value.id;
}
async function submit(id,text){
  const submission={id:randomUUID(),text};await api(`${workerBase}/${id}/submissions`,submission);return submission.id;
}
async function settled(id,submissionId,state='applied'){
  return until(async()=>{const current=await view(id),receipt=current.submissions.find(value=>value.id===submissionId);if(!receipt||['pending','admitted'].includes(receipt.state))return null;assert.equal(receipt.state,state,receipt.detail??current.error??'Unexpected submission outcome');if(state==='applied'&&current.state!=='idle')return null;return current;},`${id} ${state}`);
}
async function history(id){
  const first=await api(`${workerBase}/${id}/history`),events=[...first.events];let before=first.before;
  while(before!==null){assert(events.length<=config.maxHistoryEvents);const page=await api(`${workerBase}/${id}/history?cut=${encodeURIComponent(first.cut)}&before=${before}`);events.unshift(...page.events);before=page.before;}
  return {sessionId:first.sourceSessionId,events};
}
async function close(id){await api(`${workerBase}/${id}/close`,{});const current=await view(id);assert.equal(current.cleanupPending,false);assert.equal(current.state,'inactive');assert.equal(current.permissions.length,0);return current;}
async function snapshot(name){const key=`api-${label}-${name}`;await exec(process.execPath,['scripts/verify-general-mcp-live.mjs','--snapshot',key],{cwd:root,timeout:config.requestTimeoutMs,maxBuffer:config.maxFrameBytes});report.snapshots.push(key);await save();return key;}
const pipeline=sample=>`Use only these three MCP tools, in this exact data dependency: first call mcp__managed__measure with sample "${sample}" and mode "normal"; then call mcp__remote__transform with value equal to the measurement's value and label "${sample}"; then call mcp__local__transform with value equal to the remote transform's returned value and label "${sample}". Do not compute replacements or use filesystem/shell tools. Return all three exact tool outputs including receipts.`;
const transform=(label,value=6)=>`Call mcp__local__transform exactly once with value ${value} and label "${label}". Do not use any other tool. Return its exact result and receipt.`;
async function check(name,run){
  console.log(JSON.stringify({case:name,state:'started',providerRequests:budget().requests}));
  const result={name,startedAt:new Date().toISOString(),status:'running'};report.cases.push(result);await save();
  try{Object.assign(result,await run(),{status:'pass',finishedAt:new Date().toISOString()});await save();console.log(JSON.stringify({case:name,state:'passed',providerRequests:budget().requests}));}
  catch(error){result.status='failed';result.error=error.message;result.finishedAt=new Date().toISOString();await save();throw error;}
}

let originalCredential;
try{
  await authenticate();
  const project=await api('/api/projects',{id:randomUUID(),name:`ADR011 API campaign ${label}`});assert(project.mainNodeId);report.projectId=project.id;
  workerBase=`/api/projects/${project.id}/nodes/${project.mainNodeId}/workers`;
  const inventory=await api('/api/environment/inventory'),mixed=inventory.environments.find(value=>value.id==='adr011-mixed');assert(mixed,'Prepare the shared three-kind environment before the API supplement');
  const source=await json(join(base,'mcp-configuration.json')),secrets=await json(rackConfig.credentialFile),reference=`ADR011_API_${label.replaceAll('-','_').toUpperCase()}`;
  assert(!secrets.credentials[reference],'Run credential reference already exists');
  originalCredential={...secrets.credentials.ADR011_TOKEN,authority:`api-${label}`};secrets.credentials[reference]=originalCredential;await durable(rackConfig.credentialFile,secrets);
  const application=join(directory,'ControlledApplication.fixture');await writeFile(application,'API-owned controlled prerequisite\n',{mode:0o600});
  const definitions={
    [`API ${label} remote`]:{...source.mcpServers['ADR011 Remote'],headers:{Authorization:`Bearer \${${reference}}`}},
    [`API ${label} local`]:{...source.mcpServers['ADR011 Local'],env:{...source.mcpServers['ADR011 Local'].env,ADR011_APPLICATION:application,ADR011_VERSION:'1'},requirements:{...source.mcpServers['ADR011 Local'].requirements,files:[application]}},
  };
  const preview=await api('/api/environment/capabilities/preview',{configuration:{mcpServers:definitions}});assert.deepEqual(preview.errors,[]);
  const imported=await command({kind:'capability.import',entries:preview.entries});let remote=imported.capabilities.find(value=>value.kind==='http'),local=imported.capabilities.find(value=>value.kind==='stdio');assert(remote&&local);
  const managed=mixed.head.components.find(value=>'releaseId' in value),realization=inventory.realizations.find(value=>value.id===inventory.activeRealizations[mixed.id]);assert(managed&&realization);
  const mountId=realization.components.find(value=>value.componentId===managed.id)?.mountId;assert(mountId);
  const document={format:2,environmentId:`api-${label}`,name:`ADR011 API ${label}`,description:'Isolated public API campaign environment',components:[{...managed,id:'managed',sharedMountId:mountId},{id:'remote',name:'API remote',definition:{capabilityId:remote.id,revisionId:remote.revisionId}},{id:'local',name:'API local',definition:{capabilityId:local.id,revisionId:local.revisionId}}]};
  const firstRevision=await command({kind:'environment.publish',expectedBase:null,document});assert.equal((await command({kind:'environment.apply',environmentId:document.environmentId,revisionId:firstRevision.revisionId})).status,'ready');
  const selection=revision=>({environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name});let pinned;
  await check('mixed-first-send',async()=>{
    pinned=await worker('mixed pinned R1',selection(firstRevision));const before=await snapshot('mixed-before'),sample=`api-${label}-first`;
    const submission=await submit(pinned,pipeline(sample));const current=await settled(pinned,submission);assert(current.environment.locked);assert.deepEqual(current.environment.selection,selection(firstRevision));
    const after=await snapshot('mixed-after');return {workerId:pinned,submissionId:submission,sample,before,after};
  });
  let secondRevision;
  await check('retained-definition-resume',async()=>{
    const closed=await close(pinned),sessionId=closed.harnessSessionId;
    definitions[`API ${label} local`].env.ADR011_VERSION='2';
    const revisedPreview=await api('/api/environment/capabilities/preview',{configuration:{mcpServers:{[local.name]:definitions[local.name]}},capabilityId:local.id});assert.deepEqual(revisedPreview.errors,[]);
    local=await command({kind:'capability.revise',id:local.id,expectedBase:local.revisionId,entry:revisedPreview.entries[0]});
    const updated={...document,components:document.components.map(value=>value.id==='local'?{...value,definition:{capabilityId:local.id,revisionId:local.revisionId}}:value)};
    secondRevision=await command({kind:'environment.publish',expectedBase:firstRevision.revisionId,document:updated});assert.equal((await command({kind:'environment.apply',environmentId:document.environmentId,revisionId:secondRevision.revisionId})).status,'ready');
    const before=await snapshot('resume-before');await api(`${workerBase}/${pinned}/resume`,{});
    const oldLabel=`api-${label}-old`,oldSubmission=await submit(pinned,transform(oldLabel));await settled(pinned,oldSubmission);assert.equal((await view(pinned)).harnessSessionId,sessionId);assert.deepEqual((await view(pinned)).environment.selection,selection(firstRevision));
    const fresh=await worker('latest R2',selection(secondRevision)),newLabel=`api-${label}-new`,newSubmission=await submit(fresh,transform(newLabel));await settled(fresh,newSubmission);
    const after=await snapshot('resume-after');await close(pinned);await close(fresh);return {workerId:pinned,newWorkerId:fresh,sessionId,oldLabel,newLabel,before,after,oldRevision:firstRevision.revisionId,newRevision:secondRevision.revisionId};
  });
  await check('concurrent-close-isolation',async()=>{
    const closedWorker=await worker('close independently',selection(secondRevision)),survivor=await worker('survivor',selection(secondRevision));
    const firstSubmission=await submit(closedWorker,transform(`api-${label}-close`));await settled(closedWorker,firstSubmission);
    const sample=`api-${label}-survivor`,submission=await submit(survivor,`Call mcp__managed__measure with sample "${sample}" and mode "slow". Then call mcp__local__transform with the measurement value and label "${sample}". Use only those two tools, and return both receipts.`);
    const running=await until(async()=>{const current=await view(survivor);if(current.state!=='running'||!current.harnessSessionId)return null;const source=await history(survivor);return source.events.some(event=>event.type==='tool/call'&&event.data.name==='mcp__managed__measure')?current:null;},'survivor slow tool admitted');
    const before=await snapshot('isolation-before');await close(closedWorker);const still=await view(survivor);assert.equal(still.processId,running.processId);assert.equal(still.harnessSessionId,running.harnessSessionId);
    await settled(survivor,submission);const after=await snapshot('isolation-after');await close(survivor);return {closedWorkerId:closedWorker,survivorWorkerId:survivor,submissionId:submission,sample,before,after};
  });
  await check('authentication-setup-retry',async()=>{
    const id=await worker('auth retry',selection(secondRevision)),before=await snapshot('auth-before'),beforeRequests=budget().requests;
    const current=await json(rackConfig.credentialFile);current.credentials[reference]={...originalCredential,value:'invalid-api-campaign-token'};await durable(rackConfig.credentialFile,current);
    const submission=await submit(id,transform(`api-${label}-auth-retry`));const failed=await settled(id,submission,'failed');assert.equal(budget().requests,beforeRequests);assert(failed.submissions.find(value=>value.id===submission).retryable);assert.equal(failed.harnessSessionId,null);
    const failedSnapshot=await snapshot('auth-failed'),restore=await json(rackConfig.credentialFile);restore.credentials[reference]=originalCredential;await durable(rackConfig.credentialFile,restore);
    await api(`${workerBase}/${id}/submissions/${submission}/retry`,{});const completed=await settled(id,submission);assert.equal(completed.submissions.filter(value=>value.id===submission).length,1);
    const after=await snapshot('auth-retried');await close(id);return {workerId:id,submissionId:submission,before,failed:failedSnapshot,after,preDispatchProviderRequests:0};
  });
  await check('missing-prerequisite-setup-retry',async()=>{
    const id=await worker('missing application retry',selection(secondRevision)),beforeRequests=budget().requests,before=await snapshot('prerequisite-before');await rm(application);
    const submission=await submit(id,transform(`api-${label}-application-retry`)),failed=await settled(id,submission,'failed');assert.equal(budget().requests,beforeRequests);assert(failed.submissions.find(value=>value.id===submission).retryable);
    const failure=await snapshot('prerequisite-failed');await writeFile(application,'API-owned controlled prerequisite\n',{mode:0o600});await api(`${workerBase}/${id}/submissions/${submission}/retry`,{});await settled(id,submission);
    const after=await snapshot('prerequisite-retried');await close(id);return {workerId:id,submissionId:submission,before,failed:failure,after,preDispatchProviderRequests:0};
  });
  await check('no-environment-cold-history',async()=>{
    const id=await worker('no environment',null),submission=await submit(id,`Reply with exactly API_${label}_NO_ENV. Do not use tools.`);await settled(id,submission);
    const before=await snapshot('none-before-close'),closed=await close(id),requests=budget().requests;
    const source=await history(id),afterRead=await view(id);assert.equal(budget().requests,requests);assert.equal(afterRead.processId,closed.processId);assert.equal(afterRead.state,'inactive');assert.equal(afterRead.harnessSessionId,closed.harnessSessionId);assert.equal(afterRead.environment.selection,null);assert(afterRead.environment.locked);
    for(const event of source.events.filter(value=>value.type==='request/header'))assert(!event.data.header.tools.some(tool=>tool.name.startsWith('mcp__')));
    const after=await snapshot('none-history');return {workerId:id,submissionId:submission,before,after,historyEvents:source.events.length,historyProviderRequests:0};
  });
  report.complete=true;report.finishedAt=new Date().toISOString();report.finalBudget=budget();await save();console.log(JSON.stringify({complete:true,label,cases:report.cases.length,requests:report.finalBudget.requests-initialBudget.requests,projectId:report.projectId}));
}catch(error){report.error=error.message;report.finishedAt=new Date().toISOString();report.finalBudget=budget();await save();console.error(JSON.stringify({complete:false,label,error:error.message}));process.exitCode=1;}
finally{
  if(workerBase)for(const id of workers)try{await close(id);}catch{report.cleanupPending??=[];report.cleanupPending.push(id);}
  if(originalCredential){const current=await json(rackConfig.credentialFile),reference=`ADR011_API_${label.replaceAll('-','_').toUpperCase()}`;current.credentials[reference]=originalCredential;await durable(rackConfig.credentialFile,current);}
  await save();
}
