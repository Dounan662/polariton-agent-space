/** Real-provider acceptance through the public application and typed harness.
 * Both platforms share one retained ledger. Copy only the closed ledger between
 * hosts; concurrent runs are forbidden by the verification budget's time lease. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,mkdtemp,realpath,lstat,readdir} from 'node:fs/promises';
import {join,resolve,basename,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {z} from 'zod';
import {createApp} from '../src/main.ts';
import {loadConfig,CampaignConfig} from '../src/config.ts';
import {Harness} from '../harness/client.ts';
import {VerificationBudget} from '../harness/budget.mjs';
import {nativeTurn} from './native-turn.mjs';
import {serveHttp} from '../tests/fixtures/adr011/server.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
if(!process.argv.includes('--live'))throw new Error('Pass --live to admit real provider requests');
const platform=`${process.platform}-${process.arch}`,repair=process.argv.includes('--repair'),coreOnly=process.argv.includes('--core-only'),permissionOnly=process.argv.includes('--permission-only'),useReserve=process.argv.includes('--use-reserve');
if(coreOnly&&permissionOnly)throw new Error('Choose one verification scope');
if(!coreOnly&&!process.argv.includes('--allow-permission-probe-write'))throw new Error('Permission verification now requires explicit authorization for one outside-workspace synthetic nonce file; after that authorization pass --allow-permission-probe-write. No campaign attempt or provider request has started.');
if(!process.env.DEEPSEEK_API_KEY?.trim())throw new Error('Configured provider credential is unavailable');
const limits=CampaignConfig.parse(JSON.parse(await readFile(join(root,'config/adr018-campaign.json'),'utf8')));
const ledgerPath=resolve(root,'config',limits.ledger),base=join(root,'.local/adr018'),evidence=join(root,'docs/evidence/adr018');
await mkdir(base,{recursive:true});await mkdir(evidence,{recursive:true});
const campaign=new DatabaseSync(ledgerPath);
campaign.exec('CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,platform TEXT NOT NULL,started TEXT NOT NULL,repair INTEGER NOT NULL)');
const prior=campaign.prepare('SELECT id FROM attempts WHERE platform=? ORDER BY id DESC LIMIT 1').get(platform);
if(!repair&&prior){campaign.close();throw new Error('This platform already attempted acceptance; use --repair within the retained ledger');}
if(repair&&!prior){campaign.close();throw new Error('A corrective run requires an existing platform attempt');}
if(repair){let previous;try{previous=JSON.parse(await readFile(join(evidence,`${platform}-attempt-${prior.id}.json`),'utf8'));}catch(error){campaign.close();throw error;}if(previous.passed){campaign.close();throw new Error('The previous platform attempt passed; no corrective run is needed');}}
let reserveReason;
if(useReserve){for(const priorAttempt of campaign.prepare('SELECT id,platform FROM attempts ORDER BY id').all()){const retained=JSON.parse(await readFile(join(evidence,`${priorAttempt.platform}-attempt-${priorAttempt.id}.json`),'utf8'));if(retained.checks.some(check=>check.status==='fail')){reserveReason=`Corrected release continuation after retained failure ${priorAttempt.platform}-attempt-${priorAttempt.id}`;break;}}if(!reserveReason){campaign.close();throw new Error('Protected reserve requires retained evidence of a real failed campaign attempt');}}
campaign.prepare('INSERT INTO attempts(platform,started,repair) VALUES(?,?,?)').run(platform,new Date().toISOString(),Number(repair));
const attempt=campaign.prepare('SELECT MAX(id) id FROM attempts').get().id;campaign.close();
const run=await mkdtemp(join(base,`${platform}-${attempt}-`));
const config={...await loadConfig(join(root,'config/adr018-app.json')),stateRoot:join(run,'state')};
assert(config.maxOutputTokens<=limits.maxOutputTokens,'Output configuration exceeds campaign cap');
const report={attempt,reserveReason,scope:permissionOnly?'permission':coreOnly?'core':'full',platform,os:os.release(),node:process.version,started:new Date().toISOString(),provider:config.provider,model:config.model,limits,requests:0,checks:[],diagnostics:[],permissions:[],cleanup:[],budget:null,passed:false};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
report.lockfileSha256=hash(await readFile(join(root,'package-lock.json')));
report.package=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
if(process.platform==='linux')report.distribution=await readFile('/etc/os-release','utf8');
const scrub=value=>JSON.stringify(value,null,2).replaceAll(process.env.DEEPSEEK_API_KEY,'<REDACTED>').replaceAll(root,'<V5>').replaceAll(new URL('../',import.meta.url).href,'<V5>');
const check=(name,detail={})=>{report.checks.push({name,status:'pass',requests:report.requests,...detail});console.log(`PASS ${name}`);};
const ledger=new VerificationBudget(ledgerPath,repair||useReserve?{...limits,reserveRequests:0,reserveMs:0}:limits);
const reserve=()=>{const accepted=ledger.reserve();if(accepted)report.requests++;return accepted;};
let runtime,http,expired=false;const harnesses=[],byWorker=new Map();
const timer=setTimeout(()=>{expired=true;for(const h of harnesses)void h.close().catch(error=>{report.diagnostics.push({kind:'deadline-cleanup',message:error.message});});},ledger.remainingMs);
const until=async(ready,label)=>{const end=Date.now()+config.requestTimeoutMs;while(!await ready()){if(expired||Date.now()>=end)throw new Error(`Timed out: ${label}`);await delay(config.interruptPollMs);}};
try{
 runtime=await createApp(config,(settings,home,workspace,budget,permission)=>{
  const h=new Harness(settings,home,workspace,async()=>await budget()&&reserve(),permission);harnesses.push(h);byWorker.set(basename(home),h);return h;
 });
 await runtime.app.ready();
 runtime.agents.on('failure',notice=>report.diagnostics.push(notice));
 let cookie='';const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;
 const request=async(method,url,payload,headers={})=>{
  const response=await runtime.app.inject({method,url,headers:{host,origin,cookie,...headers},...(payload===undefined?{}:{payload})});
  assert(response.statusCode<400,`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response;
 };
 const auth=await request('POST','/api/bootstrap',{token:new URL(runtime.launchUrl).hash.slice('#token='.length)});
 cookie=auth.headers['set-cookie'].split(';')[0];
 const projectId=randomUUID();await request('POST','/api/projects',{id:projectId,name:'ADR-018 real-provider research'});
 const graph=(await request('GET',`/api/projects/${projectId}/graph`)).json(),nodeId=graph.nodes[0].id;
 const workers=`/api/projects/${projectId}/nodes/${nodeId}/workers`,workerId=randomUUID();
 await request('POST',workers,{id:workerId,title:'Release acceptance analyst'});
 const route=`${workers}/${workerId}`,workspace=runtime.tree.workspace(projectId,nodeId),view=()=>runtime.agents.get(workerId);
 await writeFile(join(workspace,'samples.csv'),'value\n2\n4\n4\n4\n5\n5\n7\n9\n');
 let permittedCall;
 const approve=()=>{for(const permission of view().permissions){
  if(report.permissions.some(value=>value.id===permission.id))continue;
  let args;try{args=JSON.parse(permission.detail);if(typeof args==='string')args=JSON.parse(args);}catch{}
  const allowed=!coreOnly&&!report.permissions.some(value=>value.allowed)&&permission.title==='bash'&&permittedCall?.safeParse(args).success===true;
  report.permissions.push({id:permission.id,title:permission.title,detail:permission.detail,allowed});
  const option=permission.options.find(value=>value.kind===(allowed?'allow_once':'reject_once'));
  if(!option)throw new Error('Verification permission has no required response option');
  runtime.agents.permission(projectId,nodeId,workerId,permission.id,option.optionId);
 }};
 runtime.agents.on('change',approve);
 const send=async(text,content)=>{
  const id=randomUUID();await request('POST',`${route}/submissions`,{id,text,...content?{content}:{}});
  await until(()=>['failed','uncertain','interrupted'].includes(runtime.agents.submission(id).state)||runtime.agents.submission(id).state==='applied'&&view().state==='idle',`input ${id}`);
  assert.equal(runtime.agents.submission(id).state,'applied',JSON.stringify(runtime.agents.submission(id)));
  const snapshot=await runtime.agents.observe(projectId,nodeId,workerId);
  assert(snapshot.page);return {id,snapshot};
 };
 if(!permissionOnly){
 const research=await send('Read samples.csv using your actual workspace tools. Compute count, arithmetic mean, and population standard deviation. Write analysis.json with exactly {"count":8,"mean":5,"populationStandardDeviation":2}, deriving those values from the file. Also write a concise report.md explaining the calculation. Use tools and verify your saved files. Do not use subagents or make network requests.');
 const result=JSON.parse(await readFile(join(workspace,'analysis.json'),'utf8'));
 assert.deepEqual(result,{count:8,mean:5,populationStandardDeviation:2});assert((await readFile(join(workspace,'report.md'),'utf8')).length>0);
 assert(research.snapshot.page.events.some(event=>event.type==='tool/call'));check('public-research-workflow-files-and-independent-numeric-oracle',{workerId});
 const requestsBefore=report.requests;await request('POST',`${route}/submissions`,{id:research.id,text:'Read samples.csv using your actual workspace tools. Compute count, arithmetic mean, and population standard deviation. Write analysis.json with exactly {"count":8,"mean":5,"populationStandardDeviation":2}, deriving those values from the file. Also write a concise report.md explaining the calculation. Use tools and verify your saved files. Do not use subagents or make network requests.'});
 assert.equal(report.requests,requestsBefore);check('durable-public-submission-deduplication');
 }
 if(!coreOnly){
 const permissionMarker=randomUUID(),probeParent=join(base,'permission-probes');
 await mkdir(probeParent,{recursive:true,mode:0o700});
 const probeDirectory=join(probeParent,randomUUID());await mkdir(probeDirectory,{mode:0o700});
 const probeFile=join(await realpath(probeDirectory),'nonce.txt');
 for(const writable of [workspace,os.tmpdir(),'/tmp']){
  const path=relative(await realpath(writable),probeFile);
  assert(path==='..'||path.startsWith('..'+sep)||isAbsolute(path),'The permission probe must be outside the standing workspace and temporary writable roots');
 }
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 const command=`printf '%s' ${quote(permissionMarker)} > ${quote(probeFile)}`,description='Write the authorized synthetic approval probe nonce.',justification='The sandbox denied this exact write because the owned probe file is outside the workspace; allow this one 36-byte nonce file.';
 report.permissionProbe={file:probeFile,bytes:Buffer.byteLength(permissionMarker),command,baselineDenied:false,approvedWrite:false};
 const ordinary={command,description},escalated={...ordinary,sandbox_permissions:'danger-full-access',justification};
 // Correlate each phase to its own submission, so prior research is not mistaken
 // for probe activity. Native calls, results and approval records remain intact.
 const probeTurn=(response,expected)=>{
  const all=response.snapshot.page.events,source=all.find(event=>event.type==='user/message'&&z.object({source:z.object({rpcId:z.literal(response.id)})}).safeParse(event.data).success);
  assert(source,'Permission probe input must have its native source record');
  const events=all.filter(event=>event.seq>source.seq),calls=events.filter(event=>event.type==='tool/call');
  assert.equal(calls.length,1,'Each permission-probe phase requires exactly one native tool call');
  const call=z.object({callId:z.string(),name:z.literal('bash'),arguments:z.string()}).parse(calls[0].data);
  assert.deepEqual(JSON.parse(call.arguments),expected,'Permission probe must execute the exact authorized argument set');
  const results=events.filter(event=>event.type==='tool/result'&&event.data.message?.toolCallId===call.callId);
  assert.equal(results.length,1,'The exact probe call must have one native result');
  const result=z.object({message:z.object({isError:z.boolean().optional(),content:z.array(z.object({type:z.literal('text'),text:z.string()}))})}).parse(results[0].data).message;
  return {events,call,resultSeq:results[0].seq,text:result.content.map(part=>part.text).join('\n'),isError:result.isError};
 };
 await assert.rejects(lstat(probeFile),{code:'ENOENT'});
 const baseline=probeTurn(await send(`Verify the real sandbox boundary using this one operator-owned synthetic file. Invoke bash exactly once with precisely these arguments: ${JSON.stringify(ordinary)}. The parent directory already exists outside your workspace. This first phase is expected to be denied by workspace-write. Do not request escalation yet, change the command, retry, or use another tool. After the result, stop and report whether the sandbox denied it. The operator will independently check that no file exists before authorizing the identical retry.`),ordinary);
 assert(baseline.text.includes('[sandbox: file access denied under workspace-write mode]'),'The baseline must fail specifically at the native sandbox boundary');
 await assert.rejects(lstat(probeFile),{code:'ENOENT'});
 assert.equal(report.permissions.length,0,'Baseline execution must not request approval');
 assert(!baseline.events.some(event=>event.type==='approval/asked'),'Baseline must not contain a native approval request');
 report.permissionProbe.baselineDenied=true;check('permission-probe-native-denial-and-absent-file');
 permittedCall=z.object({command:z.literal(command),description:z.literal(description),sandbox_permissions:z.literal('danger-full-access'),justification:z.literal(justification)}).strict();
 const approved=probeTurn(await send(`The preceding exact command was genuinely denied by workspace-write, and the operator verified the owned probe file is absent. You are authorized to request one approval for that identical command to create only this synthetic 36-byte file. Retry bash exactly once with precisely these arguments: ${JSON.stringify(escalated)}. Preserve command and description exactly; include both escalation fields. Do not read files, alter another path, run another command, use another tool, or retry again. After the approval decision and tool result, report completion; the operator will independently read the nonce file.`),escalated);
 permittedCall=undefined;
 assert.equal(report.permissions.length,1,'Exactly one permission decision must be presented');
 assert.equal(report.permissions[0].allowed,true,'Only the exact authorized retry may be allowed');
 const asks=approved.events.filter(event=>event.type==='approval/asked'),decisions=approved.events.filter(event=>event.type==='approval/decided');
 assert.equal(asks.length,1);assert.equal(decisions.length,1);
 const asked=z.object({id:z.string(),toolName:z.literal('bash'),callId:z.literal(approved.call.callId)}).parse(asks[0].data);
 z.object({id:z.literal(asked.id),outcome:z.literal('allowed-once')}).parse(decisions[0].data);
 assert(asks[0].seq<decisions[0].seq&&decisions[0].seq<approved.resultSeq,'Native approval must precede the approved tool result');
 assert.notEqual(approved.isError,true,'The approved retry must complete successfully');
 assert(!approved.text.includes('[sandbox: file access denied'),'Approved retry must not remain sandbox-denied');
 assert.equal((await lstat(probeFile)).isFile(),true);assert.equal(await readFile(probeFile,'utf8'),permissionMarker);
 assert.deepEqual(await readdir(probeDirectory),['nonce.txt'],'The owned fixture directory contains only the authorized file');
 report.permissionProbe.approvedWrite=true;check('public-permission-decision',{count:report.permissions.length,bytes:Buffer.byteLength(permissionMarker)});
 }else report.checks.push({name:'public-permission-decision',status:'unverified',detail:'Excluded from the approved synthetic core campaign; permission escalation requires separate approval.'});
 if(!permissionOnly){
 const checkpoint=(await request('POST',`/api/projects/${projectId}/nodes/${nodeId}/checkpoints`,{id:randomUUID()})).json();assert(checkpoint.commit);check('research-checkpoint-after-settlement',{commit:checkpoint.commit});
 if(view().imageCapability){
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png().toBuffer(),id=randomUUID();
  await request('POST',`${route}/images?${new URLSearchParams({id,name:'red.png',mediaType:'image/png'})}`,image,{'content-type':'application/octet-stream'});
  const answer=await send('Describe the attached solid-color image in one sentence. No tools.',[{type:'text',text:'Describe the attached solid-color image in one sentence. No tools.'},{type:'image',attachmentId:id}]);
  assert(answer.snapshot.page.events.some(event=>event.type==='user/message'&&JSON.stringify(event).includes('attachmentId')));check('public-image-ingress-and-real-provider-delivery');
 }else report.checks.push({name:'public-image-ingress-and-real-provider-delivery',status:'unsupported',detail:'The configured model did not advertise image support.'});
 const steeringStart=randomUUID(),steeringId=randomUUID(),steeringMarker=randomUUID();let steeringTool=false;
 const currentHarness=byWorker.get(workerId),steeringNotice=notice=>{if(notice.event.type==='tool/call'&&JSON.stringify(notice.event).includes('sleep'))steeringTool=true;};currentHarness.on('source',steeringNotice);
 await request('POST',`${route}/submissions`,{id:steeringStart,text:'Run one foreground bash command: sleep 3; printf steering-ready. Then follow any additional input before replying. Do not use background jobs or subagents.'});
 await until(()=>steeringTool||['failed','uncertain','interrupted'].includes(runtime.agents.submission(steeringStart).state),'running tool before steering');assert(steeringTool);
 await request('POST',`${route}/submissions`,{id:steeringId,text:`After the current tool returns, write steered.txt containing exactly ${steeringMarker}. Use a tool and then finish.`});
 await until(()=>runtime.agents.submission(steeringId).state==='applied'&&view().state==='idle','in-turn steering application');currentHarness.off('source',steeringNotice);
 assert.equal((await readFile(join(workspace,'steered.txt'),'utf8')).trim(),steeringMarker);check('public-running-input-steering-and-tool-result');
 const interruptId=randomUUID();let runningTool=false;const h=byWorker.get(workerId);
 const toolNotice=notice=>{if(notice.event.type==='tool/call'&&JSON.stringify(notice.event).includes('sleep'))runningTool=true;};h.on('source',toolNotice);
 await request('POST',`${route}/submissions`,{id:interruptId,text:'Run exactly one foreground bash command: sleep 20; printf interrupted-tail. Wait for it. Do not use jobs, subagents, backgrounding, or other tools.'});
 await until(()=>runningTool||['failed','uncertain','interrupted'].includes(runtime.agents.submission(interruptId).state),'real tool started before interruption');assert(runningTool,'Expected an actual sleep tool invocation');
 const interruption=randomUUID();await request('POST',`${route}/submissions`,{id:interruption,kind:'interrupt',text:''});
 await until(()=>runtime.agents.submission(interruption).state==='completed','interrupt settlement');h.off('source',toolNotice);check('public-interrupt-settles-real-tool-execution');
 const wholeHistory=async first=>{let current=first,events=[...first.events];while(current.before!==null){current=(await request('GET',`${route}/history?${new URLSearchParams({cut:current.cut,before:String(current.before)})}`)).json();events=[...current.events,...events];assert(events.length<=config.maxHistoryEvents,'Acceptance history exceeds configured observation bound');}return {...first,events,before:null};};
 const active=await runtime.agents.observe(projectId,nodeId,workerId),activeHistory=await wholeHistory(active.page),session=view().harnessSessionId;
 await request('POST',`${route}/close`,{});const launches=harnesses.length,requestsCold=report.requests;
 const cold=await wholeHistory((await request('GET',`${route}/history`)).json());assert.equal(cold.formatVersion,4);assert.equal(cold.sourceSessionId,session);
 assert.deepEqual(cold.events.slice(0,activeHistory.events.length),activeHistory.events);assert.equal(harnesses.length,launches);assert.equal(report.requests,requestsCold);
 await writeFile(join(run,'cold-history.json'),scrub(cold));check('active-to-cold-format-four-history-without-execution');
 await request('POST',`${route}/resume`,{});assert.equal(view().harnessSessionId,session);
 await send('Read your saved analysis.json using a tool and report only the mean and population standard deviation. Do not rerun prior commands.');check('explicit-resume-retains-session-and-research-artifacts');
 const scheduledMarker=randomUUID(),scheduledFile=join(workspace,'scheduled.txt');
 await send(`Create exactly one native schedule with schedule_create, after_seconds 2, title "ADR018 due-marker". Its prompt must say: Write scheduled.txt containing exactly ${scheduledMarker} using a tool, then finish. Do not write this file now, create no other schedules, and do not spawn subagents. Finish this turn after the schedule is created.`);
 await until(async()=>{try{return (await readFile(scheduledFile,'utf8')).trim()===scheduledMarker&&view().state==='idle';}catch(error){if(error.code==='ENOENT')return false;throw error;}},'native scheduled input completes');
 const scheduled=await runtime.agents.observe(projectId,nodeId,workerId);
 assert(scheduled.page.events.some(event=>event.type==='user/message'&&event.data?.source?.kind==='schedule'),'Schedule must produce its native sourced input');check('native-schedule-due-input-and-independent-artifact');

 const receipts=[];http=await serveHttp({record:value=>receipts.push(value)});
 const directWorkspace=join(run,'typed-harness');await mkdir(directWorkspace);const direct=new Harness(config,join(run,'typed-home'),directWorkspace,async()=>reserve(),async permission=>{
  const option=permission.options.find(value=>value.kind===(coreOnly?'reject_once':'allow_once'));return option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'};
 });harnesses.push(direct);await direct.start();const opened=await direct.activate(null,[{type:'http',name:'acceptance',url:http.url,headers:[]}]);
 assert.equal(opened.mcp[0]?.status,'connected');const ended=await nativeTurn(direct,opened.sessionId,'Call the acceptance MCP transform tool exactly once with value 6 and label "adr018". Report its returned value and receipt. Do not use any other tools.',config.requestTimeoutMs);
 assert.equal(ended.reason.kind,'completed');const invoked=receipts.filter(value=>value.phase==='invoked');assert.equal(invoked.length,1);assert.equal(invoked[0].output.value,43);
 const observed=await direct.observe(opened.sessionId);assert(JSON.stringify(observed.events).includes(invoked[0].output.receipt));check('typed-harness-real-provider-http-mcp-and-independent-receipt');
 await direct.closeSession(opened.sessionId);await direct.close();
 report.corePassed=true;
 }
 report.passed=!coreOnly;
}catch(error){report.checks.push({name:'campaign',status:'fail',error:error.stack??String(error)});process.exitCode=1;}
finally{
 clearTimeout(timer);
 if(runtime)try{await runtime.app.close();report.cleanup.push({owner:'application',settled:true});}catch(error){report.cleanup.push({owner:'application',settled:false,error:error.message});report.passed=false;process.exitCode=1;}
 for(const h of harnesses)try{await h.close();report.cleanup.push({owner:'harness',settled:true});}catch(error){report.cleanup.push({owner:'harness',settled:false,error:error.message});report.passed=false;process.exitCode=1;}
 if(http)await http.close();report.budget=ledger.close();report.finished=new Date().toISOString();
 await writeFile(join(run,'report.json'),scrub(report));await writeFile(join(evidence,`${platform}-attempt-${attempt}.json`),scrub(report));
 console.log(scrub({passed:report.passed,corePassed:report.corePassed,requests:report.requests,budget:report.budget,evidence:join(evidence,`${platform}-attempt-${attempt}.json`)}));
}
