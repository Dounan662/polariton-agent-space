import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import * as McpClient from '../harness/native/mcp-client.mjs';
import {credentialProvider} from '../harness/mcp-credentials.ts';
import {validateMcp,recoverMcpValidation} from '../harness/mcp-validation.ts';
import {serveHttp} from './fixtures/adr011/server.mjs';
import {testDeadline} from './fixtures/timing.ts';

const serverScript=fileURLToPath(new URL('./fixtures/adr011/server.mjs',import.meta.url));
const limits={startupMs:testDeadline(4000),callMs:testDeadline(1000),cleanupMs:testDeadline(8000),maxTools:20,maxChecks:5,maxOutputBytes:65536};
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'pmcp-'))),cwd=join(root,'workspace'),receipts=join(root,'receipts.jsonl');
  await mkdir(cwd);t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,cwd,receipts,server:{name:'local',command:process.execPath,args:[serverScript],env:[{name:'ADR011_RECEIPTS',value:receipts}]}};
}
const processExists=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};

test('invalid validation authority has no process, credential or durable ownership effects',async t=>{
  const f=await fixture(t),check={name:'read',serverName:'local',toolName:'transform',arguments:{}};
  for(const input of [
    {cwd:f.cwd,servers:[f.server,f.server]},
    {cwd:f.cwd,servers:[f.server],checks:[{...check,serverName:'unknown'}]},
    {cwd:f.cwd,servers:[f.server],checks:[check,check]},
    {cwd:f.cwd,servers:[f.server],checks:Array.from({length:limits.maxChecks+1},(_,index)=>({...check,name:String(index)}))},
    {cwd:f.cwd,servers:[{name:'http',type:'http' as const,url:'http://127.0.0.1:1/mcp',headers:[{name:'Authorization',value:'one'},{name:'authorization',value:'two'}]}]},
  ])await assert.rejects(validateMcp(input,limits));
  assert.deepEqual(await readdir(f.cwd),[],'Rejected input never creates a guardian identity');
  await assert.rejects(readFile(f.receipts),{code:'ENOENT'});
});

test('inference-free validation discovers production stdio tools without invoking them and proves child settlement',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),result=await validateMcp({cwd:f.cwd,servers:[f.server]},limits);
  assert.deepEqual(result.servers,[{serverName:'local',connection:'connected',discovery:'passed',tools:['mcp__local__transform'],code:null}]);
  assert.deepEqual(result.checks,[]);assert.equal(result.cleanup.status,'settled');
  const receipts=(await readFile(f.receipts,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert(!receipts.some(receipt=>receipt.phase==='invoked'));
  assert(receipts.some(receipt=>receipt.method==='server/discover'),'Ordinary session launches retain modern auto negotiation');
  const pids=new Set<number>(receipts.map(receipt=>receipt.pid));assert(pids.size>0);
  assert([...pids].every(pid=>!processExists(pid)),'Every SDK negotiation/production child is gone before settlement');
  await recoverMcpValidation(f.cwd,limits);
  assert.equal(await readFile(f.receipts,'utf8'),receipts.map(receipt=>JSON.stringify(receipt)).join('\n')+'\n','Recovery checks settlement without replaying discovery or calls');
});

test('an explicitly legacy single-session stream initializes once without a disposable discovery probe',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),server={...f.server,protocol:'legacy' as const,env:[...f.server.env,{name:'ADR011_REQUIRE_INITIALIZE',value:'1'}]};
  const result=await validateMcp({cwd:f.cwd,servers:[server],checks:[{name:'legacy-call',serverName:'local',toolName:'transform',arguments:{value:6,label:'legacy'}}]},limits);
  assert.equal(result.servers[0].discovery,'passed');assert.equal(result.checks[0].status,'passed');assert.equal(result.cleanup.status,'settled');
  const receipts=(await readFile(f.receipts,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(new Set(receipts.map(receipt=>receipt.pid)).size,1);assert.equal(receipts.filter(receipt=>receipt.method==='initialize').length,1);assert(!receipts.some(receipt=>receipt.method==='server/discover'));
});

test('validator owner death drains its guardian-owned host and recovery never repeats application effects',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),entry=fileURLToPath(new URL('../harness/mcp-validation.ts',import.meta.url));
  const hanging=`require('node:fs').appendFileSync(process.env.ADR011_RECEIPTS,JSON.stringify({pid:process.pid,phase:'launched'})+'\\n');process.stdin.resume();setInterval(()=>{},1000);`;
  const script=`import {validateMcp} from ${JSON.stringify(entry)};await validateMcp(${JSON.stringify({cwd:f.cwd,servers:[{...f.server,args:['-e',hanging]}]})},${JSON.stringify(limits)});`;
  const owner=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});t.after(()=>{if(owner.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');});
  const end=Date.now()+limits.startupMs;let receipts:Array<{pid:number;phase:string}>=[];
  while(!receipts.length){
    try{receipts=(await readFile(f.receipts,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    assert(Date.now()<end,'Owned MCP process must start before the observation deadline');if(!receipts.length)await new Promise(resolve=>setTimeout(resolve,20));
  }
  owner.kill('SIGKILL');await new Promise<void>(resolve=>owner.once('exit',()=>resolve()));
  await recoverMcpValidation(f.cwd,limits);
  assert(receipts.every(receipt=>!processExists(receipt.pid)),'Recovery settles the live owned MCP child after caller death');
  assert(!(await readFile(f.receipts,'utf8')).includes('"phase":"invoked"'));
});

test('discovery success stays distinct from explicit application failure and output receipts disclose no application text',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),records:Array<Record<string,unknown>>=[],service=await serveHttp({record:(entry:Record<string,unknown>)=>{records.push(entry);}});t.after(()=>service.close());
  const result=await validateMcp({cwd:f.cwd,servers:[{name:'http',type:'http',url:service.url,headers:[]}],checks:[
    {name:'correct',serverName:'http',toolName:'transform',arguments:{value:6,label:'private-output-sentinel'}},
    {name:'invalid-input',serverName:'http',toolName:'transform',arguments:{value:'invalid',label:'expected-rejection'}},
  ]},limits);
  assert.equal(result.servers[0].discovery,'passed');assert.equal(result.checks[0].status,'passed');assert.match(result.checks[0].outputDigest!,/^[a-f\d]{64}$/);
  assert.equal(result.checks[1].status,'failed');assert.equal(result.checks[1].code,'MCP_CALL_FAILED');assert.equal(result.cleanup.status,'settled');
  assert(!JSON.stringify(result).includes('private-output-sentinel'));assert.equal(records.filter(record=>record.phase==='invoked').length,1);
});

test('unavailable components do not suppress healthy discovery and abort settles hanging stdio',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),controller=new AbortController();
  const result=await validateMcp({cwd:f.cwd,servers:[f.server,{name:'missing',command:join(f.root,'missing'),args:[],env:[]}]},limits);
  assert.equal(result.servers[0].discovery,'passed');assert.equal(result.servers[1].code,'MCP_STARTUP_FAILED');assert.equal(result.cleanup.status,'settled');
  const cancelTimer=setTimeout(()=>controller.abort(),testDeadline(200));
  try {
    const cancelled=await validateMcp({cwd:f.cwd,servers:[{name:'hang',command:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)'],env:[]}]},limits,controller.signal);
    assert.equal(cancelled.servers[0].code,'MCP_CANCELLED');assert.equal(cancelled.cleanup.status,'settled');
  } finally {clearTimeout(cancelTimer);}
});

test('live credentials refresh per request, disconnect denies future use, and a remote 401 never replays a call',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t),socketPath=join(f.root,'credentials.sock'),handle={socketPath,accessId:'access-1',serverName:'remote',token:'synthetic-handle-token'};
  let issued='first-private-token',expected=issued,connected=true,reads=0;
  const authority=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    assert.equal(req.url,'/v1/access/credential');assert.equal(req.headers.authorization,`Bearer ${handle.token}`);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()),{accessId:handle.accessId,serverName:handle.serverName});reads++;
    res.writeHead(connected?200:403,{'content-type':'application/json'}).end(JSON.stringify(connected?{accessToken:issued}:{code:'ACCOUNT_DISCONNECTED'}));
  });
  await new Promise<void>((resolve,reject)=>{authority.once('error',reject);authority.listen(socketPath,resolve);});
  t.after(()=>new Promise<void>(resolve=>authority.close(()=>resolve())));
  const records:Array<Record<string,unknown>>=[],service=await serveHttp({token:()=>expected,record:(entry:Record<string,unknown>)=>{records.push(entry);}});t.after(()=>service.close());
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);
  const fiber=ctx.plugin(McpClient,{transport:'streamable-http',serverName:'remote',url:service.url,headers:{},cleanupTimeoutMs:limits.cleanupMs,toolCallTimeoutMs:limits.callMs,failOnStartupError:true,reconnect:{enabled:false},credentialProvider:credentialProvider(handle,{timeoutMs:limits.callMs,maxBytes:limits.maxOutputBytes})});
  await fiber;assert.equal(ctx.get('agents'),undefined);assert.equal(ctx.get('llm'),undefined);
  const call=(name:string)=>ctx.tools.execute({callId:ToolCallId(name),name:'mcp__remote__transform',arguments:{value:6,label:name},signal:new AbortController().signal});
  const connectedReads=reads;assert.equal((await call('before-refresh')).isError,false);
  issued=expected='second-private-token';assert.equal((await call('after-refresh')).isError,false);assert(reads>=connectedReads+2);
  expected='unexpected-remote-token';const denied=records.filter(record=>record.phase==='denied').length;
  assert.equal((await call('unauthorized')).isError,true);assert.equal(records.filter(record=>record.phase==='denied').length,denied+1,'No automatic retry after a remote 401');
  connected=false;const priorRequests=records.length;assert.equal((await call('after-disconnect')).isError,true);assert.equal(records.length,priorRequests,'Revocation is checked before transport effects');
  assert.equal(records.filter(record=>record.phase==='invoked').length,2);
  await McpClient.drainMcp(ctx);await fiber.dispose();
});

test('HTTP redirects cannot transfer credentials or replay a possibly executed tool request',{timeout:testDeadline(20000)},async t=>{
  const service=await serveHttp();t.after(()=>service.close());
  let redirect=false,invocations=0,escaped=0;
  const endpoint=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();
    if(req.url==='/other-resource'){escaped++;res.writeHead(500).end();return;}
    if(body&&JSON.parse(body).method==='tools/call'){
      invocations++;
      if(redirect){res.writeHead(307,{location:'/other-resource'}).end();return;}
    }
    const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
    const response=await fetch(service.url,{method:req.method,headers,...body?{body}:{}});
    res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body)res.write(chunk);res.end();
  });
  await new Promise<void>((resolve,reject)=>{endpoint.once('error',reject);endpoint.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise<void>(resolve=>endpoint.close(()=>resolve())));
  const address=endpoint.address();assert(address&&typeof address!=='string');
  const authentications:Array<{headers:Record<string,string>;credentialProvider?:McpClient.CredentialProvider}>=[
    {headers:{Authorization:'Bearer private-static'}},
    {headers:{},credentialProvider:{token:async()=> 'private-scoped'}},
  ];
  for(const authentication of authentications){
    const ctx=new Context();t.after(()=>ctx.fiber.dispose());await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);
    const fiber=ctx.plugin(McpClient,{transport:'streamable-http',serverName:'selected',url:`http://127.0.0.1:${address.port}/mcp`,...authentication,cleanupTimeoutMs:limits.cleanupMs,toolCallTimeoutMs:limits.callMs,failOnStartupError:true,reconnect:{enabled:false}});
    await fiber;
    const call=()=>ctx.tools.execute({callId:ToolCallId('selected-call'),name:'mcp__selected__transform',arguments:{value:6,label:'selected'},signal:new AbortController().signal});
    redirect=false;assert.equal((await call()).isError,false);
    redirect=true;const before=invocations;assert.equal((await call()).isError,true);
    assert.equal(invocations,before+1,'The selected endpoint receives exactly one application request');
    assert.equal(escaped,0,'Redirects cannot transfer credentials or application requests to another resource');
    await McpClient.drainMcp(ctx);await fiber.dispose();
  }
});
