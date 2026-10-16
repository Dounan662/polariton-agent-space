/** Real workers receive public package examples and prepare/test capabilities through
 * the shipped interface. Fresh roots isolate this campaign from the running experiment. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,appendFile,cp} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {loadConfig,Config,sourceRoot} from '../src/config.ts';
import {createApp} from '../src/main.ts';
import {createEnvironmentDaemon,loadRackConfig} from '../src/environment/daemon.ts';
import {Harness} from '../harness/client.ts';
import {VerificationBudget} from '../harness/budget.mjs';
import {ProviderSettings} from '../harness/providers.ts';
assert(process.argv.includes('--live'),'Explicit --live is required');
assert(process.env.DEEPSEEK_API_KEY?.trim(),'Supply the V5 provider credential through --env-file; never put it in campaign evidence');
const requested=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
const positive=z.number().int().positive();
const limits=z.object({maxRequests:positive,maxLiveMs:positive,maxOutputTokens:positive,maxRequestsPerTurn:positive,maxActiveWorkers:positive,observationTimeoutMs:positive,commandTimeoutMs:positive,commandBytes:positive,pollMs:positive,packageTimeoutMs:positive,operationTimeoutMs:positive,maxPackageBytes:positive}).strict().parse(JSON.parse(await readFile(new URL(requested==='authored'?'../config/adr031-authoring-live.json':'../config/adr031-live.json',import.meta.url),'utf8')));
// The authored campaign stays under the existing dedicated VM's provisioned mount.
const runId=new Date().toISOString().replaceAll(':','-'),run=join(sourceRoot,requested==='authored'?'.local/adr031-git':'.local/adr031',runId),evidence=join(sourceRoot,'docs/evidence/adr031/live',runId);
await mkdir(run,{recursive:true,mode:0o700});await mkdir(evidence,{recursive:true});
const configPath=join(run,'app.json'),environmentConfig=join(run,'environment.json'),toolchainsPath=join(sourceRoot,'.local/adr031-toolchains/tools.json');
let packageTools={};try{packageTools=JSON.parse(await readFile(toolchainsPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const originalRack=await loadRackConfig();
await writeFile(environmentConfig,JSON.stringify({...originalRack,stateRoot:join(run,'environment'),dockerConfig:join(run,'docker'),socketPath:join('/tmp',`polariton-031-${randomUUID().slice(0,8)}.sock`),packageTools,packageTimeoutMs:limits.packageTimeoutMs,operationTimeoutMs:limits.operationTimeoutMs,maxPackageBytes:limits.maxPackageBytes,preparedContainerCapacity:3}));
const config=Config.parse({...await loadConfig(),configPath,stateRoot:join(run,'state'),runtimeDirectory:join('/tmp',`polariton-031-main-${randomUUID().slice(0,8)}`),sharedSkillsDir:join(run,'skills'),environmentConfig,verification:false,campaign:undefined,maxOutputTokens:limits.maxOutputTokens,maxRequestsPerTurn:limits.maxRequestsPerTurn,maxActiveWorkers:limits.maxActiveWorkers,requestTimeoutMs:limits.observationTimeoutMs,permissionTimeoutMs:limits.maxLiveMs,workerIdleUnloadMs:null});
await writeFile(configPath,JSON.stringify(config));await mkdir(config.sharedSkillsDir);
const secrets=new Set([process.env.DEEPSEEK_API_KEY,process.env.OPENAI_API_KEY]);
const scrub=value=>{let text=typeof value==='string'?value:JSON.stringify(value,null,2);for(const secret of secrets)if(secret)text=text.replaceAll(secret,'<REDACTED>');return text.replaceAll(sourceRoot,'<V5>');};
const save=(name,data)=>writeFile(join(evidence,name),scrub(data)+'\n',{mode:0o600});
const report={runId,provider:config.provider,model:config.model,platform:`${process.platform}-${process.arch}`,startedAt:new Date().toISOString(),limits,requests:0,cases:[],passed:false};
const ledger=new VerificationBudget(join(run,'budget.sqlite'),limits),harnesses=new Map();
let runtime,environment,expired=false;
const timeout=setTimeout(()=>{expired=true;for(const h of harnesses.values())void h.close().catch(()=>{});},ledger.remainingMs);
const browser=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>ADR031 Browser Fixture</title><h1>Capability verification</h1><button onclick="document.querySelector(\'output\').textContent=\'Result 42\'">Calculate</button><output>Waiting</output>');});
await new Promise(resolve=>browser.listen(0,'127.0.0.1',resolve));
const browserUrl=`http://127.0.0.1:${browser.address().port}`;
const cases=[
 {type:'npm',link:'https://github.com/microsoft/playwright-mcp',source:'npm:@playwright/mcp@0.0.83',task:`Use the browser tools to navigate to ${browserUrl}, click Calculate, verify that output becomes Result 42, and close the browser.`,required:['browser_navigate','browser_click','browser_close']},
 {type:'pypi',link:'https://github.com/modelcontextprotocol/servers/tree/main/src/time',source:'pypi:mcp-server-time@2026.10.10',task:'Use the time capability to get current UTC time and report the returned timezone and ISO datetime.',required:['get_current_time']},
 {type:'nuget',link:'https://www.nuget.org/packages/NuGet.Mcp.Server/1.4.16',source:'nuget:NuGet.Mcp.Server@1.4.16',task:'Use the NuGet capability to look up package metadata or available versions for Newtonsoft.Json. Perform one read operation and report a version from the result.',required:[]},
 {type:'cargo',link:'https://github.com/jbr/cargo-mcp',source:'cargo:cargo-mcp@0.2.0',hint:'The crate exposes its MCP server through argument serve. Declare requirements.nativeBuild=true in the complete specification; this explicitly authorizes the bounded native build recipe. Source executable is cargo-mcp.',task:'Create a minimal dependency-free Rust library crate in this node workspace using file tools. Use the Cargo MCP capability to check that crate and report the actual check result.',required:['cargo_check']},
 {type:'oci',link:'https://hub.docker.com/r/mcp/time',source:'oci:docker.io/mcp/time:latest',task:'Use the time capability to get current UTC time and report the returned timezone and datetime.',required:['get_current_time']},
 {type:'mcpb',link:'https://github.com/j0hanz/filesystem-mcp/releases/tag/v2.7.6',hint:'Use bundle https://github.com/j0hanz/filesystem-mcp/releases/download/v2.7.6/filesystem-mcp.mcpb with SHA256 fabf9864aa293af5e08e1d12142512a87c6de0f789d9ffcd1371b289ace395c8. It is a local stdio bundle. Required bundle configuration: allowed_directories=["${POLARITON_WORKSPACE}"]. Use the complete preparation input.',task:'Create adr031-marker.txt containing Capability boundary verified in this node workspace with file tools. Then use the filesystem MCP capability to read that file and verify the exact content.',required:[]},
 {type:'authored',task:'Use the assigned calibration MCP tool fit_line on points [{"x":0,"y":1},{"x":1,"y":2},{"x":2,"y":2},{"x":3,"y":4}] with predictAt [4,-1]. Then call it on [{"x":-2,"y":7},{"x":0,"y":3},{"x":2,"y":-1}] with predictAt [1]. Finally call it on two points with the same x and confirm it returns an explicit error. Write consumer-evidence.md with the actual results. Use the assigned MCP tool for all three calls; do not compute substitutes through Bash or import the source. Finish without sending a reply.',required:['fit_line']},
].filter(c=>requested?c.type===requested:c.type!=='authored');
assert(cases.length,'Unknown --case');
async function cli(command,input={},mutation=false){
 const args=['--config',configPath,...command.split('.'),'--input','-',...(mutation?['--request-id',randomUUID(),'--details']:command==='operation.get'?['--details']:[])];
 const env={...process.env};delete env.HARNESSCTL_TOKEN;delete env.DSH_HARNESSCTL_TOKEN;
 const child=spawn(process.execPath,[join(sourceRoot,'bin/harnessctl'),...args],{cwd:run,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',bytes=0;
 const timer=setTimeout(()=>child.kill('SIGTERM'),limits.commandTimeoutMs);
 const collect=(kind,chunk)=>{bytes+=chunk.length;if(bytes>limits.commandBytes){child.kill('SIGKILL');return;}if(kind==='out')stdout+=chunk;else stderr+=chunk;};
 child.stdout.on('data',c=>collect('out',c));child.stderr.on('data',c=>collect('err',c));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 let code;try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);}
 const result=JSON.parse(stdout);await appendFile(join(evidence,'commands.ndjson'),scrub({command,input,code,result,stderr})+'\n');assert.equal(code,0,`${command}: ${scrub(result)}`);return result.data;
}
async function until(ready,label){const deadline=Date.now()+limits.observationTimeoutMs;while(!expired&&Date.now()<deadline){const value=await ready();if(value)return value;await delay(limits.pollMs);}throw new Error(`Deadline waiting for ${label}`);}
async function idle(id){return until(()=>{const worker=runtime.agents.get(id);if(worker.permissions.length)throw new Error(`Worker requires explicit permission: ${worker.title}`);if(['failed','uncertain','closed'].includes(worker.state))throw new Error(`Worker ${worker.title}: ${worker.state} ${worker.error}`);return worker.state==='idle'?worker:null;},`worker ${id}`);}
async function history(id){const first=await cli('worker.history',{target:id}),events=[...first.events];let before=first.before;while(before!==null){const next=await cli('worker.history',{target:id,cut:first.cut,before});events.unshift(...next.events);before=next.before;assert(events.length<config.maxHistoryEvents);}await save(`history-${id}.json`,{...first,events});return events;}
try{
 const providers=await ProviderSettings.open(join(config.stateRoot,'provider-settings'),{discoveryTimeoutMs:config.providerDiscoveryTimeoutMs,lockTimeoutMs:config.startupTimeoutMs});try{await providers.save({id:config.provider,kind:'builtin'});await providers.setDefault(JSON.stringify([config.provider,config.model]));}finally{await providers.close();}
 environment=await createEnvironmentDaemon(await loadRackConfig(environmentConfig));
 runtime=await createApp(config,(settings,home,workspace,budget,permission)=>{if(settings.workerCredential)secrets.add(settings.workerCredential.token);const h=new Harness(settings,home,workspace,async()=>{const allowed=await budget()&&ledger.reserve();if(allowed)report.requests++;return allowed;},permission);harnesses.set(basename(home),h);return h;});await runtime.app.ready();
 const project=(await cli('project.create',{name:requested==='authored'?'ADR031 original tool authoring':'ADR031 package workers',root:join(run,'research')},true)).result;report.project=project.id;
 for(const example of cases){
  const item={...example,startedAt:new Date().toISOString(),passed:false};report.cases.push(item);
  console.log(JSON.stringify({case:example.type,state:'starting',requests:report.requests}));
  try{
   const graph=await cli('graph.get',{project:project.id});await cli('node.create',{project:project.id,expectRevision:graph.revision,title:`${example.type} qualification`},true);
   const node=(await cli('graph.get',{project:project.id})).nodes.find(n=>n.title===`${example.type} qualification`);
   const author=(await cli('worker.create',{node:node.id,title:`${example.type} capability author`},true)).result;item.author=author.id;
   const task=example.type==='authored'
    ?`Build an original scientific calibration MCP capability from scratch in this workspace. It must expose fit_line with points:[{x,y},...] and predictAt:[number,...]. Return slope, intercept, rSquared and predictions (an array of predicted y values in input order) as bounded JSON text usable by the model. Fit an ordinary least-squares straight line with intercept. Reject fewer than two points, non-finite inputs and constant x with explicit tool errors. Implement meaningful MCP tests for numeric correctness and invalid inputs. You may use the bundled authoring starter for server infrastructure, but write the scientific behavior yourself; no third-party regression tool or prewritten calibration implementation.\nUse the installed make-polariton-tool skill and public CLI help to prepare and functionally validate the committed capability. Work only in this workspace and the skill's documented resources; do not inspect Polariton application source, private configuration, credential stores or other experiments. Container runtime provisioning is already supplied. If a prerequisite or permission is unavailable, report it and stop.\nAfter successful preparation and validation, create exactly one coworker named authored capability consumer on this node, assigned the exact prepared environment revision, and send this task: ${example.task}\nWrite preparation-evidence.md with the package directory, exact commit/release/environment/revision, tests and validation observations. Also write authoring-feedback.md describing any unclear instructions, failed commands and assistance needed, with no claim that an untested step passed. Finish after sending; do not poll, create other coworkers or use native subagents. You are authorized to author, commit, prepare and test this tool and send that one consumer task. The run has an enforced shared limit of ${limits.maxRequests} provider requests.`
    :`Prepare and test an MCP capability from this public ${example.type} example: ${example.link}. ${example.source?`Selected package source: ${example.source}.`:''} ${example.hint??''}\nUse harnessctl public help and Environment preparation operations. Do not inspect application source, private configuration, credential stores or other experiments. Do not install the package using an independent shell workaround. Keep the original operation identity if a command times out; inspect it. If a required toolchain or permission remains unavailable, report the exact pending action and stop rather than attempting global installations.\nAfter preparation is ready, validate connection/discovery through harnessctl. Then create exactly one inactive coworker named ${example.type} capability consumer on this node, assigned the exact prepared environment revision, and send this functional task: ${example.task} Ask them to write consumer-evidence.md and finish without sending a reply. Write preparation-evidence.md with source URL, exact capability/environment/revision IDs, preparation status and validation observations. Finish after sending; do not poll, create other coworkers or use native subagents. You are authorized to prepare this example and send that one test task.`;
   await save(`task-${example.type}.txt`,task);await cli('worker.send',{target:author.id,text:task},true);await idle(author.id);
   const workers=runtime.agents.list(project.id,node.id),consumer=workers.find(w=>w.id!==author.id);assert(consumer,`${example.type}: author must create consumer after preparation`);item.consumer=consumer.id;await idle(consumer.id);
   const authorEvents=await history(author.id),consumerEvents=await history(consumer.id);
   const calls=consumerEvents.filter(e=>e.type==='tool/call'&&e.data.name.startsWith('mcp__'));
   assert(calls.length,`${example.type}: consumer must invoke actual MCP tools`);
   for(const suffix of example.required)assert(calls.some(c=>c.data.name.endsWith('__'+suffix)),`Missing actual ${suffix} call`);
   const outcomes=calls.map(c=>({name:c.data.name,call:c.data,result:consumerEvents.find(e=>e.type==='tool/result'&&e.data.message?.toolCallId===c.data.callId)?.data.message}));
   assert(outcomes.every(o=>o.result),`${example.type}: MCP invocation did not return`);
   if(example.type==='authored'){
    // Independent expected values; neither worker receives this acceptance oracle.
    const expected=[{points:[{x:0,y:1},{x:1,y:2},{x:2,y:2},{x:3,y:4}],predictAt:[4,-1],slope:0.9,intercept:0.9,rSquared:4.05/4.75,predictions:[4.5,0]},
     {points:[{x:-2,y:7},{x:0,y:3},{x:2,y:-1}],predictAt:[1],slope:-2,intercept:3,rSquared:1,predictions:[1]}];
    item.numericChecks=[];
    for(const sample of expected){
     const actual=outcomes.find(o=>{const args=JSON.parse(o.call.arguments);return args.points?.length===sample.points.length&&args.points.every((point,i)=>point.x===sample.points[i].x&&point.y===sample.points[i].y)&&JSON.stringify(args.predictAt)===JSON.stringify(sample.predictAt);});
     assert(actual&&!actual.result.isError,'Consumer must invoke each requested calibration sample successfully');
     const value=JSON.parse(actual.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
     for(const field of ['slope','intercept','rSquared'])assert(Math.abs(value[field]-sample[field])<1e-10,`Incorrect ${field}`);
     assert.equal(value.predictions.length,sample.predictions.length);sample.predictions.forEach((y,i)=>assert(Math.abs(value.predictions[i]-y)<1e-10,'Incorrect prediction'));
     item.numericChecks.push({input:{points:sample.points,predictAt:sample.predictAt},observed:value,passed:true});
    }
    assert(outcomes.some(o=>{const args=JSON.parse(o.call.arguments);return args.points?.length>=2&&args.points.every(p=>p.x===args.points[0].x)&&o.result.isError;}),'Constant-x input must produce a real MCP error');
   }else assert(outcomes.every(o=>!o.result.isError),`${example.type}: MCP invocation failed`);
   const authorCalls=authorEvents.filter(e=>e.type==='tool/call');item.authorToolCalls=authorCalls.length;item.consumerMcpCalls=calls.length;item.requests=report.requests;item.outcomes=outcomes;item.assignment=runtime.agents.get(consumer.id).environment;
   assert(authorCalls.some(c=>c.data.name==='bash'&&c.data.arguments.includes('environment prepare')),'Author must use common preparation operation');
   const detail=await cli('node.get',{target:node.id,project:project.id});for(const file of ['preparation-evidence.md','consumer-evidence.md'])await save(`${example.type}-${file}`,await readFile(join(detail.workspace,file),'utf8'));
   if(example.type==='authored'){
    await save('authored-authoring-feedback.md',await readFile(join(detail.workspace,'authoring-feedback.md'),'utf8'));
    assert(authorCalls.some(c=>c.data.name==='skill'&&c.data.arguments.includes('make-polariton-tool')),'Author must load the installed skill');
    const inspected=await cli('environment.inspect',{target:item.assignment.selection.environmentId,revision:item.assignment.selection.revisionId});
    item.inspection=inspected;const authored=inspected.components.find(c=>c.source.kind==='git');assert(authored,'Prepared capability must be authored Git source');
    const provenance=await environment.rack.provenance(authored.capabilityId);await save('authored-provenance.json',provenance);
    await cp(join(run,'environment','releases',authored.capabilityId,'source.tar'),join(evidence,'authored-source.tar'));
    assert(inspected.observations.some(o=>o.components.some(c=>c.check?.status==='passed'&&c.cleanup==='settled')),'Named functional validation must pass with settled cleanup');
   }
   if(example.type==='npm')assert(JSON.stringify(outcomes).includes('Result 42'),'Browser must observe actual interaction result');
   item.passed=true;
  }catch(error){item.error=error.message;for(const id of [item.author,item.consumer].filter(Boolean))try{await history(id);}catch{};}
  finally{item.finishedAt=new Date().toISOString();await save('report.json',report);for(const id of [item.author,item.consumer].filter(Boolean))try{await cli('worker.close',{target:id},true);}catch(error){item.cleanupError=error.message;}console.log(JSON.stringify({case:example.type,passed:item.passed,error:item.error,requests:report.requests}));}
 }
 report.passed=report.cases.every(c=>c.passed&&!c.cleanupError);assert(report.passed,'Some package workers failed; inspect retained evidence');
}finally{
 clearTimeout(timeout);if(runtime)await runtime.app.close();if(environment)await environment.app.close();await new Promise(resolve=>browser.close(resolve));report.finishedAt=new Date().toISOString();const finalBudget=ledger.close();report.requests=finalBudget.requests;await save('report.json',report);console.log(JSON.stringify({evidence,passed:report.passed,requests:report.requests}));
}
