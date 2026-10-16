import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadConfig,sourceRoot,CampaignConfig} from '../src/config.ts';
import {AgentManager} from '../src/agents.ts';
import {ResearchTree} from '../src/research.ts';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {VerificationBudget} from '../harness/budget.mjs';
import {serveHttp} from '../tests/fixtures/adr011/server.mjs';

/** A real Main-managed prompt proves healthy MCP execution despite both preparation
 * and discovery failures. Every attempt is retained; spending uses the existing ledger. */
if(!process.argv.includes('--live'))throw new Error('Use --live with an approved remaining ADR-011 package campaign allowance');
if(!process.env.DEEPSEEK_API_KEY)throw new Error('Configured provider credential is unavailable');
const root=sourceRoot,attempt=randomUUID(),run=join(root,'.local/adr011-resilience',attempt),evidence=join(root,'docs/evidence/adr011-resilience');
await mkdir(run,{recursive:true});await mkdir(evidence,{recursive:true});
const limits=CampaignConfig.parse({id:'adr011-packages',ledger:join(root,'.local/adr011-packages/verification-budget.sqlite'),maxRequests:12,maxLiveMs:720000,maxOutputTokens:8192,reserveRequests:4,reserveMs:240000});
const config={...await loadConfig(),stateRoot:join(run,'app'),verification:true,maxOutputTokens:limits.maxOutputTokens};
const report={attempt,started:new Date().toISOString(),passed:false,source:{},checks:[],requests:0,budget:null,cleanup:false};
const check=name=>report.checks.push({name,status:'pass'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['src/agents.ts','src/config.ts','src/environment/rack.ts','src/environment/contracts.ts','harness/client.ts','harness/bridge.mjs','harness/mcp.mjs','scripts/verify-mcp-resilience-live.mjs'])report.source[file]=hash(await readFile(join(root,file)));
for(const file of await readdir(join(root,'dist/web/assets')))report.source[`dist/web/assets/${file}`]=hash(await readFile(join(root,'dist/web/assets',file)));
const receipts=[],sentinel='adr011-resilience-private-sentinel';
let rack,tree,agents,ledger,timer;
const service=await serveHttp({record:value=>receipts.push(value)}),denied=await serveHttp({token:sentinel});
const scrub=value=>{const text=JSON.stringify(value,null,2);for(const secret of [sentinel,process.env.DEEPSEEK_API_KEY])assert(!text.includes(secret),'Secret cannot be exported');return text.replaceAll(root,'<V5>/');};
try{
  const prerequisite=join(run,'application-present');await writeFile(prerequisite,'fixture');
  rack=await new EnvironmentRack(RackConfig.parse({stateRoot:join(run,'rack'),socketPath:join(run,'rack.sock'),monitorMs:3600000}),()=>new Proxy({},{get(){return async()=>{throw new Error('External-only fixture cannot use Docker');};}})).open();
  const preview=await rack.preview({configuration:{mcpServers:{healthy:{url:service.url},denied:{url:denied.url},absent:{url:service.url,requirements:{files:[prerequisite]}}}}});assert.deepEqual(preview.errors,[]);
  const imported=await rack.execute({kind:'capability.import',operationId:'import',entries:preview.entries});
  const revision=await rack.execute({kind:'environment.publish',operationId:'publish',expectedBase:null,document:{format:2,environmentId:'resilient',name:'Resilient tools',description:'Controlled fixture',components:imported.capabilities.map(value=>({id:value.name,name:value.name,definition:{capabilityId:value.id,revisionId:value.revisionId}}))}});
  assert.equal((await rack.execute({kind:'environment.apply',operationId:'apply',environmentId:revision.environmentId,revisionId:revision.revisionId})).status,'ready');
  await rm(prerequisite);assert.equal((await rack.choices()).length,1);check('applied-head-remains-selectable-after-prerequisite-failure');
  await mkdir(config.stateRoot,{recursive:true});
  tree=new ResearchTree(config);await tree.initialize();const project=await tree.createProject(randomUUID(),'MCP failure isolation'),node=await tree.ensureMain(project.id);
  agents=new AgentManager(config,tree,async()=>{if(!ledger){ledger=new VerificationBudget(limits.ledger,limits);timer=setTimeout(()=>void agents.close(),ledger.remainingMs);}const allowed=report.requests<2&&ledger.reserve();if(allowed)report.requests++;return allowed;},undefined,{environment:{choices:()=>rack.choices(),acquire:input=>rack.acquireAccess(input),release:input=>rack.releaseAccess(input)}});
  await agents.initialize();const worker=agents.create(project.id,node,randomUUID(),'Healthy tools remain usable'),selection={environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name};
  await agents.selectEnvironment(project.id,node,worker.id,selection);
  const submission=randomUUID(),view=()=>agents.list(project.id,node).find(value=>value.id===worker.id);
  const completed=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{agents.off('change',changed);reject(new Error('Verification prompt timed out'));},config.requestTimeoutMs);
    function changed(){const receipt=view().submissions.find(value=>value.id===submission);if(receipt&&(['failed','uncertain','interrupted'].includes(receipt.state)||(receipt.state==='applied'&&view().state==='idle'))){clearTimeout(timeout);agents.off('change',changed);resolve(receipt);}}
    agents.on('change',changed);
  });
  await agents.submit(project.id,node,worker.id,{id:submission,text:'Use only the healthy MCP transform tool, exactly once, with value 6 and label resilience-proof. Briefly report its value and exact receipt. Do not use any other tool or subagent. The unavailable environment tools are unnecessary for this task.'});
  assert.equal((await completed).state,'applied');assert.equal(view().state,'idle');
  assert.deepEqual(view().mcp.map(value=>[value.componentId,value.status]).sort(),[['absent','unavailable'],['denied','unavailable'],['healthy','connected']]);
  check('main-admits-prompt-with-preparation-and-discovery-failures');
  const receipt=receipts.find(value=>value.phase==='invoked'&&value.input.label==='resilience-proof');assert(receipt);assert.equal(receipt.output.value,43);
  const history=await agents.history(project.id,node,worker.id);assert(JSON.stringify(history.events).includes(receipt.output.receipt));
  assert(history.events.some(value=>value.type==='tool/call'));check('real-provider-healthy-tool-receipt-matches-dsh-history');
  const tools=history.events.filter(value=>value.type==='request/header').flatMap(value=>value.data.header.tools??[]).map(tool=>tool.name);
  assert(tools.includes('mcp__healthy__transform'));assert(!tools.some(name=>/^mcp__(absent|denied)__/.test(name)));
  assert(JSON.stringify(history.events).includes('MCP_STARTUP_FAILED'));assert(JSON.stringify(history.events).includes('CONNECTION_UNAVAILABLE'));
  check('dsh-prompt-exposes-failure-summary-and-only-authorized-healthy-tools');
  await writeFile(join(run,'history.json'),scrub(history));await writeFile(join(run,'worker.json'),scrub(view()));
  await agents.closeWorker(project.id,node,worker.id);assert.equal(view().cleanupPending,false);check('main-settles-guardian-and-releases-access');
  await agents.resume(project.id,node,worker.id);assert.equal(view().harnessSessionId,worker.harnessSessionId??history.sourceSessionId);assert(view().mcp.some(value=>value.status==='connected'));check('same-session-resume-retains-partial-availability-without-provider-spending');
  await agents.closeWorker(project.id,node,worker.id);report.passed=true;report.availability=view().mcp;report.receipts=receipts.filter(value=>value.phase==='invoked');
}catch(error){report.checks.push({name:'campaign',status:'fail',code:error?.code??error?.name??'ERROR'});process.exitCode=1;}
finally{
  clearTimeout(timer);
  try{if(agents)await agents.close();if(tree)await tree.close();if(rack)await rack.close();await service.close();await denied.close();report.cleanup=true;}catch{report.passed=false;process.exitCode=1;}
  if(ledger)report.budget=ledger.close();report.finished=new Date().toISOString();
  await writeFile(join(run,'report.json'),scrub(report));await writeFile(join(evidence,`${attempt}.json`),scrub(report));
  console.log(JSON.stringify({attempt,passed:report.passed,requests:report.requests,budget:report.budget,checks:report.checks,cleanup:report.cleanup}));
}
