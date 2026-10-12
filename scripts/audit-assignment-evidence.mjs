import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {sourceRoot,CampaignConfig} from '../src/config.ts';

/** Independent read-only audit of browser-driven Main runs. Missing evidence is
 * incomplete, never a pass. This script cannot request a model or run a capability.
 * Browser screenshots require a separate recorded reviewer verdict; numerical,
 * routing, admission, isolation and replay claims are checked against owner records.
 */
const base=join(sourceRoot,'.local/adr010'),destination=join(sourceRoot,'docs/evidence/adr010');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const Key=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),Text=z.string().min(1);
const Browser=z.object({screenshots:z.array(Text).min(1),review:Text}).strict();
const CaseBase=z.object({after:Key,browser:Browser});
const Cases=z.object({
  first:CaseBase.extend({before:Key,workerId:Text,sample:Text,model:Text}).optional(),
  none:CaseBase.extend({workerId:Text}).optional(),
  isolation:CaseBase.extend({before:Key,measurementWorkerId:Text,transformWorkerId:Text,closedWorkerId:Text,survivorWorkerId:Text,survivorSample:Text}).optional(),
  pinning:CaseBase.extend({before:Key,workerId:Text,newWorkerId:Text,sample:Text,newSample:Text}).optional(),
  model:CaseBase.extend({before:Key,workerId:Text,sample:Text,firstModel:Text,secondModel:Text,rejection:Text}).optional(),
  retry:CaseBase.extend({before:Key,failed:Key,workerId:Text,sample:Text,submissionId:Text}).optional(),
  failure:CaseBase.extend({before:Key,workerId:Text,errorSample:Text,slowSample:Text,recoverySample:Text,otherWorkerId:Text,otherSample:Text}).optional(),
}).strict();
const names=['first','none','isolation','pinning','model','retry','failure'];
const checks=[],used=new Map(),snapshots=new Map();
const artifact=path=>{const resolved=resolve(base,path);assert(!relative(base,resolved).startsWith('..'),'Evidence must stay inside the campaign directory');return resolved;};
const retain=async path=>{const bytes=await readFile(path);used.set(relative(base,path),{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});return bytes;};
const snapshot=async name=>{if(!snapshots.has(name)){const bytes=await retain(join(base,'snapshots',name,'evidence.json'));snapshots.set(name,JSON.parse(bytes));}return snapshots.get(name);};
const worker=(snapshot,id)=>{const result=snapshot.workers.find(value=>value.id===id);assert(result,`Missing worker ${id}`);return result;};
const events=value=>value.history?.events??[];
const requests=value=>events(value).filter(event=>event.type==='request/header');
const route=request=>JSON.stringify([request.data.header.config.provider,request.data.header.config.model]);
const tools=value=>new Set(requests(value).flatMap(request=>request.data.header.tools.map(tool=>tool.name)));
const calls=value=>events(value).filter(event=>event.type==='tool/call');
const callInput=event=>typeof event.data.arguments==='string'?JSON.parse(event.data.arguments):event.data.arguments;
const userMessages=value=>events(value).filter(event=>event.type==='user/message'&&event.data.source?.kind==='user');
const measurementValue=(seed,sample)=>Number.parseInt(createHash('sha256').update(seed+':'+sample).digest('hex').slice(0,8),16)%10000;
let cases={},seed;
try{cases=Cases.parse(await read(join(base,'cases.json')));seed=(await read(join(base,'setup.json'))).seed;}
catch(error){if(error.code!=='ENOENT')throw error;}

async function check(name,fn){try{const details=await fn();checks.push({name,status:'pass',...details});}catch(error){checks.push({name,status:error.code==='ENOENT'?'incomplete':'fail',error:String(error.message??error).replaceAll(sourceRoot,'<V5>')});}}

function verifyCall(evidence,value,sample,role,{version=1,since=0,error=false}={}){
  const tool=role==='measurement'?'measure':'transform';
  const matching=calls(value).filter(event=>event.time>=since&&event.data.name.endsWith(`__${tool}`)&&callInput(event).sample===sample);
  assert.equal(matching.length,1,`Expected one ${tool} call for ${sample}`);const call=matching[0],input=callInput(call);
  const results=events(value).filter(event=>event.type==='tool/result').flatMap(event=>event.data.message.content.filter(part=>part.type==='tool-result'&&part.toolCallId===call.data.callId));
  assert.equal(results.length,1,`Missing unique DSH result for ${sample}`);
  const records=evidence.invocations.filter(record=>record.role===role&&record.input.sample===sample&&record.phase==='completed'&&record.version===version&&Date.parse(record.at)>=since);
  assert.equal(records.length,1,`Expected one independent completion for ${sample}`);const record=records[0];
  for(const [key,expected]of Object.entries(input))assert.deepEqual(record.input[key],expected,`Actual ${key} differs from DSH call`);
  assert(JSON.stringify(results[0]).includes(record.invocationId),'Server receipt is absent from DSH result');
  assert.equal(Boolean(record.result.isError),error);assert.equal(Boolean(results[0].isError),error);
  if(!error){
    const output=record.result.structuredContent;
    assert.equal(output.receipt,record.invocationId);assert.equal(output.sample,sample);assert.equal(output.version,version);
    const expected=role==='measurement'?measurementValue(seed,sample):record.input.value*(version===1?3:7)+(version===1?11:19);
    assert.equal(output.value,expected);assert(JSON.stringify(results[0]).includes(String(expected)));
  }
  return {callId:call.data.callId,record,call};
}
function pipeline(evidence,value,sample,options){
  const measure=verifyCall(evidence,value,sample,'measurement',options),transform=verifyCall(evidence,value,sample,'transform',options);
  assert.equal(transform.record.input.measurementReceipt,measure.record.invocationId);
  assert.equal(transform.record.input.value,measure.record.result.structuredContent.value);
  assert(transform.call.seq>measure.call.seq,'Transform must consume the earlier measurement');
  return {sample,workerId:value.id,sessionId:value.harnessSessionId,measurementCall:measure.callId,transformCall:transform.callId,measurementReceipt:measure.record.invocationId,transformReceipt:transform.record.invocationId};
}
async function browserProof(name,spec){
  for(const path of spec.screenshots){const bytes=await retain(artifact(path));assert(bytes.length>0,'Empty browser screenshot');}
  const review=JSON.parse(await retain(artifact(spec.review)));
  assert.equal(review.scenario,name);assert.equal(review.passed,true);assert(typeof review.reviewer==='string'&&review.reviewer.trim());
  assert(Array.isArray(review.observations)&&review.observations.length>0,'Browser review must record observed behavior');
  assert.deepEqual([...review.screenshots].sort(),[...spec.screenshots].sort());
}

for(const name of names){
  const spec=cases[name];if(!spec){checks.push({name,status:'incomplete',error:'No retained case specification'});continue;}
  await check(name,async()=>{
    const after=await snapshot(spec.after),value=spec.workerId?worker(after,spec.workerId):null;
    let detail={};
    if(name==='first'){
      const before=worker(await snapshot(spec.before),spec.workerId);
      assert.equal(before.harnessSessionId,null);assert.equal(before.environment.locked,false);assert.equal(before.model,spec.model);
      assert(value.environment.locked&&value.environment.selection);assert.deepEqual(value.environment.selection,before.environment.selection);assert.equal(route(requests(value)[0]),spec.model);
      const app=await read(join(sourceRoot,'config/adr010-app.json'));assert.notEqual(spec.model,JSON.stringify([app.provider,app.model]),'First message must use non-default route');
      detail=pipeline(after,value,spec.sample);
    }else if(name==='none'){
      assert.equal(value.environment.locked,true);assert.equal(value.environment.selection,null);
      assert(requests(value).length>0);assert([...tools(value)].every(name=>!name.startsWith('mcp__')));
      assert(after.inventory.bindings.every(binding=>binding.principal!==value.id||binding.released),'No-environment worker acquired a grant');
      assert(calls(value).some(event=>!event.data.name.startsWith('mcp__')),'Built-in tool execution is required');
      assert(value.submissions.some(submission=>submission.kind==='prompt'&&submission.state==='completed'));
    }else if(name==='isolation'){
      const before=await snapshot(spec.before),measurement=worker(after,spec.measurementWorkerId),transform=worker(after,spec.transformWorkerId);
      assert([...tools(measurement)].some(name=>name.endsWith('__measure')));assert([...tools(measurement)].every(name=>!name.endsWith('__transform')));
      assert([...tools(transform)].some(name=>name.endsWith('__transform')));assert([...tools(transform)].every(name=>!name.endsWith('__measure')));
      const closedBefore=worker(before,spec.closedWorkerId),survivorBefore=worker(before,spec.survivorWorkerId),closed=worker(after,spec.closedWorkerId),survivor=worker(after,spec.survivorWorkerId);
      assert(closedBefore.harnessSessionId&&survivorBefore.harnessSessionId);assert.equal(closed.state,'inactive');
      const mount='adr010-measurement-r1';assert.equal(after.inventory.mounts.find(value=>value.id===mount).state,'running');
      const activeBefore=before.inventory.bindings.filter(binding=>binding.mountId===mount&&!binding.released&&binding.access==='call');
      const activeAfter=after.inventory.bindings.filter(binding=>binding.mountId===mount&&!binding.released&&binding.access==='call');
      assert(activeBefore.length>=2);assert.equal(activeAfter.length,activeBefore.length-1);
      detail={survivorCall:verifyCall(after,survivor,spec.survivorSample,'measurement',{since:Date.parse(before.at)}).callId};
      const interval=value=>{const turns=events(value).filter(event=>event.type==='turn/start');return turns.map(start=>[start.time,events(value).find(event=>event.type==='turn/end'&&event.data.turn===start.data.turn)?.time??Infinity]);};
      assert(interval(measurement).some(a=>interval(transform).some(b=>a[0]<b[1]&&b[0]<a[1])),'Different environment workers must execute concurrently');
    }else if(name==='pinning'){
      const before=await snapshot(spec.before),old=worker(before,spec.workerId),fresh=worker(after,spec.newWorkerId);
      assert.equal(old.environment.selection.revisionId,'adr010-pair-r1');assert.deepEqual(value.environment,old.environment);
      assert.equal(value.harnessSessionId,old.harnessSessionId);assert.equal(value.model,old.model);
      assert.equal(fresh.environment.selection.revisionId,'adr010-pair-r2');
      detail={retained:pipeline(after,value,spec.sample,{version:1,since:Date.parse(before.at)}),fresh:pipeline(after,fresh,spec.newSample,{version:2})};
      const runs=(await retain(join(base,'runs.jsonl'))).toString().trim().split('\n').map(line=>JSON.parse(line));
      assert(runs.some(run=>run.event==='stopped'&&Date.parse(run.at)>=Date.parse(before.at)&&Date.parse(run.at)<=Date.parse(after.at)),'Graceful Main restart evidence missing');
      assert(runs.some(run=>run.event==='started'&&Date.parse(run.at)>=Date.parse(before.at)&&Date.parse(run.at)<=Date.parse(after.at)));
    }else if(name==='model'){
      const before=await snapshot(spec.before),old=worker(before,spec.workerId);
      assert.notEqual(spec.firstModel,spec.secondModel);assert.equal(route(requests(old).at(-1)),spec.firstModel);
      assert.equal(route(requests(value).at(-1)),spec.secondModel);assert.equal(value.model,spec.secondModel);assert.deepEqual(value.environment,old.environment);
      const rejection=JSON.parse(await retain(artifact(spec.rejection)));assert(['main-public-module','browser-http'].includes(rejection.source),'Rejection proof must identify its actual boundary');assert.equal(rejection.status,409);assert.equal(rejection.body.error.code,'MODEL_BUSY');
      if(rejection.source==='main-public-module'){assert.equal(rejection.workerId,value.id);assert.equal(rejection.workerState,'running');}
      detail=pipeline(after,value,spec.sample,{since:Date.parse(before.at),version:value.environment.selection.revisionId.endsWith('r2')?2:1});
    }else if(name==='retry'){
      const before=await snapshot(spec.before),failed=await snapshot(spec.failed),failedWorker=worker(failed,spec.workerId);
      assert.equal(failed.budget.requests,before.budget.requests,'Setup failure admitted a provider request');
      assert.equal(requests(failedWorker).length,0);assert.equal(failedWorker.harnessSessionId,null);assert.equal(failedWorker.submissions.find(value=>value.id===spec.submissionId).state,'failed');
      assert.equal(value.submissions.filter(value=>value.id===spec.submissionId).length,1);assert.equal(value.submissions.find(value=>value.id===spec.submissionId).state,'completed');
      assert.equal(userMessages(value).filter(message=>JSON.stringify(message.data.content).includes(spec.sample)).length,1,'Retry duplicated the message');
      detail=pipeline(after,value,spec.sample);
      const owned=after.workers.filter(candidate=>candidate.harnessSessionId===value.harnessSessionId);assert.equal(owned.length,1);
      const faultMounts=after.inventory.mounts.filter(mount=>mount.id.endsWith('-fault'));
      for(const mount of faultMounts)assert.equal(after.inventory.bindings.filter(binding=>binding.mountId===mount.id&&!binding.released&&binding.access==='call').length,1,'Retry leaked grants');
    }else if(name==='failure'){
      const before=await snapshot(spec.before),since=Date.parse(before.at);
      verifyCall(after,value,spec.errorSample,'measurement',{error:true,since});
      const slow=after.invocations.filter(record=>record.input.sample===spec.slowSample&&record.phase==='started');assert.equal(slow.length,1,'Interrupted call missing or replayed');
      assert(value.submissions.some(submission=>submission.state==='interrupted'&&submission.text.includes(spec.slowSample)));
      const slowCalls=calls(value).filter(event=>event.time>=since&&event.data.name.endsWith('__measure')&&callInput(event).sample===spec.slowSample);
      assert.equal(slowCalls.length,1,'Expected exactly one DSH slow call');const slowCall=slowCalls[0];
      const slowResults=events(value).filter(event=>event.type==='tool/result'&&event.data.message.content.some(part=>part.type==='tool-result'&&part.toolCallId===slowCall.data.callId&&part.isError===true));
      assert.equal(slowResults.length,1,'Expected one error result for the interrupted DSH call');
      const aborted=events(value).find(event=>event.type==='turn/end'&&event.data.turn===slowCall.data.turn&&event.seq>slowResults[0].seq);
      assert.deepEqual(aborted?.data.reason,{kind:'aborted',reason:{kind:'user'}},'The matching DSH turn must record user cancellation');
      const unrelated=verifyCall(after,worker(after,spec.otherWorkerId),spec.otherSample,'measurement',{since:Date.parse(slow[0].at)});
      const slowEnd=after.invocations.find(record=>record.input.sample===spec.slowSample&&record.phase!=='started');
      assert(slowEnd&&Date.parse(unrelated.record.at)<Date.parse(slowEnd.at),'Unrelated worker must respond while the slow tool is still active');
      assert(slowResults[0].time<Date.parse(slowEnd.at),'DSH cancellation must settle before the independent remote invocation');
      detail={recovery:pipeline(after,value,spec.recoverySample,{since}),unrelatedCall:unrelated.callId,
        cancelledCall:slowCall.data.callId,cancelledTurn:slowCall.data.turn,cancellationReason:aborted.data.reason,
        retainedSlowAttempts:calls(value).filter(event=>event.time>=since&&event.data.name.endsWith('__measure')&&callInput(event).mode==='slow').map(call=>{
          const sample=callInput(call).sample,end=events(value).find(event=>event.type==='turn/end'&&event.data.turn===call.data.turn);
          const remote=after.invocations.filter(record=>record.input.sample===sample&&record.phase!=='started');
          return {sample,callId:call.data.callId,qualifyingCancellation:call.data.callId===slowCall.data.callId,turnReason:end?.data.reason??null,remoteOutcomes:remote.map(record=>({phase:record.phase,at:record.at}))};
        }),
        remoteSlowOutcome:after.invocations.filter(record=>record.input.sample===spec.slowSample&&record.phase!=='started').map(record=>record.phase)};
    }
    await browserProof(name,spec.browser);return {detail};
  });
}

await check('budget-and-source',async()=>{
  const limits=CampaignConfig.parse(await read(join(sourceRoot,'config/adr010-campaign.json')));
  const db=new DatabaseSync(resolve(sourceRoot,'config',limits.ledger),{readOnly:true});let budget;
  try{budget=db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}
  assert(budget.requests>0&&budget.requests<=limits.maxRequests);assert(budget.elapsed<=limits.maxLiveMs);
  assert(snapshots.size>0);for(const evidence of snapshots.values()){
    assert.equal(evidence.identity.dsh,'0.1.6-alpha.1');assert.equal(evidence.identity.digest,createHash('sha256').update(JSON.stringify(evidence.identity.files)).digest('hex'));
    for(const value of evidence.workers)for(const request of requests(value))assert(request.data.header.config.maxTokens<=limits.maxOutputTokens);
  }
  return {budget,providerRequestsMadeByAudit:0};
});
const result={at:new Date().toISOString(),passed:checks.length===8&&checks.every(check=>check.status==='pass'),checks,artifacts:Object.fromEntries(used),scope:'Retained public capability receipts, DSH read-adapter history, Main worker state, browser reviewer evidence; no provider requests'};
await mkdir(destination,{recursive:true});const filename=`independent-audit-${randomUUID()}.json`;await writeFile(join(destination,filename),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,report:relative(sourceRoot,join(destination,filename))},null,2));
if(!result.passed)process.exitCode=1;
