import {nativeTurn} from './native-turn.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,readdir,realpath,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {create as tar} from 'tar';
import {EnvironmentRack} from '../src/environment/rack.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {loadConfig,CampaignConfig} from '../src/config.ts';
import {Harness} from '../harness/client.ts';
import {VerificationBudget} from '../harness/budget.mjs';
import {readHistory} from '../harness/history.mjs';

/** Controlled package registry and application-independent MCP receipts exercise the real
 * package manager, daemon access boundary and DSH; only --live admits provider requests. */
const root=fileURLToPath(new URL('../',import.meta.url)),base=join(root,'.local/adr011-packages'),evidence=join(root,'docs/evidence/adr011-packages');
const live=process.argv.includes('--live'),repair=process.argv.includes('--repair');
if(live&&!process.env.DEEPSEEK_API_KEY?.trim())throw new Error('Configured DeepSeek credential is unavailable');
await mkdir(base,{recursive:true});await mkdir(evidence,{recursive:true});
const attempts=new DatabaseSync(join(base,'attempts.sqlite'));attempts.exec('CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY,started TEXT NOT NULL,live INTEGER NOT NULL,repair INTEGER NOT NULL)');
if(live&&!repair&&attempts.prepare('SELECT COUNT(*) n FROM attempts WHERE live=1').get().n)throw new Error('A retained live attempt exists; use --repair within the same ledger');
attempts.prepare('INSERT INTO attempts(started,live,repair) VALUES(?,?,?)').run(new Date().toISOString(),Number(live),Number(repair));const attempt=Number(attempts.prepare('SELECT MAX(id) id FROM attempts').get().id);attempts.close();
const run=join(base,`attempt-${attempt}`);await mkdir(run);const workspaces=[join(run,'node-a'),join(run,'node-b')];await Promise.all(workspaces.map(async(path,index)=>{await mkdir(path);await writeFile(join(path,'marker.txt'),index?'node-b':'node-a');}));
const limits=CampaignConfig.parse({id:'adr011-packages',ledger:join(base,'verification-budget.sqlite'),maxRequests:12,maxLiveMs:720000,maxOutputTokens:8192,reserveRequests:4,reserveMs:240000});
const config={...await loadConfig(),verification:true,maxOutputTokens:limits.maxOutputTokens,requestTimeoutMs:120000};
const report={attempt,live,repair,started:new Date().toISOString(),provider:config.provider,model:config.model,checks:[],sessions:[],requests:0,budget:null,passed:false,source:{},cleanup:[]};
const check=(name,details={})=>report.checks.push({name,status:'pass',...details});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sentinel='adr011-package-synthetic-private-value';
const scrub=value=>{const text=JSON.stringify(value,null,2);assert(!text.includes(sentinel),'Synthetic credential leaked into evidence');assert(!process.env.DEEPSEEK_API_KEY||!text.includes(process.env.DEEPSEEK_API_KEY),'Provider credential leaked into evidence');return text.replaceAll(root,'<V5>/');};
for(const file of ['src/environment/contracts.ts','src/environment/connections.ts','src/environment/packages.ts','src/environment/rack.ts','src/agents.ts','harness/client.ts','harness/guardian.mjs','scripts/verify-package-preparation-live.mjs'])try{report.source[file]=hash(await readFile(join(root,file)));}catch{report.source[file]='missing';}
try{for(const file of await readdir(join(root,'dist/web/assets')))report.source[`dist/web/assets/${file}`]=hash(await readFile(join(root,'dist/web/assets',file)));}catch{}
const credentialFile=join(run,'credentials.json');await writeFile(credentialFile,JSON.stringify({format:1,credentials:{FIXTURE_KEY:{account:'fixture',authority:'local',value:sentinel}}}),{mode:0o600});
const receipts=join(run,'receipts.jsonl'),fixtureName='polariton-adr011-fixture';
const archives=new Map();let registryRequests=0,registryEnabled=true,registry;
if(!process.env.POLARITON_VERIFY_UV||!process.env.POLARITON_VERIFY_PYTHON)throw new Error('Set POLARITON_VERIFY_UV and POLARITON_VERIFY_PYTHON to explicit installed tools');
const uv=await realpath(process.env.POLARITON_VERIFY_UV),python=await realpath(process.env.POLARITON_VERIFY_PYTHON);
const wheelName='polariton_adr011_python-1.0.0-py3-none-any.whl',wheelPath=join(run,wheelName);
const pythonServer=`import json,os,sys,uuid
VERSION=3
def main():
 def record(value):
  with open(os.environ['RECEIPTS'],'a') as stream: stream.write(json.dumps(dict(pid=os.getpid(),version=VERSION,**value))+'\\n')
 record(dict(phase='launched',cwd=os.getcwd(),runtime=os.environ.get('SCRATCH')))
 for line in sys.stdin:
  message=json.loads(line);record(dict(phase='request',method=message.get('method')))
  if 'id' not in message: continue
  method=message.get('method');result={}
  if method=='initialize': result=dict(protocolVersion=message['params']['protocolVersion'],capabilities=dict(tools={}),serverInfo=dict(name='python-package-fixture',version='1'))
  elif method=='tools/list': result=dict(tools=[dict(name='inspect_workspace',description='Read worker marker',inputSchema=dict(type='object',properties=dict(label=dict(type='string')),required=['label']))])
  elif method=='tools/call':
   output=dict(marker=open('marker.txt').read(),version=VERSION,pid=os.getpid(),label=message['params']['arguments']['label'],receipt=str(uuid.uuid4()));record(dict(phase='invoked',output=output));result=dict(content=[dict(type='text',text=json.dumps(output))])
  elif method=='resources/list': result=dict(resources=[])
  elif method=='resources/templates/list': result=dict(resourceTemplates=[])
  elif method=='prompts/list': result=dict(prompts=[])
  print(json.dumps(dict(jsonrpc='2.0',id=message['id'],result=result)),flush=True)
`;
await promisify(execFile)(python,['-c',`import sys,zipfile,hashlib,base64,csv,io,json
p='polariton_adr011_python-1.0.0.dist-info/'
files={'polariton_adr011_python.py':sys.argv[2],p+'METADATA':'Metadata-Version: 2.1\\nName: polariton-adr011-python\\nVersion: 1.0.0\\n',p+'WHEEL':'Wheel-Version: 1.0\\nGenerator: polariton-verifier\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',p+'entry_points.txt':'[console_scripts]\\npolariton-adr011-python = polariton_adr011_python:main\\n'}
record=io.StringIO();writer=csv.writer(record)
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for name,text in files.items():
  data=text.encode();archive.writestr(name,data);writer.writerow([name,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='),len(data)])
 writer.writerow([p+'RECORD','','']);archive.writestr(p+'RECORD',record.getvalue())
`,wheelPath,pythonServer]);
const wheelBytes=await readFile(wheelPath);
const fixtureSource=version=>`#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const version=${version};
const record=value=>appendFileSync(process.env.RECEIPTS,JSON.stringify({pid:process.pid,version,...value})+'\\n');
record({phase:'launched',cwd:process.cwd(),runtime:process.env.SCRATCH});
for await(const line of createInterface({input:process.stdin})){let message;try{message=JSON.parse(line);}catch{continue;}record({phase:'request',method:message.method});if(message.id===undefined)continue;let result={};
if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'package-fixture',version:String(version)}};
else if(message.method==='tools/list')result={tools:[{name:'inspect_workspace',description:'Read this worker workspace marker and return its independent receipt. Use when asked to inspect the workspace.',inputSchema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false}}]};
else if(message.method==='tools/call'){const output={marker:readFileSync('marker.txt','utf8'),version,pid:process.pid,label:message.params.arguments.label,receipt:randomUUID()};record({phase:'invoked',output});result={content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}
else if(message.method==='resources/list')result={resources:[]};else if(message.method==='resources/templates/list')result={resourceTemplates:[]};else if(message.method==='prompts/list')result={prompts:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');}
`;
for(const version of [1,2]){const dir=join(run,`source-${version}`),pkg=join(dir,'package');await mkdir(pkg,{recursive:true});await writeFile(join(pkg,'package.json'),JSON.stringify({name:fixtureName,version:`${version}.0.0`,type:'module',bin:{[fixtureName]:'server.mjs'}}));await writeFile(join(pkg,'server.mjs'),fixtureSource(version),{mode:0o755});const path=join(dir,'package.tgz');await tar({gzip:true,cwd:dir,file:path},['package']);archives.set(`${version}.0.0`,await readFile(path));}
registry=createServer((req,res)=>{registryRequests++;if(!registryEnabled){res.writeHead(503).end();return;}const url=new URL(req.url,'http://fixture');if(url.pathname==='/simple/polariton-adr011-python/'){res.setHeader('content-type','text/html');res.end(`<a href="/${wheelName}#sha256=${hash(wheelBytes)}">${wheelName}</a>`);return;}if(url.pathname===`/${wheelName}`){res.end(wheelBytes);return;}if(url.pathname===`/${fixtureName}`){const versions=Object.fromEntries([...archives].map(([version,bytes])=>[version,{name:fixtureName,version,bin:{[fixtureName]:'server.mjs'},dist:{tarball:`${registryURL}/${fixtureName}/-/${version}.tgz`,integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`}}]));res.setHeader('content-type','application/json');res.end(JSON.stringify({name:fixtureName,'dist-tags':{latest:'2.0.0'},versions}));}else{const version=url.pathname.split('/').at(-1)?.replace('.tgz','');const archive=archives.get(version);if(archive)res.end(archive);else res.writeHead(404).end();}});
await new Promise(resolve=>registry.listen(0,'127.0.0.1',resolve));const registryURL=`http://127.0.0.1:${registry.address().port}`;
let rack,ledger,timer;const harnesses=[],accesses=[];
const records=async()=>{try{return (await readFile(receipts,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const ensureBudget=()=>{if(!ledger){ledger=new VerificationBudget(limits.ledger,repair?{...limits,reserveRequests:0,reserveMs:0}:limits);timer=setTimeout(()=>{for(const h of harnesses)void h.close();},ledger.remainingMs);}return ledger;};
async function grant(revision,id,workspace,requireHead=true){const request={id,owner:'verification',principal:id,workspace,environment:{environmentId:revision.environmentId,revisionId:revision.revisionId,name:revision.name},requireHead};const result=await rack.acquireAccess(request);accesses.push(id);return result;}
async function open(revision,id,workspace){const access=await grant(revision,id,workspace),home=join(run,`dsh-${id}`),h=new Harness(config,home,workspace,async()=>{if(!live)return false;const allowed=ensureBudget().reserve();if(allowed)report.requests++;return allowed;});harnesses.push(h);await h.start();const session=await h.activate(null,access.servers);report.sessions.push({id,sessionId:session.sessionId,home,workspace});return {h,access,id:session.sessionId,workspace};}
async function turn(worker,label){const result=await nativeTurn(worker.h,worker.id,`Call the environment MCP inspect_workspace tool exactly once with label "${label}". Use its returned result to report the marker, version and receipt briefly. Do not use shell, file tools, other tools or subagents.`,config.requestTimeoutMs);assert.equal(result.reason.kind,'completed');await worker.h.observe(worker.id);const history=await readHistory(join(worker.h.home,'sessions'),worker.id,{limit:config.maxHistoryEvents});await writeFile(join(run,`${label}-history.json`),scrub(history));assert(history.events.some(event=>event.type==='tool/call'&&JSON.stringify(event).includes('inspect_workspace')));const receipt=(await records()).find(value=>value.phase==='invoked'&&value.output.label===label);assert(receipt,'Independent fixture must record the requested MCP execution');assert(JSON.stringify(history).includes(receipt.output.receipt),'DSH logical history must retain the independent tool receipt');return receipt;}
async function preview(version,capabilityId){const configuration={mcpServers:{shared:{command:'npx',args:['-y',`${fixtureName}@${version}.0.0`],env:{RECEIPTS:receipts,SCRATCH:'${POLARITON_RUNTIME}',API_TOKEN:'${FIXTURE_KEY}'}}}};const initial=await rack.preview({configuration,resolutions:{},...(capabilityId?{capabilityId}:{})});const result=await rack.preview({configuration,resolutions:initial.resolutions,...(capabilityId?{capabilityId}:{})});assert.deepEqual(result.errors,[]);return result.entries[0];}
async function publish(definition,id,baseRevision=null){return rack.execute({kind:'environment.publish',operationId:id,expectedBase:baseRevision,document:{format:2,environmentId:'shared',name:'Shared package',description:'Controlled verification',components:[{id:'fixture',name:'Fixture',definition:{capabilityId:definition.id,revisionId:definition.revisionId}}]}});}
async function apply(revision){const result=await rack.execute({kind:'environment.apply',operationId:`apply-${revision.revisionId}`,environmentId:revision.environmentId,revisionId:revision.revisionId});assert.equal(result.status,'ready',JSON.stringify(result));return result;}
try{
  const executable=await realpath(process.execPath),npm=join(dirname(executable),'npm');
  const rackConfig=RackConfig.parse({stateRoot:join(run,'rack'),credentialFile,socketPath:join(run,'rack.sock'),packageTools:{node:executable,npm,uv,python},packageRegistry:registryURL,packageIndexUrl:registryURL+'/simple',executablePaths:[dirname(executable),dirname(process.env.POLARITON_VERIFY_UV)],monitorMs:3600000});
  rack=await new EnvironmentRack(rackConfig,()=>new Proxy({},{get(){return async()=>{throw new Error('External-only package preparation must not use Docker');};}})).open();
  const entry=await preview(1),imported=await rack.execute({kind:'capability.import',operationId:'import',entries:[entry]}),definition=imported.capabilities[0],r1=await publish(definition,'r1');
  assert.equal(registryRequests,0);assert.equal((await records()).length,0);check('preview-import-publication-have-no-launch-or-network-effects');
  await apply(r1);assert(registryRequests>0);assert.equal((await records()).length,0);const preparedRequests=registryRequests;registryEnabled=false;check('apply-installs-real-npm-package-without-launching-server',{registryRequests});
  const a=await open(r1,'worker-a',workspaces[0]),b=await open(r1,'worker-b',workspaces[1]);
  assert.deepEqual(a.access.servers[0].command,b.access.servers[0].command);assert.equal(registryRequests,preparedRequests);
  const launched=(await records()).filter(value=>value.phase==='launched');assert(launched.some(value=>value.cwd===workspaces[0]));assert(launched.some(value=>value.cwd===workspaces[1]));const launchA=launched.find(value=>value.cwd===workspaces[0]),launchB=launched.find(value=>value.cwd===workspaces[1]);assert.notEqual(launchA.pid,launchB.pid);assert.notEqual(launchA.runtime,launchB.runtime);check('two-workers-share-installation-but-own-processes-workspaces-runtime');
  if(live){ensureBudget();const ra=await turn(a,'worker-a-initial'),rb=await turn(b,'worker-b-initial');assert.equal(ra.output.marker,'node-a');assert.equal(rb.output.marker,'node-b');assert.equal(ra.output.version,1);assert.equal(rb.output.version,1);check('real-provider-independent-workspace-receipts');}
  await a.h.closeSession(a.id);await a.h.close();await rack.releaseAccess({id:a.access.id,owner:'verification'});assert.equal(b.h.settled,false);check('closing-one-worker-leaves-other-worker-owned-process-active');
  registryEnabled=true;const next=await preview(2,definition.id),second=await rack.execute({kind:'capability.revise',operationId:'revise',id:definition.id,expectedBase:definition.revisionId,entry:next}),r2=await publish(second,'r2',r1.revisionId);await apply(r2);const afterUpdate=registryRequests;registryEnabled=false;
  const current=await open(r2,'worker-c',workspaces[0]);assert.notDeepEqual(current.access.servers[0].args,a.access.servers[0].args);check('new-revision-retains-separate-prepared-installation');
  await b.h.closeSession(b.id);await b.h.close();await rack.releaseAccess({id:b.access.id,owner:'verification'});const retained=await grant(r1,'worker-b-resume',workspaces[1],false);assert.equal(retained.servers[0].command,b.access.servers[0].command);b.h=new Harness(config,b.h.home,b.workspace,async()=>{if(!live)return false;const allowed=ensureBudget().reserve();if(allowed)report.requests++;return allowed;});harnesses.push(b.h);await b.h.start();await b.h.activate(b.id,retained.servers);
  if(live){const rr=await turn(b,'worker-b-retained');assert.equal(rr.output.version,1);assert.equal(rr.output.marker,'node-b');check('real-provider-retained-revision-resume-receipt');}
  assert.equal(registryRequests,afterUpdate);check('activation-and-retained-resume-do-not-contact-package-registry');
  registryEnabled=true;const uvConfiguration={mcpServers:{python:{command:'uvx',args:['polariton-adr011-python==1.0.0'],env:{RECEIPTS:receipts,SCRATCH:'${POLARITON_RUNTIME}',API_TOKEN:'${FIXTURE_KEY}'}}}};const uvFirst=await rack.preview({configuration:uvConfiguration,resolutions:{}}),uvPreview=await rack.preview({configuration:uvConfiguration,resolutions:uvFirst.resolutions});assert.deepEqual(uvPreview.errors,[]);const uvImported=await rack.execute({kind:'capability.import',operationId:'import-uv',entries:uvPreview.entries}),uvRevision=await publish(uvImported.capabilities[0],'r3',r2.revisionId);await apply(uvRevision);const uvPrepared=registryRequests;registryEnabled=false;const pythonWorker=await open(uvRevision,'worker-python',workspaces[0]);assert.equal(registryRequests,uvPrepared);assert((await records()).some(value=>value.phase==='launched'&&value.version===3));check('real-uv-wheel-preparation-and-dsh-discovery-without-runtime-registry');
  await writeFile(join(run,'inventory.json'),scrub(await rack.inventory()));
  async function scan(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.isFile()){const bytes=await readFile(path);assert(!bytes.includes(Buffer.from(sentinel)),'Synthetic credential leaked into durable state');if(process.env.DEEPSEEK_API_KEY)assert(!bytes.includes(Buffer.from(process.env.DEEPSEEK_API_KEY)),'Provider credential leaked into durable state');}}}
  await scan(join(run,'rack'));for(const home of new Set(harnesses.map(h=>h.home)))await scan(home);check('synthetic-and-provider-secrets-absent-from-state-inventory-history-receipts');report.passed=true;
}catch(error){report.checks.push({name:'campaign',status:'fail',error:error instanceof Error?`${error.name}: ${error.message}`:'Unknown failure'});process.exitCode=1;}
finally{
  clearTimeout(timer);for(const h of harnesses){try{await h.close();report.cleanup.push({kind:'guardian',settled:h.settled});}catch{report.cleanup.push({kind:'guardian',settled:false});report.passed=false;process.exitCode=1;}}
  for(const id of accesses)try{if(harnesses.some(h=>!h.settled)){report.cleanup.push({kind:'access',id,released:false,reason:'Guardian settlement unconfirmed; reservation retained'});continue;}await rack.releaseAccess({id,owner:'verification'});report.cleanup.push({kind:'access',id,released:true});}catch{report.cleanup.push({kind:'access',id,released:false});report.passed=false;process.exitCode=1;}
  if(rack)await rack.close();await new Promise(resolve=>registry.close(resolve));if(ledger)report.budget=ledger.close();report.finished=new Date().toISOString();report.registryRequests=registryRequests;report.receipts=await records();
  await writeFile(join(run,'report.json'),scrub(report));await writeFile(join(evidence,`attempt-${attempt}.json`),scrub(report));console.log(scrub(report));
}
