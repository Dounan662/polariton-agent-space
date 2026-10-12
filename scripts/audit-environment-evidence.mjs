#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';

/** Independently checks retained evidence, never requests a provider or executes package build scripts.
 * Campaign replay checks and additional numerical boundary probes are reported separately.
 */
const root=fileURLToPath(new URL('../',import.meta.url));
const attempt=Number(process.argv[2]??1);
assert(Number.isSafeInteger(attempt)&&attempt>0,'Expected a positive attempt number');
const run=join(root,`.local/adr009/attempt-${attempt}`),repository=join(run,'builder');
const read=async name=>JSON.parse(await readFile(join(run,name),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',timeout:10000,maxBuffer:4194304});
const checks=[],boundaries=[];
async function check(name,work,group=checks){try{const detail=await work();group.push({name,status:'pass',...(detail?{detail}:{})});}catch(error){group.push({name,status:'fail',error:String(error.message??error).replaceAll(root,'<V5>/')});}}
const close=(actual,expected)=>assert(Number.isFinite(actual)&&Math.abs(actual-expected)<=1e-12+1e-10*Math.abs(expected),`Expected ${expected}, received ${actual}`);
const expected=args=>{
  // These extreme campaign cases have exact analytic answers; avoid overflow in the verifier itself.
  if(args.values.every(value=>value===args.values[0]))return {count:args.values.length,mean:args.values[0],standardDeviation:0};
  if(args.values.length===2&&args.values[0]===-args.values[1]&&!args.weights)return {count:2,mean:0,standardDeviation:Math.abs(args.values[0])};
  const rawWeights=args.weights??args.values.map(()=>1),maximum=Math.max(...rawWeights);
  const weights=rawWeights.map(value=>value/maximum),total=weights.reduce((a,b)=>a+b,0);
  const mean=args.values.reduce((sum,value,index)=>sum+value*(weights[index]/total),0);
  return {count:args.values.length,mean,standardDeviation:Math.sqrt(args.values.reduce((sum,value,index)=>sum+(weights[index]/total)*(value-mean)**2,0))};
};
const invalid=args=>!args.values.length||(args.weights&&(args.weights.length!==args.values.length||args.weights.some(w=>w<0)||args.weights.every(w=>w===0)));
function verifyResult(args,result){
  const text=result.content.filter(value=>value.type==='text').map(value=>value.text).join('\n');
  if(invalid(args)){assert.equal(result.isError,true);assert(text.trim().length>0,'Error must be visible');return {error:text};}
  assert.notEqual(result.isError,true);const value=JSON.parse(text),oracle=expected(args);
  assert.equal(value.count,oracle.count);close(value.mean,oracle.mean);close(value.standardDeviation,oracle.standardDeviation);
  if(result.structuredContent)assert.deepEqual(result.structuredContent,value);
  return value;
}
const report=await read('report.json'),inventory=await read('inventory.json');
for(const version of [1,2]){
  await check(`consumer-r${version}-actual-mcp-results`,async()=>{
    const history=await read(`consumer-r${version}-history.json`);
    const calls=history.events.filter(event=>event.type==='tool/call');
    assert.equal(calls.length,version===1?3:6);
    assert(calls.every(event=>/^mcp__statistics0__(statistics|weighted_statistics)$/.test(event.data.name)),'Consumer used a substitute tool');
    const results=history.events.filter(event=>event.type==='tool/result').flatMap(event=>event.data.message.content.filter(value=>value.type==='tool-result'));
    const seen=new Set(),records=[];
    for(const call of calls){
      const args=JSON.parse(call.data.arguments),matches=results.filter(value=>value.toolCallId===call.data.callId);
      assert.equal(matches.length,1,'Each call must have exactly one matching recorded completion');
      const value=verifyResult(args,matches[0]);
      seen.add(invalid(args)?!args.values.length?'empty':args.weights.length!==args.values.length?'length':args.weights.some(w=>w<0)?'negative':'zero':args.weights?args.weights[0]===0?'zero-weight':'weighted':args.values.length===1?'singleton':'population');
      records.push({tool:call.data.name,arguments:args,returned:value});
    }
    assert.deepEqual([...seen].sort(),(version===1?['population','singleton','empty']:['weighted','zero-weight','negative','zero','length','population']).sort());
    return {sessionId:history.header.id,records};
  });
  await check(`oracle-r${version}-structured-results`,async()=>{const records=await read(`oracle-r${version}.json`);assert(records.length>=(version===1?3:8));for(const record of records)verifyResult(record.arguments,record.result);if(attempt>=2){assert(records.some(value=>value.arguments.values?.[0]===1e308&&value.arguments.values?.[1]===1e308));assert(records.some(value=>value.arguments.values?.[0]===1e308&&value.arguments.values?.[1]===-1e308));if(version===2)assert(records.some(value=>value.arguments.weights?.[0]===1e308&&value.arguments.weights?.[1]===1e308));}return {records:records.length};});
  const release=inventory.releases.find(value=>value.id===`live-r${version}-${attempt}`);
  await check(`r${version}-git-artifact-provenance`,async()=>{
    assert(release);assert.equal(git('rev-parse',`${release.commit}^{commit}`).trim(),release.commit);
    const directory=join(root,'.local/adr009/rack/releases',release.id);
    assert.equal(sha(await readFile(join(directory,'artifact.tar'))),release.artifactDigest);
    // Audit the recorded ADR-009 tree identity; historical commits are immutable.
    assert.deepEqual(JSON.parse(git('show',`${release.commit}:labra-capability.json`)),release.manifest);
    for(const [file,hash]of Object.entries(release.locks))assert.equal(sha(git('show',`${release.commit}:${file}`)),hash);
    for(const file of ['statistics.mjs','server.mjs','test.mjs','server-support.mjs'])assert.equal(await readFile(join(directory,'artifact',file),'utf8'),git('show',`${release.commit}:${file}`));
    return {releaseId:release.id,commit:release.commit,artifactDigest:release.artifactDigest};
  });
  const source=git('show',`${release.commit}:statistics.mjs`);
  const evaluate=expression=>runInNewContext(`${source.replace(/export function /g,'function ')}\n${expression}`,{}, {timeout:1000});
  await check(`r${version}-nonfinite-rejection`,()=>{
    for(const expression of ['statistics([NaN])','statistics([Infinity])','statistics([-Infinity])',...(version===2?['weightedStatistics([1],[Infinity])','weightedStatistics([1],[NaN])']:[])])assert.throws(()=>evaluate(expression));
  });
  await check(`r${version}-finite-large-equal-measurements`,()=>{
    const result=evaluate('statistics([1e308,1e308])');close(result.mean,1e308);close(result.standardDeviation,0);
  },boundaries);
  if(version===2)await check('r2-finite-large-weights',()=>{
    const result=evaluate('weightedStatistics([1,3],[1e308,1e308])');close(result.mean,2);close(result.standardDeviation,1);
  },boundaries);
}
await check('version-resources-and-retained-revisions',async()=>{
  for(const version of [1,2]){
    const releaseId=`live-r${version}-${attempt}`;let observation=inventory.observations.find(value=>value.releaseId===releaseId&&value.source==='stats://capability');
    if(!observation){try{observation=await read(`version-r${version}.json`);}catch(error){if(error.code!=='ENOENT')throw error;}}
    assert.equal(observation?.releaseId,releaseId,'Runtime version evidence must identify the audited release');
    assert(observation?.available);const value=JSON.parse(observation.value.contents[0].text);assert.equal(value.version,version);
    assert.deepEqual(value.operations,version===1?['statistics']:['statistics','weighted_statistics']);
    const revision=JSON.parse(await readFile(join(root,`.local/adr009/rack/environments/live-environment-${attempt}/revisions/live-e${version}-${attempt}.json`),'utf8'));
    assert.equal(revision.components[0].releaseId,releaseId);
    assert(inventory.realizations.some(value=>value.revisionId===revision.revisionId&&value.status==='ready'));
  }
  assert.equal(inventory.realizations.find(value=>value.id===`reproduce-${attempt}`).revisionId,`live-e1-${attempt}`);
});
await check('defective-candidate-rejected',()=>{assert.equal(inventory.operations.find(value=>value.id===`defective-${attempt}`).state,'failed');assert(!inventory.releases.some(value=>value.id===`defective-${attempt}`));});
await check('distinct-builder-and-consumer-contexts',()=>{assert.equal(new Set(report.sessions.map(value=>value.sessionId)).size,3);assert.deepEqual(report.sessions.map(value=>value.role).sort(),['builder','consumer-r1','consumer-r2']);});
await check('durable-provider-budget',async()=>{
  const limits=JSON.parse(await readFile(join(root,'config/adr009-campaign.json'),'utf8'));
  const db=new DatabaseSync(resolve(root,'config',limits.ledger),{readOnly:true});
  try{const saved=db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();assert(saved.requests>=report.budget.requests);assert(saved.requests<=limits.maxRequests);assert(saved.elapsed<=limits.maxLiveMs);assert.equal(report.expired,false);return {attempt:report.budget,cumulative:saved,providerRequestsMadeByAudit:0};}finally{db.close();}
});
const output={attempt,scope:'Independent replay of retained consumer results, artifact/source identities and additional finite-input boundaries; no provider requests or container actions',campaignEvidencePassed:checks.every(value=>value.status==='pass'),additionalBoundariesPassed:boundaries.every(value=>value.status==='pass'),passed:[...checks,...boundaries].every(value=>value.status==='pass'),checks,boundaries};
const destination=join(root,'docs/evidence/adr009/independent-audit.json');await mkdir(join(root,'docs/evidence/adr009'),{recursive:true});const encoded=JSON.stringify(output,null,2)+'\n';await writeFile(join(root,`docs/evidence/adr009/independent-audit-attempt-${attempt}.json`),encoded);await writeFile(destination,encoded);
console.log(JSON.stringify({attempt,campaignEvidencePassed:output.campaignEvidencePassed,additionalBoundariesPassed:output.additionalBoundariesPassed,checks:checks.length,boundaries:boundaries.length,failed:[...checks,...boundaries].filter(value=>value.status==='fail').map(value=>({name:value.name,error:value.error})),report:'docs/evidence/adr009/independent-audit.json'}));
if(!output.passed)process.exitCode=1;
