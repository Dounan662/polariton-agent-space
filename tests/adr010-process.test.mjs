import {testDeadline} from './fixtures/timing.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once,EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Harness} from '../harness/client.ts';
import {loadConfig} from '../src/config.ts';
import {AgentManager} from '../src/agents.ts';
import {ResearchTree} from '../src/research.ts';
import {readHistory} from '../harness/history.mjs';

const helper=fileURLToPath(new URL('./fixtures/adr010-supervisor.mjs',import.meta.url));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function supervisor(t,mode,onMessage=()=>{}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-process-')));
  const config={...await loadConfig(),stateRoot:root,verification:true,startupTimeoutMs:testDeadline(15000),requestTimeoutMs:testDeadline(15000),shutdownTimeoutMs:testDeadline(5000)};
  const child=spawn(process.execPath,[helper,mode,root],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{POLARITON_TEST_PROFILE:process.env.POLARITON_TEST_PROFILE,PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DSH_TELEMETRY_DISABLED:'1'},
    stdio:['ignore','pipe','pipe','ipc'],
  });
  const messages=[];let output='',dshPid,guardianPid;
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(-config.maxFrameBytes);});
  child.stderr.on('data',chunk=>{output=(output+chunk).slice(-config.maxFrameBytes);});
  const ready=new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(new Error(`Supervisor readiness timed out: ${output}`)),config.startupTimeoutMs);
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(deadline);reject(new Error(`Supervisor exited before readiness (${code??signal}): ${output}`));});
    child.on('message',value=>{
      messages.push(value);onMessage(value,child);
      if(value.kind==='failure'){clearTimeout(deadline);reject(new Error(value.message));}
      if(value.kind==='ready'){clearTimeout(deadline);dshPid=value.dshPid;guardianPid=value.guardianPid;resolve(value);}
    });
  });
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
    if(dshPid&&alive(dshPid))process.kill(dshPid,'SIGKILL');
    if(guardianPid&&alive(guardianPid))process.kill(guardianPid,'SIGKILL');
    await rm(root,{recursive:true,force:true});
  });
  return {root,config,child,messages,ready,async crash(){const exited=once(child,'exit');child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');}};
}

test('Main SIGKILL preserves native settlement before DSH stdin closes without a model prompt',{timeout:testDeadline(60000)},async t=>{
  const f=await supervisor(t,'dsh'),ready=await f.ready;
  assert(ready.dshPid!==f.child.pid&&alive(ready.dshPid));assert.equal(ready.attemptedRequests,0);
  const began=Date.now();await f.crash();
  const deadline=began+f.config.shutdownTimeoutMs;
  while(alive(ready.dshPid)&&Date.now()<deadline)await delay(f.config.interruptPollMs);
  assert.equal(alive(ready.dshPid),false,'Pinned DSH survived its supervisor: EOF did not terminate the owned process');
  await Harness.recover(ready.guardian,f.config);
  assert.equal(f.messages.filter(value=>value.kind==='provider-attempt').length,0);
  const history=await readHistory(join(f.root,'harness','sessions'),ready.sessionId,{limit:f.config.maxHistoryEvents});
  assert(!history.events.some(event=>['request/header','tool/call'].includes(event.type)),'An empty session unexpectedly executed');
  t.diagnostic(JSON.stringify({qualification:'supervisor-eof-native-settlement',dsh:JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).dependencies['@deepseek-ai/dsh'],sessionId:ready.sessionId,exitMs:Date.now()-began,providerRequests:0}));
});

test('abrupt Main activation crash releases only its journaled grants and never replays before explicit retry',{timeout:testDeadline(30000)},async t=>{
  const grants=new Map([['unrelated',{owner:'another-main',principal:'another-worker'}]]),acquired=[],released=[];
  const f=await supervisor(t,'activation',(message,child)=>{
    if(message.kind==='acquire'){
      acquired.push(message.input);grants.set(message.input.id,message.input);
      child.send({kind:'grant-response',id:message.input.id,grant:{id:message.input.id,servers:[],components:[]}});
    }
  });
  const ready=await f.ready;assert.equal(acquired.length,1);assert.equal(grants.size,2);assert.equal(ready.attemptedRequests,0);
  await f.crash();
  const tree=new ResearchTree(f.config);await tree.initialize();
  let starts=0,prompts=0,providerAttempts=0;
  const environment={
    async choices(){throw new Error('Recovery must use the recorded selection');},
    async acquire(input){acquired.push(input);grants.set(input.id,input);return {id:input.id,servers:[],components:[]};},
    async release(input){assert.equal(grants.get(input.id)?.owner,input.owner);released.push(input);grants.delete(input.id);},
  };
  class RecoveredHarness extends EventEmitter {
    async start(){starts++;return {image:false};}
    async locate(){return null;}
    async activate(){return {sessionId:'recovered-session',options:[{id:'model',name:'Model',currentValue:JSON.stringify([f.config.provider,f.config.model]),options:[{name:f.config.model,value:JSON.stringify([f.config.provider,f.config.model])}]}],mcp:[]};}
    async message(sessionId,requestId,content){prompts++;this.emit('source',{sessionId,seq:0,type:'user/message',event:{type:'user/message',seq:0,time:1000,data:{source:{kind:'user',rpcId:requestId},content}}});this.emit('submission',{sessionId,requestId,state:'applied'});return {messageId:requestId};}
    async activity(){return {revision:0,eligible:false,blockers:[{kind:'unknown'}]};}
    async closeSession(){}
    async close(){this.emit('exit');}
  }
  const agents=new AgentManager(f.config,tree,async()=>{providerAttempts++;return false;},()=>new RecoveredHarness(),{environment,catalog:{async choices(){throw new Error('Recovery must not start catalog execution');}}});
  try{
    await agents.initialize();
    const view=()=>agents.list(ready.project,ready.node).find(value=>value.id===ready.workerId);
    assert.equal(starts,0);assert.equal(prompts,0);assert.equal(providerAttempts,0);
    assert.deepEqual([...grants.keys()],['unrelated']);assert.deepEqual(released,[{id:acquired[0].id,owner:acquired[0].owner}]);
    assert.equal(view().cleanupPending,false);assert.equal(view().harnessSessionId,null);assert.equal(view().environment.locked,false);
    assert.equal(view().submissions.length,1);assert.equal(view().submissions[0].id,ready.submissionId);assert.equal(view().submissions[0].state,'failed');assert.equal(view().submissions[0].retryable,true);
    const settled=new Promise(resolve=>{const changed=()=>{if(['applied','failed','uncertain'].includes(view().submissions[0].state)){agents.off('change',changed);resolve();}};agents.on('change',changed);});
    agents.retry(ready.project,ready.node,ready.workerId,ready.submissionId);await settled;
    assert.equal(view().submissions[0].state,'applied');
    assert.equal(starts,1);assert.equal(prompts,1);assert.equal(view().submissions.length,1);assert.equal(providerAttempts,0);
    assert.equal(acquired[1].owner,acquired[0].owner);assert.notEqual(acquired[1].id,acquired[0].id);
    assert.deepEqual(acquired[1].environment,acquired[0].environment);
    t.diagnostic(JSON.stringify({qualification:'activation-crash-recovery',workerId:ready.workerId,submissionId:ready.submissionId,cleanupCount:released.length,automaticPrompts:0,explicitRetryPrompts:prompts,providerRequests:0}));
  }finally{await agents.close();await tree.close();}
});
