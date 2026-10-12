import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile,stat,copyFile,readdir,realpath} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import sharp from 'sharp';
import {loadConfig,CampaignConfig,sourceRoot} from '../src/config.ts';

/** Each phase drives real executable subprocesses against Main-managed workers.
 * Evidence is public receipts/history, retained Git bytes, or independently owned
 * fixture effects. The ledger is read solely to account for authorized spending. */
const phase=process.argv[2];assert(process.argv.includes('--live'),'Explicit --live is required');
const label=process.argv.includes('--label')?process.argv[process.argv.indexOf('--label')+1]:'';assert(/^[a-z0-9-]*$/.test(label),'Invalid campaign label');
const root=sourceRoot,base=join(root,'.local/adr012',label),evidence=join(root,'docs/evidence/adr012',label);
const config=await loadConfig(join(root,'config/adr012-app.json'));
const limits=CampaignConfig.parse(JSON.parse(await readFile(config.campaign,'utf8')));assert.equal(limits.id,'adr012');
const rules=z.object({deadlineMs:z.number().int().positive(),pollMs:z.number().int().positive(),gateSeconds:z.number().int().positive(),commandBytes:z.number().int().positive(),browserConvergenceMs:z.number().int().positive(),imageModel:z.string()}).strict().parse(JSON.parse(await readFile(join(root,'config/adr012-cases.json'),'utf8')));
await mkdir(base,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const scrub=value=>JSON.parse(JSON.stringify(value).replaceAll(root,'<V5>'));
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
let state;try{state=await json(join(base,'cases.json'));}catch(error){if(error.code!=='ENOENT')throw error;state={workers:[],cases:[]};}
const retain=()=>save(join(base,'cases.json'),state);
function budget(){const db=new DatabaseSync(resolve(dirname(config.campaign),limits.ledger),{readOnly:true});try{return db.prepare('SELECT requests,elapsed FROM budget WHERE id=1').get();}finally{db.close();}}
async function cli(command,input={},options={}){
 const requestId=options.mutation?(options.id??randomUUID()):undefined;
 const args=['--config',config.configPath,...command.split('.'),...(requestId?['--request-id',requestId]:[]),'--input','-',...(options.output?['--output',options.output]:[]),...(options.mutation||command==='operation.get'?['--details']:[])];
 const child=spawn(join(root,'bin/harnessctl'),args,{cwd:base,env:process.env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 const timer=setTimeout(()=>child.kill('SIGTERM'),rules.deadlineMs);let bytes=0;
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>rules.commandBytes)child.kill('SIGTERM');});
 child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);});clearTimeout(timer);
 let result;try{result=JSON.parse(stdout);}catch{result={invalidOutput:stdout};}
 await appendFile(join(evidence,'commands.ndjson'),JSON.stringify(scrub({at:new Date().toISOString(),phase,command,input,requestId,code,result,stderr}))+'\n');
 if(!options.acceptFailure)assert.equal(code,0,`${command}: ${JSON.stringify(result)}`);
 return result.data??result;
}
const mutate=(command,input,options={})=>cli(command,input,{mutation:true,...options});
async function allow(worker,reject=false){for(const permission of worker.permissions){const option=permission.options.find(o=>o.kind===(reject?'reject_once':'allow_once'));assert(option,JSON.stringify(permission));await mutate('worker.respond',{target:worker.id,request:permission.id,option:option.optionId});state.permissions??=[];state.permissions.push({worker:worker.id,permission,option:option.kind});await retain();}}
async function until(check,description){const deadline=Date.now()+rules.deadlineMs;while(Date.now()<deadline){const result=await check();if(result)return result;await delay(rules.pollMs);}throw new Error(`Deadline: ${description}`);}
/** Qualification needs both delivery evidence and a settled recipient; command
 * acceptance alone never establishes that the requested artifact is finished. */
async function settled(worker,request,expected='applied'){
 return until(async()=>{
  const op=await cli('operation.get',{target:`main:worker:${request}`},{acceptFailure:true});
  if(['accepted','running','waiting'].includes(op.state))return null;
  assert.equal(op.state,'succeeded',JSON.stringify(op));
  const current=await cli('worker.get',{target:worker});await allow(current);
  if(['pending','admitted'].includes(op.result?.state))return null;
  assert.equal(op.result?.state,expected,JSON.stringify(op));
  if(['starting','running','interrupting'].includes(current.state))return null;
  assert.equal(current.state,'idle',JSON.stringify(current));return current;
 },`${worker} ${expected} and idle`);
}
async function send(worker,text,extra={}){const id=randomUUID();await mutate('worker.send',{target:worker,text,...extra},{id});return id;}
async function history(worker){const first=await cli('worker.history',{target:worker}),events=[...first.events];let before=first.before;while(before!==null){assert(events.length<config.maxHistoryEvents);const page=await cli('worker.history',{target:worker,cut:first.cut,before});events.unshift(...page.events);before=page.before;}const value={worker,session:first.sourceSessionId,events,attachments:first.attachments};await save(join(evidence,`history-${worker}.json`),scrub(value));return value;}
async function worker(title,node=state.project.mainNodeId){const op=await mutate('worker.create',{node,title});state.workers.push(op.result.id);await retain();return op.result.id;}
async function graph(){return cli('graph.get',{project:state.project.id});}
const git=async(path,...args)=>(await exec('git',['-C',path,...args],{timeout:rules.deadlineMs,maxBuffer:rules.commandBytes})).stdout.trim();
async function check(name,fn){const record={name,startedAt:new Date().toISOString(),status:'running',budgetBefore:budget()};state.cases.push(record);await retain();console.log(JSON.stringify({case:name,state:'started'}));try{Object.assign(record,await fn(),{status:'pass',budgetAfter:budget()});}catch(error){record.status='failed';record.error=error.message;throw error;}finally{record.finishedAt=new Date().toISOString();await retain();await save(join(evidence,'campaign.json'),scrub(state));console.log(JSON.stringify({case:name,state:record.status}));}}

try{
 if(phase==='refresh-processes'){
  for(const id of state.workers){await mutate('worker.close',{target:id});await mutate('worker.resume',{target:id});}
 }else if(phase==='setup'){
  assert(!state.project,'Fresh setup cannot overwrite a campaign');
  const op=await mutate('project.create',{name:`ADR012 CLI research${label?' '+label:''}`,root:join(base,'research')});state.project=op.result;state.workers.push(state.project.initialWorkerId);state.a=state.project.initialWorkerId;await retain();
 }else if(phase==='L1')await check('L1-agent-discovery',async()=>{
  const title=`CLI discovered node ${state.cases.filter(c=>c.name==='L1-agent-discovery').length}`;
  const request=await send(state.a,`Use Bash to discover harnessctl help and relevant command help. Through harnessctl only, inspect project ${state.project.id}, create one separate research node titled "${title}" with its current expected graph revision, then create an inactive worker titled "CLI colleague" on that new node. Generate and retain UUID request IDs before mutation (using node crypto.randomUUID); use structured JSON --input - or a local file. Do not read application source or private state. Do not send work to that worker. Report the node and worker IDs. Compact help explains invocation; use selected-command --help --schema --json only if the exact API contract is needed. Execute the commands, then stop.`);
  await settled(state.a,request);const g=await graph();const node=g.nodes.find(n=>n.title===title);assert(node);const workers=(await cli('worker.list',{project:state.project.id,node:node.id})).items;state.b=workers.find(w=>w.title==='CLI colleague')?.id;assert(state.b);state.node=node.id;state.workers.push(state.b);await retain();const h=await history(state.a);assert(JSON.stringify(h.events).includes('harnessctl'));return {worker:state.a,request,node:node.id,colleague:state.b,history:`history-${state.a}.json`};
 });
 else if(phase==='L2')await check('L2-worker-delivery',async()=>{
  state.delivery=randomUUID();const task='Use Bash to write exactly ADR012_IDLE_RESULT followed by a newline to idle-result.txt in your working directory. Then stop.';
  const request=await send(state.a,`Use harnessctl worker send ${state.b} --request-id ${state.delivery} --text ${JSON.stringify(task)}. Inspect the operation receipt for command acceptance (operation get --wait does not wait for the recipient turn), then invoke the identical send again with the same request ID and text. Do not create another request ID. Do not write B's output yourself. Report the receipt reference.`);
  await settled(state.a,request);await settled(state.b,state.delivery);const op=await cli('operation.get',{target:`main:worker:${state.delivery}`});assert.equal(op.actor.kind,'worker');assert.equal(op.actor.id,state.a);const n=await cli('node.get',{target:state.node});state.workspace=n.workspace??n.path??n.node.workspace;assert.equal(await readFile(join(state.workspace,'idle-result.txt'),'utf8'),'ADR012_IDLE_RESULT\n');const h=await history(state.b);await history(state.a);return {sender:state.a,target:state.b,request:state.delivery,actor:op.actor,session:h.session,artifactSha256:sha(await readFile(join(state.workspace,'idle-result.txt')))};
 });
 else if(phase==='L3')await check('L3-genuine-steering',async()=>{
  const gate='steering-release',started='steering-started';
  state.steeringPrompt=await send(state.b,`Use Bash to run this controlled gate exactly: printf started > ${started}; for i in $(seq 1 ${rules.gateSeconds}); do test -f ${gate} && break; sleep 1; done. After Bash finishes, follow any new user guidance that arrived during the gate. If no guidance arrived, write ORIGINAL to steering-result.txt. Do not delegate.`);
  await until(async()=>{const w=await cli('worker.get',{target:state.b});await allow(w);try{return await stat(join(state.workspace,started));}catch{return null;}},'steering tool gate');
  state.steering=randomUUID();const text='New guidance for the current turn: use Bash to write exactly STEERED_RESULT followed by a newline to steering-result.txt; then stop.';
  const request=await send(state.a,`Use harnessctl worker send ${state.b} --request-id ${state.steering} --text ${JSON.stringify(text)}. Do not wait for B's turn to finish. Report its receipt.`);
  await settled(state.a,request);const op=await cli('operation.get',{target:`main:worker:${state.steering}`},{acceptFailure:true});assert.equal(op.state,'succeeded');assert.equal(op.result.kind,'message');await writeFile(join(state.workspace,gate),'release\n');await settled(state.b,state.steeringPrompt);await settled(state.b,state.steering,'applied');assert.equal(await readFile(join(state.workspace,'steering-result.txt'),'utf8'),'STEERED_RESULT\n');const h=await history(state.b);return {prompt:state.steeringPrompt,steering:state.steering,session:h.session,receipt:op,history:`history-${state.b}.json`};
 });
 else if(phase==='L4')await check('L4-interruption-isolation',async()=>{
  state.c=await worker('Independent survivor');const prompt=await send(state.b,`Use Bash to run printf active > interrupt-started; sleep ${rules.gateSeconds}; printf should-not-exist > interrupt-too-late. Then stop.`);
  await until(async()=>{const w=await cli('worker.get',{target:state.b});await allow(w);try{return await stat(join(state.workspace,'interrupt-started'));}catch{return null;}},'interrupt gate');
  const survivor=await send(state.c,'Use Bash to write SURVIVOR_OK followed by a newline to survivor.txt. Then stop.');const interrupt=await mutate('worker.interrupt',{target:state.b});await settled(state.b,interrupt.requestId,'completed');await settled(state.b,prompt);await assert.rejects(stat(join(state.workspace,'interrupt-too-late')),{code:'ENOENT'});await settled(state.c,survivor);const recovery=await send(state.b,'Use Bash to write RECOVERED_OK followed by a newline to recovered.txt. Then stop.');await settled(state.b,recovery);assert.equal(await readFile(join(state.workspace,'recovered.txt'),'utf8'),'RECOVERED_OK\n');const main=await cli('node.get',{target:state.project.mainNodeId});assert.equal(await readFile(join(main.workspace,'survivor.txt'),'utf8'),'SURVIVOR_OK\n');await history(state.b);await history(state.c);return {interruptedWorker:state.b,prompt,interrupt:interrupt.reference,survivor:state.c,survivorSubmission:survivor,recovery};
 });
 else if(phase==='L5')await check('L5-permission',async()=>{
  const request=await send(state.b,'This is an approval-interface test. Call bash once with command printf "probe\\n" > ../permission-probe.txt, sandbox_permissions="danger-full-access", and justification="Synthetic qualification permission probe". The client will reject the request. After rejection report denied and stop. Do not retry, delegate, or use another tool.');
  const pending=await until(async()=>{const w=await cli('worker.get',{target:state.b});return w.permissions.length?w:null;},'real outstanding permission');state.pendingPermission=pending.permissions[0];await retain();console.log(JSON.stringify({permissionReady:true,worker:state.b}));
  // A file controlled by the verifier allows the browser to inspect the live request first.
  await until(async()=>{try{return await stat(join(base,'permission-inspected'));}catch{return null;}},'browser permission inspection');await allow(pending,true);await settled(state.b,request);await assert.rejects(stat(join(state.workspace,'../permission-probe.txt')),{code:'ENOENT'});await history(state.b);return {worker:state.b,request,permission:pending.permissions[0].id,selection:'reject_once'};
 });
 else if(phase==='L6')await check('L6-environment-revisions',async()=>{
  const definition={command:await realpath(process.execPath),args:[join(root,'tests/fixtures/adr011/server.mjs')],env:{ADR011_RECEIPTS:join(base,'fixture-receipts.ndjson'),ADR011_VERSION:'1'},requirements:{execution:'foreground-host',files:[],identityFiles:[]}};
  const preview=await cli('capability.preview',{configuration:{mcpServers:{[`ADR012 transform ${label}`]:definition}}});assert.deepEqual(preview.errors,[]);const imported=await mutate('capability.import',{entries:preview.entries});state.capability=imported.result.capabilities[0];
  let document={format:2,environmentId:`adr012-${label||'primary'}-science`,name:`ADR012 exact revisions ${label}`,description:'Controlled scientific transform',components:[{id:'local',name:'Transform',definition:{capabilityId:state.capability.id,revisionId:state.capability.revisionId}}]};
  await cli('environment.publish',{document,expectRevision:null,preview:true});state.r1=(await mutate('environment.publish',{document,expectRevision:null})).result;const applied=await mutate('environment.apply',{target:document.environmentId,revision:state.r1.revisionId});assert.equal(applied.result.status,'ready');
  state.r1worker=await worker('Pinned R1');await mutate('worker.update',{target:state.r1worker,environment:document.environmentId,revision:state.r1.revisionId});const first=await send(state.r1worker,'Call mcp__local__transform exactly once with value 6 and label "adr012-r1". Do not use any other tool. Return its exact output.');await settled(state.r1worker,first);state.r1session=(await cli('worker.get',{target:state.r1worker})).harnessSessionId;await mutate('worker.close',{target:state.r1worker});
  definition.env.ADR011_VERSION='2';const next=await cli('capability.preview',{configuration:{mcpServers:{[`ADR012 transform ${label}`]:definition}},capabilityId:state.capability.id});const revised=(await mutate('capability.revise',{target:state.capability.id,expectRevision:state.capability.revisionId,entry:next.entries[0]})).result;
  document={...document,components:[{...document.components[0],definition:{capabilityId:revised.id,revisionId:revised.revisionId}}]};state.r2=(await mutate('environment.publish',{document,expectRevision:state.r1.revisionId})).result;assert.equal((await mutate('environment.apply',{target:document.environmentId,revision:state.r2.revisionId})).result.status,'ready');
  state.r2worker=await worker('Pinned R2');await mutate('worker.update',{target:state.r2worker,environment:document.environmentId,revision:state.r2.revisionId});const second=await send(state.r2worker,'Call mcp__local__transform exactly once with value 6 and label "adr012-r2". Do not use any other tool. Return its exact output.');await settled(state.r2worker,second);
  const broken=await cli('capability.preview',{configuration:{mcpServers:{[`ADR012 unavailable ${label}`]:{url:'http://127.0.0.1:1/mcp',requirements:{execution:'foreground-host',files:[join(base,'unavailable-prerequisite')],identityFiles:[]}}}}});const missing=(await mutate('capability.import',{entries:broken.entries})).result.capabilities[0];const partialDoc={...document,environmentId:`adr012-${label||'primary'}-partial`,name:`ADR012 partial preparation ${label}`,components:[...document.components,{id:'missing',name:'Unavailable fixture',definition:{capabilityId:missing.id,revisionId:missing.revisionId}}]};state.partial=(await mutate('environment.publish',{document:partialDoc,expectRevision:null})).result;const partial=await mutate('environment.apply',{target:partialDoc.environmentId,revision:state.partial.revisionId},{acceptFailure:true});assert.equal(partial.state,'partial');
  const receipts=(await readFile(join(base,'fixture-receipts.ndjson'),'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.phase==='invoked');for(const [label,version,value] of [['adr012-r1',1,43],['adr012-r2',2,44]])assert(receipts.some(r=>r.input.label===label&&r.output.version===version&&r.output.value===value));await history(state.r1worker);await history(state.r2worker);await save(join(evidence,'fixture-receipts.json'),scrub(receipts));return {r1:state.r1,r2:state.r2,first,second,partial};
 });
 else if(phase==='image')await check('negotiated-image',async()=>{
  state.imageWorker??=await worker('Image evidence');const choices=await cli('worker.get',{target:state.imageWorker,options:true});const selected=choices.options.models.flatMap(m=>m.options).find(m=>JSON.parse(m.value)[1]===rules.imageModel);assert(selected,'Configured image model must be advertised by the harness');await mutate('worker.update',{target:state.imageWorker,model:selected.value});const path=join(base,'image.png');await sharp(Buffer.from('<svg width="160" height="120"><rect width="160" height="120" fill="#ed2020"/><circle cx="80" cy="60" r="30" fill="#2020ed"/></svg>')).png().toFile(path);
  const request=await send(state.imageWorker,'Identify the background color and the centered shape and its color. Do not use tools.',{content:[{type:'image',path,mediaType:'image/png'}]});await settled(state.imageWorker,request);const h=await history(state.imageWorker);const refs=[];function walk(v){if(!v||typeof v!=='object')return;if(typeof v.reference==='string')refs.push(v.reference);for(const x of Object.values(v))if(typeof x==='object')walk(x);}walk(h);assert(refs.length,'Image history must expose retained reference');state.evidence={worker:state.imageWorker,reference:refs[0],sha256:sha(await readFile(path))};await cli('worker.evidence',{target:state.imageWorker,reference:refs[0]},{output:join(base,'evidence-before.png')});assert.equal(sha(await readFile(join(base,'evidence-before.png'))),state.evidence.sha256);return {worker:state.imageWorker,request,reference:refs[0],sha256:state.evidence.sha256};
 });
 else if(phase==='L7')await check('L7-publish-lineage',async()=>{
  const checkpoint=(await mutate('checkpoint.publish',{node:state.node})).result;state.checkpoint=checkpoint;
  const g=await graph(),inherited=await mutate('node.create',{project:state.project.id,title:'Inherited evidence',expectRevision:g.revision,fromCheckpoint:checkpoint.id});state.inherited=inherited.result.nodes.find(n=>n.title==='Inherited evidence')?.id;assert(state.inherited);
  const lineage=await cli('node.get',{target:state.inherited});assert.equal(await readFile(join(lineage.workspace,'steering-result.txt'),'utf8'),'STEERED_RESULT\n');const retained=await git(state.workspace,'show',`${checkpoint.commit}:steering-result.txt`);assert.equal(retained,'STEERED_RESULT');
  const relation=await mutate('relation.create',{project:state.project.id,from:state.node,to:state.inherited,label:'continues evidence',expectRevision:(await graph()).revision});const edge=relation.result.edges.find(e=>e.from===state.node&&e.to===state.inherited);await mutate('relation.update',{target:edge.id,project:state.project.id,label:'validated continuation',expectRevision:(await graph()).revision});await mutate('relation.retract',{target:edge.id,project:state.project.id,expectRevision:(await graph()).revision});
  await mutate('node.update',{target:state.node,project:state.project.id,archived:true,expectRevision:(await graph()).revision});await mutate('worker.update',{target:state.b,archived:true});for(const id of state.workers)await mutate('worker.close',{target:id});return {checkpoint,lineage,relation:edge.id,retainedContentSha256:sha(retained+'\n')};
 });
 else if(phase==='cold')await check('L6-L7-cold-recovery',async()=>{
  const requestsBefore=budget().requests;
  const changes=await cli('graph.history',{project:state.project.id});assert(changes.entries.some(e=>JSON.stringify(e).includes('edge.retract')));const checkpoint=await cli('checkpoint.get',{node:state.node,target:state.checkpoint.id});assert.deepEqual(checkpoint,state.checkpoint);await history(state.b);
  if(state.evidence){await cli('worker.evidence',{target:state.evidence.worker,reference:state.evidence.reference},{output:join(base,`evidence-after-${state.cases.length}.png`)});assert.equal(sha(await readFile(join(base,`evidence-after-${state.cases.length}.png`))),state.evidence.sha256);}
  for(const id of state.workers){const retained=await cli('worker.get',{target:id});assert.equal(retained.state,'closed');assert.equal(retained.cleanupPending,false);}assert.equal(budget().requests,requestsBefore,'Cold public reads must not execute a model');const requestsAfterColdReads=budget().requests;
  await mutate('worker.resume',{target:state.r1worker});assert.equal((await cli('worker.get',{target:state.r1worker})).harnessSessionId,state.r1session);const request=await send(state.r1worker,'Call mcp__local__transform exactly once with value 6 and label "adr012-resumed-r1". Do not use other tools. Return its exact output.');await settled(state.r1worker,request);const receipts=(await readFile(join(base,'fixture-receipts.ndjson'),'utf8')).trim().split('\n').map(JSON.parse).filter(r=>r.phase==='invoked');assert(receipts.some(r=>r.input.label==='adr012-resumed-r1'&&r.output.version===1&&r.output.value===43));await mutate('worker.close',{target:state.r1worker});await save(join(evidence,'fixture-receipts.json'),scrub(receipts));await history(state.r1worker);await history(state.a);return {requestsBefore,requestsAfterColdReads,checkpoint,graphHistory:changes,evidence:state.evidence,resumed:state.r1worker,request};
 });
 else if(phase==='restart-main')await check('independent-main-restart',async()=>{
  await mutate('daemon.stop',{target:'main'});const retained=await cli('environment.get',{target:state.r1.environmentId,revision:state.r1.revisionId});assert.equal(retained.revisionId,state.r1.revisionId);
  const unavailable=await cli('project.list',{}, {acceptFailure:true});assert(unavailable.error);if(label){console.log(JSON.stringify({mainUnavailable:true}));await until(async()=>{try{return await stat(join(base,'main-outage-inspected'));}catch{return null;}},'browser Main outage inspection');}await mutate('daemon.start',{target:'main',detach:true});return {environmentReadableWithoutMain:true};
 });
 else if(phase==='outage-environment')await check('L8-independent-environment-outage',async()=>{
  await mutate('daemon.stop',{target:'environment'});await graph();const choices=await cli('worker.get',{target:state.a,options:true});assert(choices.options.environmentError);console.log(JSON.stringify({environmentUnavailable:true}));
  await until(async()=>{try{return await stat(join(base,'environment-outage-inspected'));}catch{return null;}},'browser outage inspection');
  await mutate('daemon.start',{target:'environment',detach:true});return {researchAvailable:true,environmentUnavailableExplicit:true};
 });
 else if(phase==='observer-mutation')await check('L8-bounded-refresh',async()=>{
  // Give the independently controlled browser time to arm its DOM observation.
  if(process.argv.includes('--armed'))await until(async()=>{try{return await stat(join(base,'browser-armed'));}catch{return null;}},'browser observation armed');else await delay(rules.browserConvergenceMs);
  const before=Date.now(),document={format:2,environmentId:`adr012-${label||'primary'}-observer`,name:`ADR012 observer refresh ${label}`,description:'Authoritative browser convergence fixture',components:[]};
  const receipt=await mutate('environment.publish',{document,expectRevision:null});state.observerMutation={before,committed:Date.now(),receipt};await retain();return state.observerMutation;
 });
 else if(phase==='snapshot'){
  state.graph=await graph();state.budget=budget();state.finalWorkers=(await cli('worker.list',{project:state.project.id})).items;state.environments=await cli('environment.list');await retain();await save(join(evidence,'campaign.json'),scrub(state));
 }else throw new Error('Unknown campaign phase');
}finally{await retain();}
