import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {defineTool} from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Jobs from '@deepseek-ai/dsh-jobs-local';
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs';
import * as Guidance from '../harness/job-guidance.mjs';
import {JobObservationSettings} from '../harness/settings.ts';
import {createScope} from '@deepseek-ai/dsh-scope';

/** Real pinned DSH tool/job contracts, with controlled agent input and job producers. */
async function fixture(t) {
  const ctx = new Context(), owners = [], jobs = [];
  for (const plugin of [SystemPrompt, Tools, Agents, Jobs, ToolJobs, Guidance]) await ctx.plugin(plugin, {});
  t.after(async () => {
    for (const job of jobs) job.finish({status:'completed',result:'teardown'});
    await nextTurn();
    for (const owner of owners) { await owner.scope.dispose(); await owner.leave(); }
    await ctx.fiber.dispose();
  });
  let sequence = 0;
  const owner = async () => {
    const id = `worker-${++sequence}`, inbox = {nextStep:[]}, notices = [];
    const agent = {id,ctx,status:'running',inbox,session:{id,header:{}},inject:message=>notices.push(message)};
    const scope = createScope(ctx, agent);agent.ctx=scope.ctx;
    const leave = ctx.agents.enter(agent);
    await ctx.agents.announce(agent,'startup');
    const value = {agent,leave,scope,notices,guidance(kind='user') {
      const message = {id:`message-${++sequence}`,source:{kind},content:[{type:'text',text:'New direction'}]};
      inbox.nextStep.push(message);
      ctx.emit('session/event', agent.session, {type:'agent/inbox/spliced',data:{target:'next-step',inserted:[message]}});
    }};
    owners.push(value);
    return value;
  };
  const job = (owner, stream=false) => {
    const done = Promise.withResolvers();
    let cancels = 0;
    const id = ctx.jobs.start({kind:'bash',label:'Controlled work',owner:owner.agent.id,run:handle=>{
      if(stream)handle.append('retained partial output');
      return {done:done.promise,cancel(){cancels++;done.resolve({status:'killed'});}};
    }});
    const value = {id,finish:done.resolve,get cancels(){return cancels;}};
    jobs.push(value);
    return value;
  };
  const read = (owner,job,args={},signal=new AbortController().signal) => ctx.tools.execute({
    callId:`call-${++sequence}`,name:'job_output',arguments:{job_id:job.id,...args},agent:owner.agent,signal,
  });
  return {ctx,owner,job,read};
}

test('guidance yields a blocking observation and returns its partial stream once without stopping the job', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner,true);
  const waiting=f.read(owner,job,{wait:true});
  await nextTurn();
  owner.guidance('polariton-worker');
  const result=await waiting;
  assert.equal(result.isError,false);
  assert.equal(result.value.text,'retained partial output');
  assert.equal(f.ctx.jobs.get(job.id,owner.agent.id).status,'running');
  assert.equal(job.cancels,0);
  owner.agent.inbox.nextStep.length=0;
  assert.equal((await f.read(owner,job)).value.text,'');
  job.finish({status:'completed',detail:'exit code: 0'});
  await nextTurn();
  assert.equal(owner.notices.length,1,'An abandoned observation must not suppress the eventual completion notice');
  assert.equal((await f.read(owner,job)).value.job.status,'completed');
});

test('queued guidance yields before a new wait; ordinary output reads still collect completed results', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner);
  owner.guidance();
  const result=await f.read(owner,job,{wait:true});
  assert.equal(result.isError,false);assert.equal(result.value.job.status,'running');assert.equal(job.cancels,0);
  job.finish({status:'completed',result:'complete result'});await nextTurn();
  assert.equal((await f.read(owner,job)).value.text,'complete result');
});

test('guidance is scoped to the receiving worker and plugin notices do not interrupt job observation', {timeout:5000}, async t => {
  const f=await fixture(t), first=await f.owner(), second=await f.owner(), job=f.job(first);
  let settled=false;const waiting=f.read(first,job,{wait:true}).then(result=>{settled=true;return result;});
  await nextTurn();second.guidance();first.guidance('plugin');await nextTurn();
  assert.equal(settled,false);
  job.finish({status:'completed',result:'normal completion'});
  const result=await waiting;
  assert.equal(result.isError,false);assert.equal(result.value.text,'normal completion');
});

test('caller cancellation keeps its native outcome even when guidance arrives in the same turn', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner), caller=new AbortController();
  const waiting=f.read(owner,job,{wait:true},caller.signal);await nextTurn();
  owner.guidance();caller.abort(new Error('User interrupted'));
  const result=await waiting;
  assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/New guidance is queued/);
  assert.equal(job.cancels,0);assert.equal(f.ctx.jobs.get(job.id,owner.agent.id).status,'running');
});

test('completion racing guidance preserves any successful result and its output', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner,true);
  const waiting=f.read(owner,job,{wait:true});await nextTurn();
  job.finish({status:'completed',result:'winning result'});
  await Promise.resolve();owner.guidance();
  const result=await waiting;
  assert.equal(result.isError,false);assert.equal(result.value.text,'retained partial output\nwinning result');assert.equal(job.cancels,0);
  assert.equal((await f.read(owner,job)).value.text,'');
});

test('normal wait timeout preserves DSH running status and does not cancel work', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner);
  t.mock.timers.enable({apis:['setTimeout']});
  const waiting=f.read(owner,job,{wait:true,timeout_ms:100});await nextTurn();
  t.mock.timers.tick(100);
  const result=await waiting;
  assert.equal(result.isError,false);assert.equal(result.value.job.status,'running');assert.equal(job.cancels,0);
  t.mock.timers.reset();
});

test('guidance never hides native validation failures or interrupts unrelated tool execution', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner();owner.guidance();
  const invalid=await f.read(owner,{id:'missing-job'},{wait:true});
  assert.equal(invalid.isError,true);
  assert.match(invalid.error.message,/unknown job|not found|does not exist/i);
  const done=Promise.withResolvers();
  f.ctx.tools.register(defineTool({name:'controlled',description:'Controlled unrelated tool',parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:()=>done.promise}));
  let settled=false;
  const call=f.ctx.tools.execute({callId:'unrelated',name:'controlled',arguments:{},agent:owner.agent,signal:new AbortController().signal}).then(result=>{settled=true;return result;});
  await nextTurn();owner.guidance();await nextTurn();assert.equal(settled,false);
  done.resolve('unrelated result');assert.equal((await call).value,'unrelated result');
});

test('disposing one agent removes its policy and leaves other agents responsive', {timeout:5000}, async t => {
  const f=await fixture(t), first=await f.owner(), second=await f.owner();
  const base=f.ctx.tools.get('job_output');
  assert.notEqual(f.ctx.tools.get('job_output',first.agent),base);
  await first.scope.dispose();await first.leave();
  assert.equal(f.ctx.tools.get('job_output',first.agent),base);
  const job=f.job(second), waiting=f.read(second,job,{wait:true});await nextTurn();
  second.guidance();assert.equal((await waiting).isError,false);assert.equal(job.cancels,0);
});

test('failed jobs settle as native job results, including a concurrent guidance arrival', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), job=f.job(owner);
  const waiting=f.read(owner,job,{wait:true});await nextTurn();
  job.finish({status:'failed',result:'scientific command failed',detail:'exit code: 1'});
  await Promise.resolve();owner.guidance();
  const result=await waiting;
  assert.equal(result.isError,false);assert.equal(result.value.job.status,'failed');
  assert.equal(result.value.text,'scientific command failed');
});

test('queued guidance cannot suppress invalid timeouts or authorize another worker\'s job', {timeout:5000}, async t => {
  const f=await fixture(t), owner=await f.owner(), other=await f.owner(), job=f.job(owner,true);
  owner.guidance();other.guidance();
  assert.equal((await f.read(owner,job,{wait:true,timeout_ms:-1})).isError,true);
  assert.equal((await f.read(other,job,{wait:true})).isError,true);
  assert.equal(f.ctx.jobs.readAt(job.id,0,owner.agent.id).chunks.map(chunk=>chunk.text).join(''),'retained partial output');assert.equal(job.cancels,0);
});

test('observation configuration retains DSH defaults and rejects inconsistent deadlines', () => {
  assert.deepEqual(JobObservationSettings.parse({}),{waitTimeoutMs:30000,maxWaitTimeoutMs:600000});
  assert.throws(()=>JobObservationSettings.parse({waitTimeoutMs:101,maxWaitTimeoutMs:100}));
  assert.throws(()=>JobObservationSettings.parse({waitTimeoutMs:0}));
});
