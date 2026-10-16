/** Fresh real-provider usability qualification. The production composition and
 * public CLI remain unchanged; a durable admission ledger bounds all harnesses.
 * No permission is granted automatically and no existing installation is used. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile,rename,stat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {loadConfig,Config,sourceRoot} from '../src/config.ts';
import {createApp} from '../src/main.ts';
import {Harness} from '../harness/client.ts';
import {VerificationBudget} from '../harness/budget.mjs';
import {ProviderSettings} from '../harness/providers.ts';
import {toolFailure} from './qualification-results.mjs';

assert(process.argv.includes('--live'),'Explicit --live is required');
assert(process.argv.slice(2).every(arg=>['--live','--ordinary','--routing','--activation'].includes(arg)),'Unknown qualification option');
const activation=process.argv.includes('--activation'),routing=process.argv.includes('--routing')||activation,ordinary=process.argv.includes('--ordinary')||routing;
const exitProbe='printf POLARITON_EXIT_PROBE; exit 7',unknownProbe='harnessctl worker activate --help';
assert(process.env.DEEPSEEK_API_KEY?.trim(),'Provider credential must be supplied through the normal V5 environment');
const positive=z.number().int().positive();
const limits=z.object({maxRequests:positive.max(40),maxLiveMs:positive.max(900000),maxOutputTokens:positive.max(4096),maxRequestsPerTurn:positive.max(16),maxActiveWorkers:positive.max(4),observationTimeoutMs:positive,commandTimeoutMs:positive,commandBytes:positive,pollMs:positive}).strict().parse(JSON.parse(await readFile(new URL('../config/adr025-live.json',import.meta.url),'utf8')));
const runId=new Date().toISOString().replaceAll(':','-'),root=sourceRoot,run=join(root,'.local/adr025',runId),evidence=join(root,'docs/evidence/adr025/live',runId);
await mkdir(run,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
const configPath=join(run,'app.json'),environmentConfig=join(run,'environment.json');
// No EnvironmentDaemon is started; even its endpoint is isolated from user state.
await writeFile(environmentConfig,JSON.stringify({...JSON.parse(await readFile(new URL('../config/environment.json',import.meta.url),'utf8')),stateRoot:join(run,'environment'),socketPath:join('/tmp',`polariton-adr025-${randomUUID().slice(0,8)}.sock`)}));
const config=Config.parse({...await loadConfig(),configPath,stateRoot:join(run,'state'),runtimeDirectory:join('/tmp',`polariton-025-${randomUUID().slice(0,8)}`),sharedSkillsDir:join(run,'skills'),environmentConfig,verification:false,campaign:undefined,maxOutputTokens:limits.maxOutputTokens,maxRequestsPerTurn:limits.maxRequestsPerTurn,maxActiveWorkers:limits.maxActiveWorkers,requestTimeoutMs:limits.observationTimeoutMs,permissionTimeoutMs:limits.maxLiveMs,workerIdleUnloadMs:null});
await writeFile(configPath,JSON.stringify(config,null,2));await mkdir(config.sharedSkillsDir);
const secrets=new Set([process.env.DEEPSEEK_API_KEY]);
const scrub=value=>{let text=typeof value==='string'?value:JSON.stringify(value,null,2);for(const secret of secrets)if(secret)text=text.replaceAll(secret,'<REDACTED>');return text.replaceAll(root,'<V5>');};
const save=(file,value)=>writeFile(join(evidence,file),scrub(value)+'\n',{mode:0o600});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exec=promisify(execFile),harnesses=new Map();
const report={runId,scenario:activation?'activation-discovery':routing?'reply-routing':ordinary?'ordinary-analysis':'interface-exercises',startedAt:new Date().toISOString(),provider:config.provider,model:config.model,platform:`${process.platform}-${process.arch}`,node:process.version,dsh:JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/dsh/package.json',import.meta.url),'utf8')).version,limits,requests:0,checks:[],permissions:[],artifacts:[],workers:[],passed:false};
report.source={baseCommit:(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),lockSha256:sha(await readFile(join(root,'package-lock.json'))),promptSha256:sha(await readFile(join(root,'harness/polariton-prompt.json'))),scriptSha256:sha(await readFile(new URL(import.meta.url)))};
report.source.cli={};for(const file of ['client.ts','contracts.ts','help.ts','help-catalog.ts','receipts.ts','input-errors.ts'])report.source.cli[file]=sha(await readFile(join(root,'src/cli',file)));
await writeFile(join(evidence,'executed-script.mjs'),await readFile(new URL(import.meta.url)),{mode:0o600});
const resultClassifier=await readFile(new URL('./qualification-results.mjs',import.meta.url));report.source.resultClassifierSha256=sha(resultClassifier);await writeFile(join(evidence,'qualification-results.mjs'),resultClassifier,{mode:0o600});
const ledger=new VerificationBudget(join(run,'budget.sqlite'),limits);
let runtime,expired=false,missingWorkspace,heldWorkspace;
const deadline=setTimeout(()=>{expired=true;for(const h of harnesses.values())void h.close().catch(error=>{report.cleanupError=error.message;});},ledger.remainingMs);
const check=(name,detail={})=>{report.checks.push({name,...detail});console.log(JSON.stringify({check:name,requests:report.requests}));};
async function cli(command,input={},mutation=false){
 const args=['--config',configPath,...command.split('.'),'--input','-',...(mutation?['--request-id',randomUUID(),'--details']:command==='operation.get'?['--details']:[])];
 const env={...process.env};for(const key of ['HARNESSCTL_TOKEN','DSH_HARNESSCTL_TOKEN','DSH_SHELL'])delete env[key];
 const child=spawn(process.execPath,[join(root,'bin/harnessctl'),...args],{cwd:run,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',bytes=0,exceeded=false;
 const timer=setTimeout(()=>child.kill('SIGTERM'),limits.commandTimeoutMs);
 const collect=(kind,chunk)=>{bytes+=chunk.length;if(bytes>limits.commandBytes){exceeded=true;child.kill('SIGTERM');return;}if(kind==='out')stdout+=chunk;else stderr+=chunk;};
 child.stdout.on('data',chunk=>collect('out',chunk));child.stderr.on('data',chunk=>collect('err',chunk));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
 assert(!exceeded,'CLI output exceeded campaign bound');
 const result=JSON.parse(stdout);await appendFile(join(evidence,'commands.ndjson'),scrub(JSON.stringify({at:new Date().toISOString(),command,input,code,result,bytes:Buffer.byteLength(stdout),stderr}))+'\n');
 assert.equal(code,0,`${command}: ${scrub(result)}`);return result.data;
}
async function until(ready,description){const end=Date.now()+limits.observationTimeoutMs;while(!expired&&Date.now()<end){const result=await ready();if(result)return result;await delay(limits.pollMs);}throw new Error(`Observation deadline: ${description}`);}
const send=async(id,text)=>cli('worker.send',{target:id,text},true);
async function idle(id){return until(async()=>{const w=runtime.agents.get(id);if(['failed','uncertain','closed'].includes(w.state))throw new Error(`${w.title}: ${w.state} ${w.error}`);return w.state==='idle'&&!w.permissions.length?w:null;},`worker ${id} idle`);}
async function history(id){const first=await cli('worker.history',{target:id}),events=[...first.events];let before=first.before;while(before!==null){assert(events.length<config.maxHistoryEvents);const page=await cli('worker.history',{target:id,cut:first.cut,before});events.unshift(...page.events);before=page.before;}const result={...first,events};await save(`history-${id}.json`,result);return result;}
try{
 // Fresh state has no configured provider or selected route. Provision through
 // the same owner API as Settings; the ambient credential remains opaque.
 const providers=await ProviderSettings.open(join(config.stateRoot,'provider-settings'),{discoveryTimeoutMs:config.providerDiscoveryTimeoutMs,lockTimeoutMs:config.startupTimeoutMs});
 try{await providers.save({id:config.provider,kind:'builtin'});await providers.setDefault(JSON.stringify([config.provider,config.model]));}finally{await providers.close();}
 runtime=await createApp(config,(settings,home,workspace,budget,permission)=>{
  if(settings.workerCredential)secrets.add(settings.workerCredential.token);
  const h=new Harness(settings,home,workspace,async()=>{const allowed=await budget()&&ledger.reserve();if(allowed)report.requests++;return allowed;},permission);harnesses.set(basename(home),h);return h;
 });
 await runtime.app.ready();
 const project=(await cli('project.create',{name:'ADR-025 live usability',root:join(run,'research')},true)).result;report.project=project;
 const analyst=project.initialWorkerId;
 let reviewer=routing?null:(await cli('worker.create',{node:project.mainNodeId,title:'Independent reviewer'},true)).result.id;
 let main;
 if(ordinary){
  report.workers=reviewer?[analyst,reviewer]:[analyst];report.activeWorkers=[...report.workers];
  main=await cli('node.get',{target:project.mainNodeId,project:project.id});
  await writeFile(join(main.workspace,'batches.csv'),'batch,passed,tested\nA,18,20\nB,17,25\nC,19,20\n');
  await save('setup.json',{project,analyst,reviewer,workspace:main.workspace});
  if(activation){
   const discoveryTask=`Before the research task, perform this bounded CLI usability check. Run each of these exactly once as its own foreground Bash call: ${JSON.stringify(exitProbe)} and ${JSON.stringify(unknownProbe)}. They intentionally fail; inspect both results and do not retry them. Follow the unknown-command error's resource-help guidance. Search harnessctl help for each exact phrase: "start inactive worker", "activate worker", and "start coworker". Inspect compact help for worker create, worker send and worker resume. Explain briefly how you will create a coworker and give it its first task, and when resume differs. Do not create any worker or send a coworker message yet. End this turn after discovery. No background jobs, goals, subagents or external browsing.`;
   await save('discovery-task.txt',discoveryTask);await send(analyst,discoveryTask);await idle(analyst);
  }
  const task=routing?'Analyze batches.csv and write analysis.md with each batch pass rate, the pooled pass rate, which batch deserves follow-up and a sample-size caveat. Preserve your work. Create exactly one coworker named Independent reviewer on your node to independently check the arithmetic and conclusion and write reviewer-notes.md. Ask them to preserve their review. Their reply must be exactly one line: PASS: 54/65 if the pooled fraction is correct, otherwise FAIL: <reason>. You own analysis.md; the reviewer owns reviewer-notes.md. Finish your turn after requesting the review. When it arrives, incorporate any corrections and finish without another acknowledgement. Keep the task local; create no other workers, native subagents or goals, and do not browse externally.':'Analyze batches.csv and write analysis.md: give each batch pass rate, the pooled pass rate, which batch deserves follow-up, and a caveat about the sample size. Preserve your work. Ask our Independent reviewer in this workspace to check the arithmetic and conclusion, write reviewer-notes.md, preserve their review, and report back. You own analysis.md; the reviewer owns reviewer-notes.md. Finish your turn after sending the request. When the review arrives, incorporate any corrections and finish without sending another message. Keep this task local; do not create workers, delegate, create goals or browse externally.';
  await save('task.txt',task);
  await send(analyst,task);
  if(routing){const created=await until(()=>runtime.agents.list(project.id,project.mainNodeId).find(w=>w.id!==analyst),'worker creates reviewer');reviewer=created.id;report.workers.push(reviewer);report.activeWorkers.push(reviewer);await save('setup.json',{project,analyst,reviewer,workspace:main.workspace});}
  await idle(analyst);await idle(reviewer);await idle(analyst);
 }else{
 const graph=await cli('graph.get',{project:project.id});
 const absentNode=(await cli('node.create',{project:project.id,title:'Unavailable fixture',description:'Controlled unavailable workspace',expectRevision:graph.revision},true)).result;
 // Resolve created identity from the authoritative graph, independent of receipt nesting.
 const node=(await cli('graph.get',{project:project.id})).nodes.find(n=>n.title==='Unavailable fixture');assert(node);
 const absent=(await cli('worker.create',{node:node.id,title:'Inactive workspace fixture'},true)).result.id;
 report.workers=[analyst,reviewer,absent];report.activeWorkers=[analyst,reviewer];
 main=await cli('node.get',{target:project.mainNodeId,project:project.id});
 missingWorkspace=(await cli('node.get',{target:node.id,project:project.id})).workspace;heldWorkspace=missingWorkspace+'-retained';await rename(missingWorkspace,heldWorkspace);
 await writeFile(join(main.workspace,'observations.csv'),'x,y\n0,1\n1,2\n2,5\n3,10\n');
 await save('setup.json',{project,analyst,reviewer,absent,workspace:main.workspace,absentNode});
 await send(reviewer,'You are the reviewer in a bounded qualification. First orient yourself through the public Polariton interface and record your project, node, workspace, environment assignment and coworkers in reviewer-orientation.md. Then issue exactly one harmless native Bash approval probe: command="printf ADR025_PERMISSION_PROBE", sandbox_permissions="danger-full-access", justification="Harmless bounded qualification approval probe; no writes or network". The verifier will reject that request; do not retry it. Afterward handle any arriving review request using its sender identity. Work only on reviewer-owned files, keep all Polariton mutations through the public CLI, do not delegate or create goals. End when your review report has been sent; do not invite an acknowledgement or another reply.');
 const pending=await until(()=>{const w=runtime.agents.get(reviewer);if(['failed','uncertain','closed'].includes(w.state))throw new Error(`Reviewer cannot reach permission probe: ${w.state} ${w.error}`);return w.permissions.length?w:null;},'reviewer permission probe');
 assert.equal(pending.permissions.length,1);report.permissions.push(pending.permissions[0]);
 await save('pending-permission-overview.json',await cli('worker.overview',{target:reviewer}));
 check('real-native-permission-held',{worker:reviewer});
 await send(analyst,`Use the installed Polariton guidance and public CLI to orient yourself, including project, node, workspace, environment assignment and coworkers. Save an accurate analyst-orientation.md. Discover by intent search how to preserve unfinished research progress, and inspect the selected command's compact help before using it. Analyze observations.csv and write draft.md with a candidate relationship, a check against the samples, and a clearly labeled unresolved question; this is unfinished research. Publish that draft as a Polariton checkpoint before review, even though review is pending. Ask worker ${reviewer} to independently check it, write reviewer-notes.md, publish their meaningful progress and send you a concise result with evidence. Send while the recipient has a pending permission; do not wait for them to become idle. Inspect their overview once before and once after sending, distinguishing permission, delivery and completion. Also inspect worker ${absent}: identify its unavailable workspace without trying to repair, activate or recreate it. Record both findings in attention.md. Do not repeatedly poll or wait for a reply: finish your turn after sending. When a review arrives, read it and finish concisely without sending another message. No delegation, new workers, goals, external browsing, private stores or application source. Use native file tools and the public CLI. Do not load operate-labra or dump full schemas.`);
 await idle(analyst);
 const waiting=await cli('worker.overview',{target:reviewer});await save('pending-delivery-overview.json',waiting);
 assert(waiting.attention.totals.permissions>0);assert(waiting.attention.totals.pendingDelivery>0,'Analyst must send while reviewer approval is pending');
 check('overview-separates-pending-permission-and-delivery',{totals:waiting.attention.totals});
 const partial=await cli('worker.overview',{target:absent});assert.equal(partial.placement.workspace.availability,'unavailable');assert.equal(partial.execution.state,'inactive');await save('unavailable-workspace-overview.json',partial);
 const checkpoints=await cli('checkpoint.list',{node:project.mainNodeId});assert(checkpoints.items.length>0,'Analyst must publish before review');report.beforeReview=checkpoints;
 const current=runtime.agents.get(reviewer).permissions[0];assert(current&&current.id===pending.permissions[0].id);const rejection=current.options.find(option=>option.kind==='reject_once');assert(rejection);
 await cli('worker.respond',{target:reviewer,request:current.id,option:rejection.optionId},true);
 check('permission-rejected-without-grant');
 await idle(reviewer);await idle(analyst);
 }
 const final=await cli('checkpoint.list',{node:project.mainNodeId});assert(final.items.length>=2);report.checkpoints=final;
 const files=ordinary?['analysis.md','reviewer-notes.md']:['analyst-orientation.md','reviewer-orientation.md','draft.md','reviewer-notes.md','attention.md'];
 for(const file of files){const bytes=await readFile(join(main.workspace,file));assert(bytes.length>0);await save(file,bytes.toString());report.artifacts.push({file,sha256:sha(bytes),bytes:bytes.length});}
 const publications=[];
 for(const item of final.items){const checkpoint=await cli('checkpoint.get',{target:item.id,node:project.mainNodeId});for(const name of [ordinary?'analysis.md':'draft.md','reviewer-notes.md'])if((await exec('git',['-C',main.workspace,'ls-tree','--name-only',checkpoint.commit,'--',name],{maxBuffer:limits.commandBytes})).stdout.trim()){const bytes=(await exec('git',['-C',main.workspace,'show',`${checkpoint.commit}:${name}`],{maxBuffer:limits.commandBytes})).stdout;assert(bytes.trim());publications.push({checkpoint:checkpoint.id,commit:checkpoint.commit,publisher:checkpoint.publisher,file:name,sha256:sha(bytes)});}}
 assert(publications.some(p=>p.file===(ordinary?'analysis.md':'draft.md')));assert(publications.some(p=>p.file==='reviewer-notes.md'));await save('published-files.json',publications);
 const histories=[];for(const id of [analyst,reviewer])histories.push({worker:id,...await history(id)});
 const calls=histories.flatMap(h=>h.events.filter(e=>e.type==='tool/call').map(event=>({worker:h.worker,...event})));
 await save('worker-tool-calls.json',calls);
 const invocation=JSON.stringify(calls);if(!ordinary){assert(/harnessctl.*overview/.test(invocation));assert(invocation.includes('--search'));assert(invocation.includes('--help'));}assert(!invocation.includes('--schema'),'Qualification must not dump full schemas');assert(!calls.some(call=>call.data?.name==='skill'&&JSON.stringify(call).includes('operate-labra')),'Retired skill must not be loaded');
 const observations=calls.map(call=>{const h=histories.find(h=>h.worker===call.worker);const result=h.events.find(e=>e.type==='tool/result'&&e.data.message?.toolCallId===call.data.callId);assert(result,'Every tool call must have a recorded result');return {worker:call.worker,seq:call.seq,name:call.data.name,input:JSON.parse(call.data.arguments),result:result.data.message};});
 const search=observations.find(o=>o.name==='bash'&&o.input.command.includes('--search'));if(!ordinary)assert(search&&!search.result.isError&&JSON.stringify(search.result.content).includes('checkpoint publish'),'Intent search must actually return the selected command');
 const failures=observations.flatMap(o=>{const reason=toolFailure(o);return reason?[{worker:o.worker,seq:o.seq,command:o.input.command,reason,isError:o.result.isError}]:[];});
 report.toolFailures=failures;await save('tool-observations.json',observations);
 if(activation){
  assert.deepEqual(failures.map(f=>({command:f.command,reason:f.reason})).sort((a,b)=>a.command.localeCompare(b.command)),[{command:exitProbe,reason:'bash-exit:7'},{command:unknownProbe,reason:'bash-exit:2'}].sort((a,b)=>a.command.localeCompare(b.command)),'Only the two deliberate foreground probes may fail');
  assert(failures.every(f=>f.isError===false),'Nonzero native Bash exits must be detected independently of isError');
  const output=o=>o.result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  assert(output(observations.find(o=>o.input.command===unknownProbe)).includes('harnessctl worker --help'));
  for(const query of ['start inactive worker','activate worker','start coworker']){
   const found=observations.find(o=>o.name==='bash'&&o.input.command.includes('--search')&&o.input.command.includes(query));
   assert(found&&!toolFailure(found)&&output(found).includes('worker send'),`Activation search must discover worker send: ${query}`);
  }
  for(const command of ['worker create','worker send','worker resume'])assert(observations.some(o=>o.name==='bash'&&o.input.command.includes(command+' --help')&&!toolFailure(o)),`Inspect ${command} help`);
  const inventory=observations.find(o=>o.name==='bash'&&/harnessctl\s+(?:worker\s+--help|help\s+worker\b)/.test(o.input.command)&&!o.input.command.includes('--search')&&!toolFailure(o));
  assert(inventory&&output(inventory).includes('worker create')&&output(inventory).includes('worker send'),'Follow resource-specific recovery guidance');
  assert(!observations.some(o=>o.name==='bash'&&/harnessctl\s+worker\s+(resume|activate)\b/.test(o.input.command)&&!o.input.command.includes('--help')),'A newly created worker must start through its first task, without a separate activation mutation');
  check('activation-discovery-and-nonzero-bash-exits',{expectedFailures:failures.length,unexpectedFailures:0});
 }else{assert.equal(failures.length,ordinary?0:1);if(!ordinary)assert.equal(failures[0].command,'printf ADR025_PERMISSION_PROBE','Only the intentionally rejected permission may fail');} 
 report.promptObservations=histories.map(h=>{const system=h.events.find(e=>e.type==='system/message').data.message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');const header=h.events.find(e=>e.type==='request/header').data.header;assert(system.includes('You are a Polariton worker,'));assert(!system.includes('You are an AI agent powered by DeepSeek Harness.'));assert(!system.includes('DeepSeek Harness Web GUI'));assert(!JSON.stringify(h.events.filter(e=>['system/message','request/header','request/context'].includes(e.type))).includes('operate-labra'));assert(h.events.filter(e=>e.type==='turn/end').every(e=>e.data.reason.kind==='completed'));return {worker:h.worker,systemSha256:sha(system),toolNames:header.tools.map(t=>t.name),maxOutputTokens:header.config.maxTokens};});
 for(const h of histories){const system=h.events.find(e=>e.type==='system/message').data.message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');await save(`system-${h.worker}.txt`,system);}
 report.discovery=observations.filter(o=>o.name==='bash'&&o.input.command.includes('harnessctl')).map(o=>({worker:o.worker,seq:o.seq,command:o.input.command}));
 for(const id of [analyst,reviewer]){const incoming=histories.find(h=>h.worker===id).events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='polariton-worker');assert(incoming.length>0,'Both peers must receive authenticated worker input');assert(incoming.every(e=>e.data.source.workerId===(id===analyst?reviewer:analyst)));}
 if(routing){
  assert.equal(runtime.agents.list(project.id,project.mainNodeId).length,2,'Exactly one coworker must be created');
  const reply=histories.find(h=>h.worker===analyst).events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='polariton-worker');
  const texts=reply.flatMap(e=>e.data.content.filter(c=>c.type==='text').map(c=>c.text)).filter(t=>!t.startsWith('[Polariton worker message]'));
  assert.deepEqual(texts.map(t=>t.trim()),['PASS: 54/65'],'Exactly one constrained reply must be explicitly delivered');
  const shell=observations.filter(o=>o.name==='bash').map(o=>o.input.command);
  assert(!shell.some(c=>/harnessctl\s+worker\s+(history|get)\b/.test(c)),'No transcript or status polling to receive the reply');
  assert(shell.some(c=>/harnessctl\s+worker\s+create\b/.test(c)&&!c.includes('--help')),'Worker creates coworker through CLI');
  check('explicit-single-line-reply-without-history-polling');
 }
 report.usage=histories.map(h=>({worker:h.worker,metrics:h.metrics}));
 check(ordinary?'ordinary-analysis-communication-and-checkpoints':'live-orientation-search-communication-and-checkpoints',{checkpoints:final.items.length,toolCalls:calls.length});
 report.passed=true;
}catch(error){report.failure={message:error.message,stack:error.stack};console.error(scrub({failure:error.message}));process.exitCode=1;
}finally{
 clearTimeout(deadline);
 if(runtime){for(const id of report.activeWorkers??[])try{await history(id);}catch(error){report.historyError??=[];report.historyError.push({id,message:error.message});}try{await runtime.app.close();report.cleanup='closed';}catch(error){report.cleanup=error.message;report.passed=false;process.exitCode=1;}}
 if(heldWorkspace)try{await stat(heldWorkspace);await rename(heldWorkspace,missingWorkspace);}catch(error){report.workspaceRestoreError=error.message;report.passed=false;process.exitCode=1;}
 report.budget=ledger.close();report.finishedAt=new Date().toISOString();report.expired=expired;await save('report.json',report);console.log(JSON.stringify({evidence,passed:report.passed,requests:report.requests,budget:report.budget}));
}
