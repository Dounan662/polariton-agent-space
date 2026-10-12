import {nativeTurn} from './native-turn.mjs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Harness } from '../harness/client.ts';
import { VerificationBudget } from '../harness/budget.mjs';
import { readHistory } from '../harness/history.mjs';
import { loadConfig, CampaignConfig } from '../src/config.ts';
import { EnvironmentClient,loadRackConfig } from '../src/environment/daemon.ts';

/** Agent-authored lifecycle evidence. Scientific correctness is checked independently of prose and generated tests. */
const root=fileURLToPath(new URL('../',import.meta.url)),base=join(root,'.local/adr009'),evidence=join(root,'docs/evidence/adr009');
const exec=promisify(execFile),limits=CampaignConfig.parse(JSON.parse(await readFile(join(root,'config/adr009-campaign.json'),'utf8')));
if(!process.argv.includes('--live'))throw new Error('Explicit --live required for real-provider campaign');
if(!process.env.DEEPSEEK_API_KEY?.trim())throw new Error('Missing configured provider credential; live verification not run');
await mkdir(base,{recursive:true});await mkdir(evidence,{recursive:true});
const corrective=process.argv.includes('--repair');
const attempts=new DatabaseSync(join(base,'campaign.sqlite'));attempts.exec('CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,started TEXT NOT NULL,corrective INTEGER NOT NULL)');
const existing=attempts.prepare('SELECT COUNT(*) n FROM attempts').get().n;
if(existing&&!corrective)throw new Error('Campaign already attempted; use --repair within the retained budget');
if(corrective&&attempts.prepare('SELECT COUNT(*) n FROM attempts WHERE corrective=1').get().n>=limits.maxRepairCycles)throw new Error('Correction cycle budget exhausted');
attempts.prepare('INSERT INTO attempts(started,corrective) VALUES(?,?)').run(new Date().toISOString(),Number(corrective));
const attempt=Number(attempts.prepare('SELECT MAX(id) id FROM attempts').get().id);attempts.close();
const ledger=new VerificationBudget(resolve(root,'config',limits.ledger),corrective?{...limits,reserveRequests:0,reserveMs:0}:limits);
const run=join(base,`attempt-${attempt}`),workspace=join(run,'builder'),consumerWorkspace=join(run,'consumer');await mkdir(workspace,{recursive:true});await mkdir(consumerWorkspace,{recursive:true});
const rackPath=join(run,'environment.json'),rackDefaults=await loadRackConfig();
await writeFile(rackPath,JSON.stringify({...rackDefaults,stateRoot:join(base,'rack'),socketPath:'/tmp/polariton-adr009-live.sock'}));
const config={...await loadConfig(),verification:true,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:limits.requestTimeoutMs};
const cliConfigPath=join(run,'cli-app.json');await writeFile(cliConfigPath,JSON.stringify({...config,environmentConfig:rackPath}));
const rack=new EnvironmentClient(await loadRackConfig(rackPath));
const harnesses=[],report={attempt,provider:config.provider,model:config.model,harness:JSON.parse(await readFile(join(root,'package.json'),'utf8')).dependencies['@deepseek-ai/dsh'],checks:[],sessions:[],interventions:[],budget:null};
const children=[];let expired=false;
const timer=setTimeout(()=>{expired=true;for(const harness of harnesses)void harness.close().catch(error=>console.error(error));},ledger.remainingMs);
const scrub=value=>JSON.stringify(value).replaceAll(process.env.DEEPSEEK_API_KEY,'<REDACTED>').replace(/Bearer [A-Za-z0-9_-]+/g,'Bearer <REDACTED>').replaceAll(root,'<V5>');
const check=(name,details={})=>report.checks.push({name,status:'pass',...details});
const permission=async request=>({outcome:'selected',optionId:request.options.find(option=>option.kind==='allow_once')?.optionId??request.options.find(option=>option.kind==='allow_always')?.optionId??'reject-once'});
const git=async(...args)=>(await exec('git',['-C',workspace,...args],{timeout:config.requestTimeoutMs})).stdout.trim();
async function agent(role,connections=[]){
  const cwd=role==='builder'?workspace:consumerWorkspace,home=join(run,`dsh-${role}-${harnesses.length}`),h=new Harness(config,home,cwd,async()=>ledger.reserve(),permission);harnesses.push(h);
  await h.start();const opened=await h.activate(null,connections.map((connection,index)=>({type:'http',name:`statistics${index}`,url:connection.url,headers:connection.headers})));
  report.sessions.push({role,sessionId:opened.sessionId,home});return {h,id:opened.sessionId,cwd};
}
async function turn(agent,text){const result=await nativeTurn(agent.h,agent.id,text,config.requestTimeoutMs);assert.equal(result.reason.kind,'completed',JSON.stringify(result));await agent.h.observe(agent.id);return readHistory(join(agent.h.home,'sessions'),agent.id,{limit:config.maxHistoryEvents});}
async function admin(command){return rack.call('/v1/command',command);}
async function consumer(connection,version){
  const worker=await agent(`consumer-r${version}`,[connection]);
  const text=version===1?'Use the mounted statistics MCP tool to calculate count, mean and population standard deviation of [2,4,4,4,5,5,7,9], and of [7]. Also call it with [] to verify a visible tool error.':'Use the mounted MCP tools: calculate weighted statistics for values [1,3] weights [1,3], and values [1,3] weights [0,1]. Then call weighted statistics with negative weights, all-zero weights, and mismatched lengths to verify visible errors. Also use the ordinary statistics tool on [2,4,4,4,5,5,7,9].';
  const history=await turn(worker,`${text} Do not use shell, files, Python, or substitute your own calculations for the MCP calls. Make the requested calls and report their returned results briefly.`);
  await writeFile(join(run,`consumer-r${version}-history.json`),scrub(history));
  const events=history.events;const calls=events.filter(event=>event.type==='tool/call'&&JSON.stringify(event).includes('mcp__'));
  assert(calls.length>= (version===1?3:6),'Actual consumer MCP calls must be recorded');
  // Read normalized source events, retaining exact result records for the independent audit.
  const completions=events.filter(event=>/tool\//.test(event.type)&&event.type!=='tool/call');
  assert(completions.length>=calls.length,'Each requested MCP call has a recorded completion');
  check(`real-dsh-r${version}-mcp`,{sessionId:worker.id,calls:calls.length});
  await worker.h.closeSession(worker.id);await worker.h.close();await admin({kind:'binding.release',operationId:`release-consumer-${attempt}-${version}`,id:connection.bindingId});return history;
}
async function oracle(release,version){
  const mountId=`oracle-${attempt}-${version}`;
  await admin({kind:'mount.create',operationId:`create-${mountId}`,id:mountId,component:{id:'stats',name:'Oracle',releaseId:release.id,configuration:{}}});
  const connection=await admin({kind:'binding.create',operationId:`bind-${mountId}`,mountId,principal:'independent-verifier',access:'call'});
  const client=new Client({name:'independent-verifier',version:'1'}),records=[];
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{requestInit:{headers:Object.fromEntries(connection.headers.map(value=>[value.name,value.value]))}}));
    const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});records.push({name,arguments:args,result});return result;};
    const near=(a,b)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=1e-12+1e-10*Math.abs(b));
    let r=(await call('statistics',{values:[2,4,4,4,5,5,7,9]})).structuredContent;assert.equal(r.count,8);near(r.mean,5);near(r.standardDeviation,2);
    near((await call('statistics',{values:[7]})).structuredContent.standardDeviation,0);r=(await call('statistics',{values:[1e308,1e308]})).structuredContent;near(r.mean,1e308);near(r.standardDeviation,0);r=(await call('statistics',{values:[1e308,-1e308]})).structuredContent;near(r.mean,0);near(r.standardDeviation,1e308);assert.equal((await call('statistics',{values:[]})).isError,true);
    if(version===2){r=(await call('weighted_statistics',{values:[1,3],weights:[1,3]})).structuredContent;near(r.mean,2.5);near(r.standardDeviation,Math.sqrt(.75));r=(await call('weighted_statistics',{values:[1,3],weights:[1e308,1e308]})).structuredContent;near(r.mean,2);near(r.standardDeviation,1);near((await call('weighted_statistics',{values:[1,3],weights:[0,1]})).structuredContent.standardDeviation,0);for(const weights of [[-1,1],[0,0],[1]])assert.equal((await call('weighted_statistics',{values:[1,3],weights})).isError,true);}
    check(`independent-r${version}-numerics`);await writeFile(join(run,`oracle-r${version}.json`),JSON.stringify(records,null,2));
  }finally{await client.close();await admin({kind:'binding.release',operationId:`release-${mountId}`,id:connection.bindingId});await admin({kind:'mount.stop',operationId:`stop-${mountId}`,id:mountId,force:false});}
}

try{
  const {spawn}=await import('node:child_process');const daemon=spawn(process.execPath,[join(root,'src/environment/daemon.ts'),rackPath],{cwd:root,stdio:['ignore','pipe','pipe']});children.push(daemon);let log='';daemon.stdout.on('data',chunk=>log+=chunk);daemon.stderr.on('data',chunk=>log+=chunk);
  const deadline=Date.now()+config.startupTimeoutMs;while(true){try{await rack.call('/v1/health');break;}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,config.interruptPollMs));}}
  await copyFile(join(root,'environment/server.mjs'),join(workspace,'server-support.mjs'));
  for(const file of ['package.json','package-lock.json'])await copyFile(join(root,'tests/fixtures/adr009',file),join(workspace,file));
  const image='node@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152';
  const builder=await agent('builder');
  const cli=`${process.execPath} ${JSON.stringify(join(root,'bin/harnessctl'))} --config ${JSON.stringify(cliConfigPath)}`;
  const r1id=randomUUID(),r2id=randomUUID(),envid=`live-environment-${attempt}`,e1id=randomUUID(),e2id=randomUUID(),pkgid=`p-${createHash('sha256').update(workspace).digest('hex').slice(0,32)}`,registerId=randomUUID(),apply1Id=randomUUID(),apply2Id=randomUUID();
  const initial=`Build a measurement-statistics MCP capability here. Work only in this workspace and use the public administrative CLI described below. Do not delegate or edit daemon state. Dependencies package.json and lockfile and server-support.mjs are supplied plumbing; implement scientific/server code yourself.\nCreate statistics.mjs exporting statistics(values), returning {count,mean,standardDeviation}; require nonempty finite numeric arrays, population deviation ddof=0, singleton deviation0, reject invalid inputs. Create tests in test.mjs and run node --test test.mjs after npm ci. Create server.mjs using McpServer from @modelcontextprotocol/server, zod, and serveCapability from ./server-support.mjs. Use server.registerTool('statistics',{description,inputSchema:z.object({values:z.array(z.number())})}, handler). Return both content text JSON and structuredContent. Tool invalid input isError true. createServer must return a fresh McpServer. Expose stats://capability JSON resource {version:1,operations:['statistics']}. Call await serveCapability({createServer}).\nWrite polariton-capability.json: {format:1,name:'Measurement statistics',description:'Population measurement statistics',image:'${image}',build:[['npm','ci','--ignore-scripts','--omit=dev','--cache','/tmp/npm'],['node','--test','test.mjs']],entrypoint:['node','server.mjs'],lockfiles:['package-lock.json'],configSchema:{type:'object',additionalProperties:false},mcpPath:'/mcp',port:8080,state:'scratch'}.\nInitialize Git, commit source/tests/support/manifests but not node_modules. Use git -c user.name='Polariton builder' -c user.email=builder@polariton.invalid for commits.\nThen register/install/publish/apply via public CLI. Use ${cli} --help --schema --json for the full contract. Register using ${cli} capability register --request-id ${registerId} --repository YOUR_CWD. Install using ${cli} release install ${pkgid} --request-id ${r1id} --commit EXACT_HEAD. Publish using ${cli} environment publish --request-id ${e1id} --input FILE where FILE contains {expectRevision:null,document:{format:2,environmentId:'${envid}',name:'Live statistics',description:'Independent scientific verification',components:[{id:'stats',name:'Statistics',releaseId:'${r1id}',configuration:{}}]}}. Apply using ${cli} environment apply ${envid} --request-id ${apply1Id} --revision ${e1id}. Inspect actual results; stop and report any failure. Do not write administrative JSON command files into the Git commit. Report commit and IDs. Use pinned package APIs; read local SDK types if needed. Batch related file creation and testing in a small number of shell calls. Numerical requirements include extreme finite doubles: [1e308,1e308] must return finite mean1e308 and deviation0; [1e308,-1e308] mean0 and deviation1e308. Avoid overflow by normalizing values by their largest absolute magnitude before computing moments; add these regression cases.`;
  const first=await turn(builder,initial);await writeFile(join(run,'builder-r1-history.json'),scrub(first));
  let inventory=await rack.call('/v1/inventory');const r1=inventory.releases.find(value=>value.id===r1id);assert(r1,'Builder must install R1 via public API');assert.equal(r1.commit,await git('rev-parse','HEAD'));const e1=await rack.call(`/v1/revisions/${envid}/${e1id}`);const realized=inventory.realizations.find(value=>value.revisionId===e1id&&value.status==='ready');assert(realized,'Builder must apply E1');const mount=realized.components[0].mountId;check('builder-create-test-install-assemble-r1',{commit:r1.commit,release:r1id,revision:e1id});await oracle(r1,1);
  const connection1=await admin({kind:'binding.create',operationId:`consumer-${attempt}-1`,mountId:mount,principal:'consumer-r1',access:'call'});await consumer(connection1,1);
  const improve=`Improve your capability to version 2. Add exported weightedStatistics(values,weights) to statistics.mjs with weighted population mean/deviation, equal lengths, finite nonnegative weights and positive total weight. Preserve statistics and its overflow-safe implementation. Normalize weights before summing products to prevent overflow for finite large weights; values [1,3],weights [1e308,1e308] must return mean2,deviation1. Add tests for large values and weights. Batch related edits/tests in a small number of shell calls. Expose MCP weighted_statistics with {values,weights} input and invalid-weight isError outcomes. Update stats://capability to version2 with both operations. Add and run tests. Commit source/tests, then install R2 using public CLI ${cli} release install ${pkgid} --request-id ${r2id} --commit NEW_HEAD. Do not alter E1, stop existing mounts, publish E2 or apply upgrades yet. Report tested commit and release.`;
  const second=await turn(builder,improve);await writeFile(join(run,'builder-r2-history.json'),scrub(second));inventory=await rack.call('/v1/inventory');const r2=inventory.releases.find(value=>value.id===r2id);assert(r2);assert.notEqual(r1.commit,r2.commit);assert.equal(inventory.mounts.find(value=>value.id===mount).component.releaseId,r1.id);await oracle(r2,2);check('builder-improve-r2-preserves-r1',{commit:r2.commit});
  const third=await turn(builder,`Publish and explicitly apply E2 now through ${cli}. Publish using environment publish --request-id ${e2id} --input FILE with {expectRevision:'${e1id}',document:{format:2,environmentId:'${envid}',name:'Live statistics',description:'Weighted statistics revision',components:[{id:'stats',name:'Statistics',releaseId:'${r2id}',configuration:{}}]}}. Apply using environment apply ${envid} --request-id ${apply2Id} --revision ${e2id}. Do not change source or other mounts. Report actual result.`);await writeFile(join(run,'builder-upgrade-history.json'),scrub(third));
  inventory=await rack.call('/v1/inventory');const upgraded=inventory.realizations.find(value=>value.revisionId===e2id&&value.status==='ready');assert(upgraded);const connection2=await admin({kind:'binding.create',operationId:`consumer-${attempt}-2`,mountId:upgraded.components[0].mountId,principal:'consumer-r2',access:'call'});await consumer(connection2,2);const version2=await admin({kind:'observe',mountId:upgraded.components[0].mountId,uri:'stats://capability'});assert(version2.available);assert.equal(JSON.parse(version2.value.contents[0].text).version,2);await writeFile(join(run,'version-r2.json'),scrub(version2));check('explicit-e2-upgrade');
  // Fault injection is controlled by the verifier, independently of agent competence.
  const manifestPath=join(workspace,'polariton-capability.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));await writeFile(manifestPath,JSON.stringify({...manifest,build:[['node','-e','process.exit(17)']]}));await git('add','polariton-capability.json');await git('-c','user.name=Polariton verifier','-c','user.email=verifier@polariton.invalid','commit','-m','Controlled defective candidate');const bad=await git('rev-parse','HEAD');await assert.rejects(admin({kind:'release.install',operationId:`defective-${attempt}`,packageId:pkgid,commit:bad}));report.interventions.push({kind:'controlled-defective-candidate',commit:bad});await git('restore','--source',r2.commit,'--','polariton-capability.json');
  await rack.call('/v1/shutdown',{});await new Promise(resolve=>daemon.once('exit',resolve));const restarted=spawn(process.execPath,[join(root,'src/environment/daemon.ts'),rackPath],{cwd:root,stdio:['ignore','pipe','pipe']});children.push(restarted);restarted.stdout.on('data',chunk=>log+=chunk);restarted.stderr.on('data',chunk=>log+=chunk);const restartDeadline=Date.now()+config.startupTimeoutMs;while(true){try{await rack.call('/v1/health');break;}catch(error){if(Date.now()>restartDeadline)throw error;await new Promise(resolve=>setTimeout(resolve,config.interruptPollMs));}}
  await admin({kind:'environment.apply',operationId:`reproduce-${attempt}`,environmentId:envid,revisionId:e1id});const observed=await admin({kind:'observe',mountId:mount,uri:'stats://capability'});assert(observed.available);assert.equal(JSON.parse(observed.value.contents[0].text).version,1);assert.deepEqual(await rack.call(`/v1/revisions/${envid}/${e1id}`),e1);check('controlled-failure-restart-reproduction');
  await writeFile(join(run,'daemon.log'),log);await writeFile(join(run,'inventory.json'),scrub(await rack.call('/v1/inventory')));await writeFile(join(run,'source-diff.patch'),(await exec('git',['-C',workspace,'diff',r1.commit,r2.commit])).stdout);report.passed=true;
}catch(error){report.passed=false;report.checks.push({name:'campaign',status:'fail',error:String(error)});console.error(error);process.exitCode=1;}
finally{
  clearTimeout(timer);await Promise.allSettled(harnesses.map(h=>h.close()));try{await rack.call('/v1/shutdown',{});}catch{}for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');report.budget=ledger.close();report.expired=expired;await writeFile(join(run,'report.json'),scrub(report));await writeFile(join(evidence,`live-attempt-${attempt}.json`),scrub(report));console.log(scrub(report));
}
