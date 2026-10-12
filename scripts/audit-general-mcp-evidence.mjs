import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';

/** Read-only acceptance audit: missing UI or owner evidence remains incomplete.
 * A browser review documents visible behavior; tool claims additionally require
 * DSH call/result records matching independently written fixture receipts. */
const base=join(sourceRoot,'.local/adr011'),destination=join(sourceRoot,'docs/evidence/adr011');
const read=async path=>JSON.parse(await readFile(path,'utf8')),checks=[],used=[];
const sha=value=>createHash('sha256').update(value).digest('hex');
async function retain(path){const bytes=await readFile(path);used.push({path:relative(base,path),sha256:sha(bytes),bytes:bytes.length});return JSON.parse(bytes);}
async function check(name,run){try{checks.push({name,status:'pass',details:await run()});}catch(error){checks.push({name,status:error.code==='ENOENT'?'incomplete':'fail',error:error.message.replaceAll(sourceRoot,'<V5>')});}}
const events=worker=>worker.history?.events??[];
const calls=worker=>events(worker).filter(event=>event.type==='tool/call');
const input=event=>typeof event.data.arguments==='string'?JSON.parse(event.data.arguments):event.data.arguments;
const results=(worker,call)=>events(worker).filter(event=>event.type==='tool/result').flatMap(event=>event.data.message.content.filter(part=>part.type==='tool-result'&&part.toolCallId===call.data.callId));
const config=await loadConfig(join(sourceRoot,'config/adr011-app.json')),limits=CampaignConfig.parse(await read(config.campaign));
const snapshots=[];
try{for(const name of await readdir(join(base,'snapshots')))snapshots.push(await retain(join(base,'snapshots',name,'evidence.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
const snapshot=label=>{const value=snapshots.find(value=>value.label===label);assert(value,`Missing snapshot ${label}`);return value;};
const worker=(evidence,id)=>{const value=evidence.workers.find(value=>value.id===id);assert(value,`Missing worker ${id}`);return value;};
/** A receipt match requires a recorded call, the exact independently computed
 * result and its unique receipt in DSH's owned result record. */
function invocation(evidence,id,kind,label,version=1){
  const value=worker(evidence,id),tool=kind==='managed'?'measure':'transform';
  const namespace=kind==='managed'?'managed':kind==='http'?'remote':'local';
  const matching=calls(value).filter(call=>call.data.name===`mcp__${namespace}__${tool}`&&(kind==='managed'?input(call).sample:input(call).label)===label);
  assert.equal(matching.length,1,`Expected one ${kind} call for ${label}`);const call=matching[0],supplied=input(call);
  const source=kind==='managed'?'managed':kind==='http'?'external-receipts.jsonl':'stdio-receipts.jsonl';
  const records=evidence.invocations.filter(record=>record.source===source&&record.phase===(kind==='managed'?'completed':'invoked')&&record.tool===tool&&(kind==='managed'?record.input.sample:record.input.label)===label);
  assert.equal(records.length,1,`Expected one independent ${kind} receipt for ${label}`);const record=records[0];
  for(const [key,value]of Object.entries(supplied))assert.deepEqual(record.input[key],value);
  const output=kind==='managed'?record.result.structuredContent:record.output,receipt=kind==='managed'?record.invocationId:output.receipt;
  assert.equal(output.version,version);assert(JSON.stringify(results(value,call)).includes(receipt),'DSH result omitted the independent receipt');
  if(kind!=='managed')assert.equal(output.value,record.input.value*7+version);
  return {value:output.value,input:record.input,receipt,callId:call.data.callId};
}

await check('source-build-identity',async()=>{
  assert(snapshots.length>0,'No retained campaign snapshots');
  for(const snapshot of snapshots){assert.equal(snapshot.identity.dsh,'0.1.6-alpha.1');assert.equal(snapshot.identity.digest,sha(JSON.stringify(snapshot.identity.files)));assert(snapshot.identity.files.some(file=>file.path==='dist/web/index.html'));}
  const latest=[...snapshots].sort((left,right)=>Date.parse(right.at)-Date.parse(left.at))[0];
  for(const file of latest.identity.files)assert.equal(sha(await readFile(join(sourceRoot,file.path))),file.sha256,`Final source/build differs from latest evidence: ${file.path}`);
  const runtimeDifferences=value=>value.runtime?value.identity.files.filter(file=>/^(src|harness|dist)\//.test(file.path)&&value.runtime.identity.files.find(prior=>prior.path===file.path)?.sha256!==file.sha256).map(file=>file.path):null;
  assert(latest.runtime,'Final snapshot must record the actual Main startup identity');assert.equal(latest.runtime.identity.digest,sha(JSON.stringify(latest.runtime.identity.files)));assert.deepEqual(runtimeDifferences(latest),[],'Restart final Main before claiming current runtime source/build verification');
  return {snapshots:snapshots.map(value=>({label:value.label,digest:value.identity.digest,dsh:value.identity.dsh,runtimeDigest:value.runtime?.identity.digest??null,sourceChangesAfterStartup:runtimeDifferences(value)}))};
});
await check('shared-provider-budget',async()=>{
  const db=new DatabaseSync(resolve(config.campaign,'..',limits.ledger),{readOnly:true});let budget;try{budget=db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}
  assert.equal(limits.id,'adr011');assert(budget.requests>0&&budget.requests<=120);assert(budget.elapsed<=7200000);assert(limits.maxOutputTokens<=8192);
  return {budget,maxOutputTokens:limits.maxOutputTokens};
});
await check('cli-file-stdin-retry-parity',async()=>{
  const value=await retain(join(base,'cli-parity.json'));assert.equal(value.passed,true);assert(value.fileStdinEqual&&value.receiptReplayEqual);assert.deepEqual(value.preview.errors,[]);assert.equal(value.result.capabilities.length,2);return {capabilities:value.result.capabilities.map(entry=>entry.id)};
});
await check('real-provider-three-kind-invocations',async()=>{
  const verified=[];
  for(const snapshot of snapshots)for(const worker of snapshot.workers){
    if(!events(worker).some(event=>event.type==='request/header'))continue;
    for(const call of calls(worker)){
      const supplied=input(call),matches=snapshot.invocations.filter(record=>record.phase==='invoked'&&record.tool==='transform'&&isDeepStrictEqual(record.input,supplied));
      for(const record of matches){const output=results(worker,call);if(!JSON.stringify(output).includes(record.output.receipt))continue;assert.equal(record.output.value,supplied.value*7+record.output.version);verified.push({workerId:worker.id,kind:record.source==='external-receipts.jsonl'?'http':'stdio',callId:call.data.callId,receipt:record.output.receipt});}
      const managed=snapshot.invocations.filter(record=>record.source==='managed'&&record.phase==='completed'&&record.tool==='measure'&&record.input.sample===supplied.sample);
      for(const record of managed)if(JSON.stringify(results(worker,call)).includes(record.invocationId))verified.push({workerId:worker.id,kind:'managed',callId:call.data.callId,receipt:record.invocationId});
    }
  }
  assert(verified.some(value=>['managed','http','stdio'].every(kind=>verified.some(other=>other.workerId===value.workerId&&other.kind===kind))),'Missing one mixed worker with independently matched real-provider calls for all three capability kinds');
  return {verified:[...new Map(verified.map(value=>[value.receipt,value])).values()]};
});
await check('credential-secrecy',async()=>{
  const secretFile=await read(config.environmentConfig),credentialFile=resolve(config.environmentConfig,'..',secretFile.credentialFile),credentials=await read(credentialFile);
  const text=JSON.stringify(snapshots);for(const value of Object.values(credentials.credentials))assert(!text.includes(value.value));
  assert(!/Bearer\s+[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}/i.test(text));return {snapshots:snapshots.length};
});

const apiReports=[];
try{for(const label of await readdir(join(base,'api-cases')))apiReports.push(await retain(join(base,'api-cases',label,'report.json')));}catch(error){if(error.code!=='ENOENT')throw error;}
await check('public-api-provider-cases',async()=>{
  const report=apiReports.findLast(value=>value.complete&&value.cases.every(entry=>entry.status==='pass'));
  if(!report)throw Object.assign(new Error('No complete public-API provider supplement'),{code:'ENOENT'});
  assert.equal(report.transport,'public-main-api');assert(!report.cleanupPending?.length,'API campaign has unconfirmed process cleanup');
  const find=name=>{const value=report.cases.find(value=>value.name===name);assert(value&&value.status==='pass',`Missing API case ${name}`);return value;};
  const mixed=find('mixed-first-send'),mixedAfter=snapshot(mixed.after),mixedWorker=worker(mixedAfter,mixed.workerId);
  assert(mixedWorker.environment.locked);assert.equal(worker(snapshot(mixed.before),mixed.workerId).harnessSessionId,null);
  const measure=invocation(mixedAfter,mixed.workerId,'managed',mixed.sample),remote=invocation(mixedAfter,mixed.workerId,'http',mixed.sample),local=invocation(mixedAfter,mixed.workerId,'stdio',mixed.sample);
  assert.equal(remote.input.value,measure.value);assert.equal(local.input.value,remote.value);
  const resumed=find('retained-definition-resume'),resumeAfter=snapshot(resumed.after),old=worker(resumeAfter,resumed.workerId),fresh=worker(resumeAfter,resumed.newWorkerId);
  assert.equal(old.harnessSessionId,resumed.sessionId);assert.equal(old.environment.selection.revisionId,resumed.oldRevision);assert.equal(fresh.environment.selection.revisionId,resumed.newRevision);assert.notEqual(resumed.oldRevision,resumed.newRevision);
  invocation(resumeAfter,resumed.workerId,'stdio',resumed.oldLabel,1);invocation(resumeAfter,resumed.newWorkerId,'stdio',resumed.newLabel,2);
  const isolation=find('concurrent-close-isolation'),beforeIsolation=snapshot(isolation.before),afterIsolation=snapshot(isolation.after),survivorBefore=worker(beforeIsolation,isolation.survivorWorkerId),survivorAfter=worker(afterIsolation,isolation.survivorWorkerId),closed=worker(afterIsolation,isolation.closedWorkerId);
  assert.equal(closed.state,'inactive');assert.equal(closed.cleanupPending,false);assert.equal(survivorBefore.harnessSessionId,survivorAfter.harnessSessionId);assert.equal(survivorBefore.processId,survivorAfter.processId);
  const slow=invocation(afterIsolation,isolation.survivorWorkerId,'managed',isolation.sample),continuation=invocation(afterIsolation,isolation.survivorWorkerId,'stdio',isolation.sample,2);assert.equal(continuation.input.value,slow.value);
  for(const name of ['authentication-setup-retry','missing-prerequisite-setup-retry']){
    const retry=find(name),before=snapshot(retry.before),failed=snapshot(retry.failed),after=snapshot(retry.after),failedWorker=worker(failed,retry.workerId),afterWorker=worker(after,retry.workerId);
    assert.equal(before.budget.requests,failed.budget.requests);const receipt=failedWorker.submissions.find(value=>value.id===retry.submissionId);assert(receipt?.retryable);assert.equal(receipt.state,'failed');
    assert.equal(events(failedWorker).filter(value=>value.type==='request/header').length,0);assert.equal(afterWorker.submissions.filter(value=>value.id===retry.submissionId).length,1);assert.equal(afterWorker.submissions.find(value=>value.id===retry.submissionId).state,'completed');
  }
  const none=find('no-environment-cold-history'),noneBefore=snapshot(none.before),noneAfter=snapshot(none.after),noneWorker=worker(noneAfter,none.workerId);
  assert.equal(noneBefore.budget.requests,noneAfter.budget.requests);assert.equal(noneWorker.state,'inactive');assert.equal(noneWorker.cleanupPending,false);assert.equal(noneWorker.environment.selection,null);assert(noneWorker.environment.locked);
  for(const request of events(noneWorker).filter(value=>value.type==='request/header'))assert(!request.data.header.tools.some(tool=>tool.name.startsWith('mcp__')));
  for(const value of noneAfter.workers.filter(value=>value.projectId===report.projectId)){assert.equal(value.state,'inactive');assert.equal(value.cleanupPending,false);}
  return {label:report.label,projectId:report.projectId,cases:report.cases.map(value=>value.name),requests:report.finalBudget.requests-report.initialBudget.requests,failedAttempts:apiReports.filter(value=>!value.complete).map(value=>({label:value.label,error:value.error}))};
});

const required=['repository-ui-add','mcp-ui-preview-add','definition-revision-edit','mixed-environment-apply','composer-assignment','retained-revision-resume','safe-setup-retry','closing-worker-isolation','no-environment-and-history'];
let reviews={};try{reviews=await read(join(base,'browser-cases.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
for(const name of required)await check(name,async()=>{
  const spec=reviews[name];if(!spec)throw Object.assign(new Error('No retained browser case'),{code:'ENOENT'});
  if(['user-excluded','pending'].includes(spec.status))throw Object.assign(new Error(`${spec.status}: ${spec.observations?.join(' ')??'Browser case incomplete'}`),{code:'ENOENT'});
  assert.equal(spec.passed,true);assert(typeof spec.reviewer==='string'&&spec.reviewer.trim());assert(Array.isArray(spec.observations)&&spec.observations.length>0);assert(Array.isArray(spec.screenshots)&&spec.screenshots.length>0);
  for(const path of spec.screenshots){const absolute=resolve(base,path);assert(!relative(base,absolute).startsWith('..'),'Screenshot must stay inside campaign');const bytes=await readFile(absolute);assert(bytes.length>0);used.push({path,sha256:sha(bytes),bytes:bytes.length});}
  assert(Array.isArray(spec.snapshots)&&spec.snapshots.length>0);for(const label of spec.snapshots)assert(snapshots.some(value=>value.label===label),'Referenced snapshot missing');
  return spec;
});
const report={campaign:'adr011',auditedAt:new Date().toISOString(),qualified:checks.every(value=>value.status==='pass'),publicApiSupplementPassed:checks.find(value=>value.name==='public-api-provider-cases')?.status==='pass',checks,artifacts:used};
await mkdir(destination,{recursive:true});await writeFile(join(destination,'audit.json'),JSON.stringify(report,null,2)+'\n');
// Export owner records, not model narrative or full streaming chunks. Original
// snapshots and failed attempts remain intact under the private campaign root.
const latestWorkers=new Map(),receipts=new Map();
for(const evidence of [...snapshots].sort((left,right)=>Date.parse(left.at)-Date.parse(right.at))){
  for(const value of evidence.workers)latestWorkers.set(value.id,{id:value.id,projectId:value.projectId,title:value.title,state:value.state,sessionId:value.harnessSessionId,environment:value.environment,cleanupPending:value.cleanupPending??null,submissions:value.submissions,
    requests:events(value).filter(event=>event.type==='request/header').map(event=>({seq:event.seq,time:event.time,provider:event.data.header.config.provider,model:event.data.header.config.model,tools:event.data.header.tools.map(tool=>tool.name)})),
    usage:events(value).filter(event=>event.type==='assistant/message'&&event.data.usage).map(event=>({seq:event.seq,...event.data.usage})),
    calls:calls(value).map(call=>({seq:call.seq,callId:call.data.callId,name:call.data.name,arguments:input(call),results:results(value,call)}))});
  for(const value of evidence.invocations)if(value.invocationId||value.output?.receipt)receipts.set(`${value.source}:${value.invocationId??value.output.receipt}:${value.phase}`,value);
}
const ownerEvidence={campaign:'adr011',snapshots:snapshots.map(value=>({label:value.label,at:value.at,budget:value.budget,sourceDigest:value.identity.digest,runtimeDigest:value.runtime?.identity.digest??null})),apiReports,workers:[...latestWorkers.values()],receipts:[...receipts.values()]};
const encoded=JSON.stringify(ownerEvidence,null,2);assert(!/Bearer\s+[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}/i.test(encoded),'Credential-like content prevented evidence export');
const rack=await read(config.environmentConfig),credentials=await read(resolve(config.environmentConfig,'..',rack.credentialFile));for(const value of Object.values(credentials.credentials))assert(!encoded.includes(value.value),'Private credential prevented evidence export');
await writeFile(join(destination,'owner-evidence.json'),encoded.replaceAll(sourceRoot,'<V5>')+'\n');
console.log(JSON.stringify({qualified:report.qualified,checks:checks.map(({name,status})=>({name,status}))},null,2));if(!report.qualified)process.exitCode=1;
