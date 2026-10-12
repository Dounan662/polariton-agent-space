import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm,{LlmAdapter} from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {NativeMessages} from '../harness/messages.mjs';
import {readHistory} from '../harness/history.mjs';
import {submissionContent} from '../src/contracts.ts';

const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC'};
const fault=code=>error=>error.code===code;

/** Pinned DSH runs the full loop with a controlled adapter and real attachment storage. */
async function fixture(t,{images=true,holdImages=false}={}) {
  const home=await mkdtemp(join(tmpdir(),'polariton-native-messages-')),ctx=new Context();
  const model=Promise.withResolvers(),entered=Promise.withResolvers(),imageWrite=Promise.withResolvers(),imageEntered=Promise.withResolvers();
  const requests=[],events=[],discarded=[];
  class Attachments extends LocalAttachments {
    async saveImages(inputs){imageEntered.resolve();if(holdImages)await imageWrite.promise;return super.saveImages(inputs);}
  }
  for(const plugin of [SystemPrompt,Tools,Agents,Sessions,Projections,Llm,AgentLoop])await ctx.plugin(plugin,{});
  await ctx.plugin(Attachments,{dshHome:home});
  class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,inputModalities:images?['text','image']:['text']};}
    async *stream(request){
      requests.push(request);entered.resolve();
      let release;
      try{
        await new Promise(resolve=>{
          release=()=>resolve();request.signal.addEventListener('abort',release,{once:true});
          if(request.signal.aborted)resolve();else void model.promise.then(resolve);
        });
        request.signal.throwIfAborted();
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:'Completed'};
        yield {type:'block-end',index:0,block:{type:'text',text:'Completed'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }finally{request.signal.removeEventListener('abort',release);}
    }
  }
  ctx.llm.registerAdapter(['controlled'],new Adapter());
  ctx.on('session/event',(_session,event)=>events.push(event));
  ctx.on('agent/inbox/discarded',({message})=>discarded.push(message.source.rpcId));
  const messages=new NativeMessages(ctx),agent=await ctx.agentLoop.create('native-session',{provider:'controlled',model:'local'});
  t.after(async()=>{model.resolve();imageWrite.resolve();agent.cancel({kind:'user'});await agent.whenIdle();await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});});
  const send=(id,content=[{type:'text',text:id}],origin={kind:'human'})=>messages.message({sessionId:agent.id,requestId:id,content,origin});
  return {home,ctx,agent,messages,send,requests,events,discarded,entered:entered.promise,release:model.resolve,imageEntered:imageEntered.promise,releaseImage:imageWrite.resolve,
    committed:()=>agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&['user','polariton-worker'].includes(event.data.source.kind)).map(event=>event.data)};
}

test('idle native input retains direct receipt identity and admits before completion', {timeout:5000}, async t=>{
  const f=await fixture(t),receipt=await f.send('first');
  assert.equal(receipt.admitted,true);
  await f.entered;
  assert.equal(f.agent.status,'running');assert.equal(f.committed()[0].source.rpcId,'first');
  assert.equal(f.committed()[0].id,receipt.messageId);
  assert.equal(f.events.some(event=>event.type==='turn/end'),false);
  f.release();await f.agent.whenIdle();assert.equal(f.requests.length,1);
});

test('worker identity text reaches model input and native history while human input remains literal', {timeout:5000},async t=>{
  const f=await fixture(t),sender={id:'11111111-1111-4111-8111-111111111111',name:'Reviewer'};
  const first=submissionContent({sender,text:'First report'});
  await f.send('worker-idle',first,{kind:'worker',workerId:sender.id});await f.entered;
  const guidance=submissionContent({sender,text:'',content:[{type:'text',text:'Before image'},image,{type:'text',text:'After image'}]});
  await f.send('worker-running',guidance,{kind:'worker',workerId:sender.id});
  const human=[{type:'text',text:'Human guidance'}];await f.send('human',human);
  f.release();await f.agent.whenIdle();
  const committed=f.committed();assert.equal(committed.length,3);
  assert.deepEqual(committed.map(message=>message.source.kind),['polariton-worker','polariton-worker','user']);
  assert.equal(committed[0].source.workerId,sender.id);
  assert.equal(committed[1].source.workerId,sender.id);
  assert.deepEqual(committed[0].content,first);assert.deepEqual(committed[2].content,human);
  assert.deepEqual(committed[1].content.map(part=>part.type),['text','text','image','text']);
  assert.equal(committed[1].content[0].text,first[0].text);
  assert.equal(committed[1].content[1].text,'Before image');assert.equal(committed[1].content[3].text,'After image');
  const input=f.requests.at(-1).messages.filter(message=>message.role==='user');
  for(const message of committed){assert.deepEqual(input.find(value=>value.id===message.id)?.content,message.content);}
  const root=join(f.home,'sessions');await f.ctx.plugin(JsonlSessionPersistence,{root});
  const writer=await f.ctx.sessionPersistence.create(f.agent.session.header);
  try{await writer.append(f.agent.session.snapshotEvents());await writer.flush();}finally{await writer.close();}
  const history=await readHistory(root,f.agent.id);
  assert.deepEqual(history.events.filter(event=>event.type==='user/message').map(event=>event.data.content),committed.map(message=>message.content));
});

test('many running inputs retain order and enter the same native turn without duplicate source records', {timeout:5000}, async t=>{
  const f=await fixture(t);await f.send('initial');await f.entered;
  for(const id of ['worker-a','worker-b','user-guidance','worker-c'])assert.equal((await f.send(id)).admitted,true);
  f.release();await f.agent.whenIdle();
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['initial','worker-a','worker-b','user-guidance','worker-c']);
  assert.equal(f.events.filter(event=>event.type==='turn/start').length,1);
  assert.equal(f.requests.length,2);
});

test('input arriving at turn end is retained and wakes the next native turn', {timeout:5000}, async t=>{
  const f=await fixture(t),delivered=Promise.withResolvers();let sent=false;
  // Async content preparation can complete inside the pinned driver's closing seam.
  f.ctx.on('session/event',(_session,event)=>{if(event.type==='turn/end'&&!sent){sent=true;queueMicrotask(()=>{void f.send('at-boundary').then(delivered.resolve,delivered.reject);});}});
  await f.send('initial');await f.entered;f.release();await delivered.promise;await f.agent.whenIdle();
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['initial','at-boundary']);
  assert.equal(f.requests.length,2);
});

test('pre-step rejection exposes a claimed but unapplied input before the blocked terminal boundary', {timeout:5000}, async t=>{
  const f=await fixture(t),order=[];
  f.ctx.on('agent/inbox/claimed',({message,turn})=>order.push({kind:'claimed',id:message.source.rpcId,turn}));
  f.ctx.on('agent/pre-step',async()=>({kind:'reject'}));
  f.ctx.on('session/event',(_session,event)=>{if(event.type==='turn/end')order.push({kind:'ended',turn:event.data.turn,reason:event.data.reason.kind});});
  await f.send('blocked');await f.agent.whenIdle();
  assert.deepEqual(order,[{kind:'claimed',id:'blocked',turn:1},{kind:'ended',turn:1,reason:'blocked'}]);
  assert.equal(f.requests.length,0);assert.deepEqual(f.committed(),[]);
});

test('images use durable DSH admission and preserve mixed content during an active turn', {timeout:5000}, async t=>{
  const f=await fixture(t);await f.send('initial');await f.entered;
  await f.send('image-guidance',[{type:'text',text:'Before'},image,{type:'text',text:'After'}]);
  f.release();await f.agent.whenIdle();
  const message=f.committed()[1];assert.equal(message.source.rpcId,'image-guidance');
  assert.deepEqual(message.content.map(part=>part.type),['text','image','text']);
  assert.equal(message.content[0].text,'Before');assert.equal(message.content[2].text,'After');
  const stored=await f.ctx.attachments.readImage(message.content[1].attachment);
  assert.equal(stored.data.length,Buffer.from(image.data,'base64').length);
});

test('image preparation preserves FIFO admission when text arrives behind it', {timeout:5000}, async t=>{
  const f=await fixture(t,{holdImages:true});
  const first=f.send('image-first',[image]);await f.imageEntered;
  const second=f.send('text-second');assert(second instanceof Promise);assert.equal(f.committed().length,0);
  f.releaseImage();await Promise.all([first,second]);await f.entered;f.release();await f.agent.whenIdle();
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['image-first','text-second']);
});

test('interrupt fences image admission and later input until every pre-interrupt operation settles', {timeout:5000}, async t=>{
  const f=await fixture(t,{holdImages:true});
  const imageInput=f.send('cancelled-image',[image]);await f.imageEntered;
  const textInput=f.send('cancelled-text');
  const rejectedImage=assert.rejects(imageInput,fault('MESSAGE_CANCELLED')),rejectedText=assert.rejects(textInput,fault('MESSAGE_CANCELLED'));
  let interrupted=false;const barrier=f.messages.interrupt(f.agent.id).then(value=>{interrupted=true;return value;});
  assert.throws(()=>f.send('during-interrupt'),fault('WORKER_INTERRUPTING'));
  await nextTurn();assert.equal(interrupted,false);assert.equal(f.requests.length,0);
  f.releaseImage();await Promise.all([rejectedImage,rejectedText]);assert.deepEqual(await barrier,{interrupted:true});
  assert.equal(f.committed().length,0);assert.equal(f.agent.status,'idle');
  await f.send('after-interrupt');await f.entered;f.release();await f.agent.whenIdle();
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['after-interrupt']);
});

test('interrupt cancels the active driver and exposes discarded pending receipt identities', {timeout:5000}, async t=>{
  const f=await fixture(t);await f.send('initial');await f.entered;await f.send('queued');
  const first=f.messages.interrupt(f.agent.id),second=f.messages.interrupt(f.agent.id);
  assert.equal(first,second);assert.deepEqual(await first,{interrupted:true});
  assert.deepEqual(f.discarded,['queued']);assert.equal(f.agent.status,'idle');
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['initial']);
});

test('interrupt cancels already prepared text before its scheduled enqueue', {timeout:5000}, async t=>{
  const f=await fixture(t),pending=f.send('prepared-before-interrupt');
  const rejected=assert.rejects(pending,fault('MESSAGE_CANCELLED'));
  await Promise.all([rejected,f.messages.interrupt(f.agent.id)]);
  assert.equal(f.agent.status,'idle');assert.equal(f.requests.length,0);assert.deepEqual(f.committed(),[]);
});

test('invalid or unsupported content is definitively rejected without waking DSH', {timeout:5000}, async t=>{
  const f=await fixture(t,{images:false});
  assert.throws(()=>f.send('empty',[{type:'text',text:' '}]),fault('MESSAGE_INVALID'));
  await assert.rejects(f.send('unsupported',[image]),fault('IMAGE_UNSUPPORTED'));
  assert.equal(f.agent.status,'idle');assert.equal(f.requests.length,0);assert.equal(f.committed().length,0);
});

test('malformed images do not admit any of their surrounding text and later valid input still works', {timeout:5000}, async t=>{
  const f=await fixture(t);
  await assert.rejects(f.send('invalid-image',[{type:'text',text:'Must not leak'}, {...image,data:'invalid'}]),fault('IMAGE_ADMISSION_FAILED'));
  assert.equal(f.committed().length,0);await f.send('valid');await f.entered;f.release();await f.agent.whenIdle();
  assert.deepEqual(f.committed().map(message=>message.source.rpcId),['valid']);
});
