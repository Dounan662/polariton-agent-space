import {testDeadline} from './fixtures/timing.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Harness} from '../harness/client.ts';
import {nativeTurn} from '../scripts/native-turn.mjs';
import {loadConfig} from '../src/config.ts';
import {readHistory} from '../harness/history.mjs';
import {serveHttp} from './fixtures/adr011/server.mjs';

const script=fileURLToPath(new URL('./fixtures/adr011/server.mjs',import.meta.url));
async function fixture(t,overrides={},budget){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-dsh-mcp-'))),workspace=join(root,'workspace'),home=join(root,'harness'),receipts=join(root,'receipts.jsonl');
  await mkdir(workspace);const httpReceipts=[],sentinel='adr011-resolved-secret-sentinel';const http=await serveHttp({token:sentinel,record:entry=>httpReceipts.push(entry)});
  const config={...await loadConfig(),verification:true,startupTimeoutMs:testDeadline(20000),requestTimeoutMs:testDeadline(15000),shutdownTimeoutMs:testDeadline(5000),...overrides};
  let attempted=0;const harness=new Harness(config,home,workspace,async()=>{attempted++;return budget?budget():false;});
  t.after(async()=>{await harness.close();await http.close();await rm(root,{recursive:true,force:true});});
  await harness.start();
  const servers=[{name:'remote',type:'http',url:http.url,headers:[{name:'Authorization',value:`Bearer ${sentinel}`}]},{name:'local',command:await realpath(process.execPath),args:[script],env:[{name:'ADR011_RECEIPTS',value:receipts}]}];
  return {root,workspace,home,receipts,httpReceipts,http,config,harness,servers,sentinel,get attempted(){return attempted;}};
}

test('controlled HTTP and stdio fixtures issue independently verifiable invocation receipts',{timeout:testDeadline(30000)},async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-fixture-mcp-')),receipts=join(root,'receipts.jsonl'),records=[];
  const http=await serveHttp({record:entry=>records.push(entry),token:'synthetic-fixture-token'});
  t.after(async()=>{await http.close();await rm(root,{recursive:true,force:true});});
  for(const transport of [new StreamableHTTPClientTransport(new URL(http.url),{requestInit:{headers:{Authorization:'Bearer synthetic-fixture-token'}}}),new StdioClientTransport({command:process.execPath,args:[script],env:{ADR011_RECEIPTS:receipts}})]){
    const client=new Client({name:'adr011-receipt-check',version:'1'});await client.connect(transport);
    try{const result=await client.callTool({name:'transform',arguments:{value:6,label:'receipt-check'}});const output=JSON.parse(result.content[0].text);assert.equal(output.value,43);assert.equal(output.label,'receipt-check');assert.match(output.receipt,/^[\da-f-]+$/);}finally{await client.close();}
  }
  assert(records.some(value=>value.phase==='invoked'&&value.output.value===43));
  assert((await readFile(receipts,'utf8')).includes('"value":43'));
});

test('real DSH discovers complete HTTP and stdio input on new and retained resume without provider admission',{timeout:testDeadline(90000)},async t=>{
  const f=await fixture(t),opened=await f.harness.activate(null,f.servers);
  assert.equal(typeof opened.sessionId,'string');
  await f.harness.observe(opened.sessionId);
  assert(f.httpReceipts.some(value=>value.method==='tools/list'||value.method==='server/discover'));
  const receipts=(await readFile(f.receipts,'utf8')).trim().split('\n').map(JSON.parse);
  assert(receipts.some(value=>value.phase==='launched'&&value.cwd===f.workspace));
  assert(receipts.some(value=>value.method==='tools/list'||value.method==='server/discover'));
  await f.harness.closeSession(opened.sessionId);
  async function scan(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await scan(file);else if(entry.isFile())assert(!(await readFile(file)).includes(Buffer.from(f.sentinel)),`Resolved credential persisted in ${entry.name}`);}}
  await scan(f.home);
  await f.harness.activate(opened.sessionId,f.servers);
  await f.harness.observe(opened.sessionId);
  assert.equal(f.attempted,0);
  const history=await readHistory(join(f.home,'sessions'),opened.sessionId,{limit:f.config.maxHistoryEvents});
  assert(!history.events.some(event=>['request/header','tool/call'].includes(event.type)));
  await f.harness.closeSession(opened.sessionId);
  t.diagnostic(JSON.stringify({gate:'mixed-discovery-new-resume',sessionId:opened.sessionId,providerRequests:0,httpDiscoveryRequests:f.httpReceipts.length,stdioLaunches:(await readFile(f.receipts,'utf8')).split('\n').filter(line=>line.includes('"phase":"launched"')).length}));
});

test('real DSH isolates a failed server on new and resume while preserving healthy discovery',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),bad={name:'missing',command:join(f.root,'missing-executable'),args:[],env:[]};
  const servers=[f.servers[0],bad],unavailable=[{serverName:'not_prepared',status:'unavailable',code:'EXECUTABLE_DRIFT'}],opened=await f.harness.activate(null,servers,unavailable);
  const expected=[{serverName:'remote',status:'connected',code:null},{serverName:'missing',status:'unavailable',code:'MCP_STARTUP_FAILED'}];
  assert.deepEqual(opened.mcp,expected);assert.equal(f.attempted,0);
  assert(f.httpReceipts.some(value=>value.method==='tools/list'||value.method==='server/discover'));
  await nativeTurn(f.harness,opened.sessionId,'Inspect available tools.',f.config.requestTimeoutMs);
  const events=(await f.harness.observe(opened.sessionId)).events;
  assert(JSON.stringify(events).includes('EXECUTABLE_DRIFT'));
  assert(JSON.stringify(events).includes('MCP_STARTUP_FAILED'));
  await f.harness.observe(opened.sessionId);
  await f.harness.closeSession(opened.sessionId);
  const resumed=await f.harness.activate(opened.sessionId,servers);
  assert.deepEqual(resumed.mcp,expected);assert.equal(f.attempted,1);
  await f.harness.closeSession(opened.sessionId);
});

test('real DSH keeps a base worker when every MCP server fails',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),opened=await f.harness.activate(null,[{name:'missing',command:join(f.root,'missing-executable'),args:[],env:[]}]);
  assert.deepEqual(opened.mcp,[{serverName:'missing',status:'unavailable',code:'MCP_STARTUP_FAILED'}]);
  assert.equal((await f.harness.activity(opened.sessionId)).blockers.some(blocker=>blocker.kind==='running'),false);
  assert.equal(f.attempted,0);
  const ended=await nativeTurn(f.harness,opened.sessionId,'Continue with the base tools.',f.config.requestTimeoutMs);
  assert.equal(ended.reason.kind,'error');assert.equal(ended.reason.error.code,'POLARITON_REQUEST_BUDGET_EXHAUSTED');
  assert.equal(f.attempted,1,'Base worker reaches model admission despite all optional MCP failures; fixture denies provider spending');
  await f.harness.observe(opened.sessionId);
  const history=await readHistory(join(f.home,'sessions'),opened.sessionId,{limit:f.config.maxHistoryEvents});
  assert(JSON.stringify(history.events).includes('MCP_STARTUP_FAILED'),'DSH persists the bounded model-facing availability summary');
  await f.harness.closeSession(opened.sessionId);
});

test('real DSH rejects normalized namespace collisions before contacting either endpoint',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),name='dotted.name',normalized=`dotted_name_${createHash('sha256').update(name).digest('hex').slice(0,8)}`;
  await assert.rejects(f.harness.activate(null,[{...f.servers[0],name},{...f.servers[0],name:normalized}]));
  assert.equal(f.httpReceipts.length,0);assert.equal(f.attempted,0);
});

test('expired HTTP credentials yield sanitized per-server failure without removing healthy tools',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),records=[],service=await serveHttp({token:'current-sentinel',record:value=>records.push(value)});
  t.after(()=>service.close());const expired='expired-secret-sentinel';
  const opened=await f.harness.activate(null,[f.servers[1],{name:'private',type:'http',url:service.url,headers:[{name:'Authorization',value:`Bearer ${expired}`}]}]);
  assert.deepEqual(opened.mcp,[{serverName:'local',status:'connected',code:null},{serverName:'private',status:'unavailable',code:'MCP_STARTUP_FAILED'}]);
  assert(!JSON.stringify(opened).includes(expired));assert(records.some(value=>value.phase==='denied'));assert.equal(f.attempted,0);
  assert(!JSON.stringify(records).includes(expired));assert.equal(f.harness.stderr,undefined,'Raw untrusted stderr must not be retained');
  await f.harness.closeSession(opened.sessionId);
});

test('hanging MCP initialization times out independently and late replies cannot add tools',{timeout:testDeadline(60000)},async t=>{
  // Leave enough startup time for the healthy real Node process under concurrent
  // integration load; the delayed peer still exceeds that same configured bound.
  const f=await fixture(t,{mcpStartupTimeoutMs:testDeadline(2000),mcpCleanupTimeoutMs:testDeadline(5000)});
  const lateDelayMs=f.config.mcpStartupTimeoutMs*2,service=await serveHttp({beforeRequest:()=>delay(lateDelayMs)});t.after(()=>service.close());
  const opened=await f.harness.activate(null,[f.servers[1],{name:'late',type:'http',url:service.url,headers:[]},{name:'hang',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:[]}]);
  assert.deepEqual(opened.mcp,[{serverName:'local',status:'connected',code:null},{serverName:'late',status:'unavailable',code:'MCP_STARTUP_TIMEOUT'},{serverName:'hang',status:'unavailable',code:'MCP_STARTUP_TIMEOUT'}]);
  await delay(lateDelayMs);
  assert.equal((await nativeTurn(f.harness,opened.sessionId,'Use available tools only.',f.config.requestTimeoutMs)).reason.error.code,'POLARITON_REQUEST_BUDGET_EXHAUSTED');
  assert.equal(f.attempted,1);await f.harness.observe(opened.sessionId);
  const history=await readHistory(join(f.home,'sessions'),opened.sessionId,{limit:f.config.maxHistoryEvents});
  const names=history.events.filter(event=>event.type==='request/header').flatMap(event=>event.data.header.tools??[]).map(tool=>tool.name);
  assert(names.includes('mcp__local__transform'),'Healthy tools remain in the actual DSH request');
  assert(!names.some(name=>/^mcp__(late|hang)__/.test(name)),'Late and timed-out tools never enter the actual DSH request');
  await f.harness.closeSession(opened.sessionId);
});

test('closing during delayed real discovery settles pending requests and does not admit a prompt',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t);let reached,release;
  const entered=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const service=await serveHttp({beforeRequest:async()=>{reached();await gate;}});t.after(()=>service.close());
  const pending=f.harness.activate(null,[{name:'delayed',type:'http',url:service.url,headers:[]}]);
  const rejected=assert.rejects(pending);await entered;
  const closed=f.harness.close();release();await Promise.all([closed,rejected]);assert.equal(f.attempted,0);
});

test('late discovery replies cannot turn a timed-out activation into a provider request',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),service=await serveHttp({beforeRequest:()=>delay(200)});t.after(()=>service.close());
  f.config.requestTimeoutMs=50;
  await assert.rejects(f.harness.activate(null,[{name:'late',type:'http',url:service.url,headers:[]}]),/Timed out/);
  await delay(1000);assert.equal(f.attempted,0);await f.harness.close();
});

test('SDK missing resource diagnostics cannot corrupt real DSH ACP stdout',{timeout:testDeadline(30000)},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-stdout-'))),receipt=join(root,'diagnostics.json'),home=join(root,'home');await mkdir(home);
  const source=fileURLToPath(new URL('../',import.meta.url));
  const child=spawn(process.execPath,['--import',join(source,'harness/console.mjs'),'--import',join(source,'tests/fixtures/adr011/diagnostics.mjs'),join(source,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','acp'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DSH_HOME:home,DSH_TELEMETRY_MODE:'DISABLED',ADR011_DIAGNOSTIC_RECEIPT:receipt},stdio:['pipe','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await rm(root,{recursive:true,force:true});});
  child.stderr.resume();let buffered='';const frames=[];
  const initialized=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',()=>reject(new Error('DSH exited before ACP initialization')));
    child.stdout.on('data',chunk=>{buffered+=chunk.toString();for(let end;(end=buffered.indexOf('\n'))>=0;){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);let frame;try{frame=JSON.parse(line);}catch{return reject(new Error('Non-protocol stdout reached the ACP parser'));}frames.push(frame);if(frame.id==='initialize'){if(frame.error)reject(new Error('ACP initialization failed'));else resolve(frame.result);}}});
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:'initialize',method:'initialize',params:{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'adr011-diagnostics',version:'1'}}})+'\n');
  const result=await initialized;assert.equal(result.protocolVersion,1);
  assert.deepEqual(JSON.parse(await readFile(receipt,'utf8')),{resources:{resources:[]},templates:{resourceTemplates:[]}});
  assert(frames.every(frame=>frame.jsonrpc==='2.0'));child.stdin.end();await once(child,'exit');
});


test('production worker receives launch identity/shared operations and discovers the specialized skill outside its workspace',{timeout:testDeadline(60000)},async t=>{
  const workerIdentity={projectId:randomUUID(),nodeId:randomUUID(),workerId:randomUUID()};
  const privateToken='synthetic-skill-credential-must-not-reach-model';
  const f=await fixture(t,{verification:false,workerIdentity,workerCredential:{token:privateToken,socket:'/unused',config:'/unused'}}),opened=await f.harness.activate(null,[]);
  assert.equal((await nativeTurn(f.harness,opened.sessionId,'Explain the available Polariton tool-authoring skill.',f.config.requestTimeoutMs)).reason.error.code,'POLARITON_REQUEST_BUDGET_EXHAUSTED');
  assert.equal(f.attempted,1,'Fixture denies real provider spending after assembling the production skill catalog');
  await f.harness.observe(opened.sessionId);
  const history=await readHistory(join(f.home,'sessions'),opened.sessionId,{limit:f.config.maxHistoryEvents});
  assert(JSON.stringify(history.events).includes('make-polariton-tool'),'The real DSH production prompt advertises the installed skill');
  const prompt=JSON.stringify(history.events);
  assert(!prompt.includes('operate-labra'),'No application-owned operating skill remains');
  assert(prompt.includes('harnessctl worker overview'),'Shared operations are present without loading a skill');
  assert(prompt.includes('You are a Polariton worker'));
  assert(!prompt.includes('You are an AI agent powered by DeepSeek Harness.'));
  assert(!prompt.includes('DeepSeek Harness Web GUI'));
  for(const id of Object.values(workerIdentity))assert(prompt.includes(id),'Stable placement reaches the actual DSH model input');
  assert(!prompt.includes(privateToken),'Credentials must remain outside model-visible context');
  const skill=fileURLToPath(new URL('../skills/make-polariton-tool/SKILL.md',import.meta.url)),body=await readFile(skill,'utf8');
  assert(body.includes('references/mcp.md'));assert(body.includes('references/environment.md'));assert(body.includes('references/managed.md'));
  for(const name of ['mcp.md','environment.md','managed.md'])assert((await readFile(fileURLToPath(new URL(`../skills/make-polariton-tool/references/${name}`,import.meta.url)),'utf8')).length>0);
  await f.harness.closeSession(opened.sessionId);
});

test('real harness translates identified admission, application, discarded guidance and terminal turns',{timeout:testDeadline(60000)},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await fixture(t,{},async()=>{entered.resolve();return release.promise;});
 t.after(()=>release.resolve(false));
 const {sessionId}=await f.harness.activate(null,[]),turns=[],submissions=[];
 f.harness.on('turn',value=>turns.push(value));f.harness.on('submission',value=>submissions.push(value));
 const first=randomUUID(),second=randomUUID();
 const admitted=await f.harness.message(sessionId,first,[{type:'text',text:'Controlled denied turn'}],{kind:'worker',workerId:randomUUID()});
 assert.equal(typeof admitted.messageId,'string');await entered.promise;
 await f.harness.message(sessionId,second,[{type:'text',text:'Pending guidance to discard'}],{kind:'worker',workerId:randomUUID()});
 const interrupted=f.harness.interrupt(sessionId);release.resolve(false);await interrupted;
 const source=await f.harness.observe(sessionId);
 assert(turns.some(value=>value.phase==='claimed'&&value.requestId===first));
 assert(submissions.some(value=>value.requestId===first&&value.state==='applied'));
 assert(submissions.some(value=>value.requestId===second&&value.state==='interrupted'));
 assert(!submissions.some(value=>value.requestId===second&&value.state==='applied'));
 const claimed=turns.find(value=>value.phase==='claimed'&&value.requestId===first);
 assert(turns.some(value=>value.phase==='ended'&&value.id===claimed.id));
 assert.equal(source.events.filter(event=>event.type==='user/message'&&event.data.source.rpcId===first).length,1);
 assert.equal(source.events.filter(event=>event.type==='user/message'&&event.data.source.rpcId===second).length,0);
 assert.equal(f.attempted,1,'Only a denied admission; no model provider request');
});

test('retained due reminders wait for model and MCP activation, and model discovery cannot wake them',{timeout:testDeadline(60000)},async t=>{
  const f=await fixture(t),opened=await f.harness.activate(null,[]);
  await f.harness.close();
  // Seed through the upstream storage domain and record constructor, not Polariton's
  // own persistence writer. The original session exists but no runtime is active.
  const [{Context},{default:Storage},Json,Domain,{scheduleDomain,createAfterScheduleRecord,ScheduleId}]=await Promise.all([
    import('@deepseek-ai/cordis'),import('@deepseek-ai/dsh-storage'),import('@deepseek-ai/dsh-storage-json'),import('@deepseek-ai/dsh-storage-domain'),import('@deepseek-ai/dsh-schedule'),
  ]);
  const storage=new Context();
  try{
    await storage.plugin(Storage,{});await storage.plugin(Json,{root:join(f.home,'storages')});await storage.plugin(Domain,{backend:'json'});
    const domain=await storage.storageDomain.open(scheduleDomain),record=createAfterScheduleRecord(ScheduleId('retained-reminder'),'Inspect the available tools now.',1,0,'Retained reminder');
    await domain.table('tasks').put(record.id,{sessionId:opened.sessionId,record,status:'active'});await domain.close();
  }finally{await storage.fiber.dispose();}
  let admission=0,discoveryAtAdmission=false;const ended=Promise.withResolvers();
  const resumed=new Harness(f.config,f.home,f.workspace,async()=>{admission++;discoveryAtAdmission=f.httpReceipts.some(value=>value.method==='tools/list'||value.method==='server/discover');return false;});
  resumed.on('turn',event=>{if(event.phase==='ended')ended.resolve(event);});
  try{
    await resumed.start();await resumed.models();
    assert.equal(admission,0,'Session-free discovery must leave due reminders dormant');
    const ready=await resumed.activate(opened.sessionId,[f.servers[0]],[{serverName:'not_prepared',status:'unavailable',code:'EXECUTABLE_DRIFT'}]);
    const deadline=Promise.withResolvers(),timer=setTimeout(()=>deadline.reject(new Error('Reminder did not reach bounded admission')),f.config.requestTimeoutMs);
    let turn;try{turn=await Promise.race([ended.promise,deadline.promise]);}finally{clearTimeout(timer);}
    assert.equal(ready.sessionId,opened.sessionId);assert.equal(turn.reason.kind,'error');
    assert.equal(admission,1);assert.equal(discoveryAtAdmission,true);
    const events=(await resumed.observe(opened.sessionId)).events;
    assert(JSON.stringify(events).includes('EXECUTABLE_DRIFT'),'Availability is configured before reminder request context');
    assert(events.some(event=>event.type==='user/message'),'Reminder retains native source trajectory');
  }finally{await resumed.close();}
});
