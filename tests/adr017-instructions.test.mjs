import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt,{renderPrompt} from '@deepseek-ai/dsh-system-prompt';
import * as Instructions from '../harness/instructions.mjs';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm,{LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Tools from '@deepseek-ai/dsh-tools';

test('captured instructions render literally after the existing harness and Polariton guidance',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());
 await ctx.plugin(SystemPrompt,{personaSuffix:'Polariton orientation'});
 const text='Worker instructions: preserve {{unknown}} and {{cwd}} verbatim.\nUnicode: λ研究.';
 await ctx.plugin(Instructions,{text});
 const rendered=renderPrompt(await ctx.systemPrompt.assemble());
 assert.match(rendered,/You are an AI agent powered by DeepSeek Harness\./);
 assert.ok(rendered.indexOf('Polariton orientation')<rendered.indexOf(text));
 assert.ok(rendered.endsWith(text));
});

test('separate worker harnesses retain isolated instruction snapshots on recreation',async t=>{
 const contexts=[];t.after(async()=>{for(const ctx of contexts)await ctx.fiber.dispose();});
 for(const text of ['First worker {{role}}','Second worker {{role}}','First worker {{role}}']){
  const ctx=new Context();contexts.push(ctx);
  await ctx.plugin(SystemPrompt,{personaSuffix:'Polariton orientation'});
  await ctx.plugin(Instructions,{text});
  const rendered=renderPrompt(await ctx.systemPrompt.assemble());
  assert.ok(rendered.endsWith(text));
  assert.ok(!rendered.includes(text.startsWith('First')?'Second worker':'First worker'));
 }
});


/** Observe exactly the provider-neutral request delivered by the real DSH loop. */
test('the first model request contains the literal worker instructions and orientation without cross-worker leakage',{timeout:5000},async t=>{
 const workers=[];
 t.after(async()=>{for(const {ctx,handle} of workers){await handle.dispose();await ctx.fiber.dispose();}});
 for(const [name,other] of [['First worker','Second worker'],['Second worker','First worker']]){
  const ctx=new Context(),requests=[],text=`${name}: preserve {{unknown}} and {{cwd}} literally. λ研究.`;
  await ctx.plugin(SystemPrompt,{personaSuffix:'Polariton orientation'});
  for(const plugin of [Tools,Agents,Sessions,Projections,Llm,AgentLoop])await ctx.plugin(plugin,{});
  await ctx.plugin(Instructions,{text});
  class Adapter extends LlmAdapter {
   async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']};}
   async *stream(request){
    requests.push(structuredClone(request));
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:'Completed'};
    yield {type:'block-end',index:0,block:{type:'text',text:'Completed'}};
    yield {type:'finish',reason:{kind:'stop'}};
   }
  }
  ctx.llm.registerAdapter(['controlled'],new Adapter());
  const handle=await ctx.agents.create({sessionId:name,agentOptions:{provider:'controlled',model:'local'}});workers.push({ctx,handle});
  assert.equal(requests.length,0);
  handle.agent.steer(createUserMessage({content:[{type:'text',text:'Analyze the measurement'}],source:{kind:'user'}}));
  await handle.agent.whenIdle();assert.equal(requests.length,1);
  const request=requests[0];assert.equal(request.messages[0].role,'system');
  const system=request.messages.filter(message=>message.role==='system').flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.match(system,/You are an AI agent powered by DeepSeek Harness\./);
  assert.ok(system.includes('Polariton orientation'));assert.ok(system.includes(text));assert.ok(!system.includes(other));
  assert.ok(system.indexOf('Polariton orientation')<system.indexOf(text));
  assert.equal(request.messages.filter(message=>message.role==='user').flatMap(message=>message.content).some(block=>block.type==='text'&&block.text.includes(text)),false,'Worker instructions retain the system role at the model boundary');
 }
});

/** The production launcher must install the section again after process recreation.
 * The existing budget boundary refuses every model attempt before any adapter call. */
test('production launch and retained-session resume persist the captured literal system section',{timeout:60000},async t=>{
 const {mkdtemp,mkdir,realpath,readFile,rm}=await import('node:fs/promises');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {Harness}=await import('../harness/client.ts');const {loadConfig}=await import('../src/config.ts');
 const {nativeTurn}=await import('../scripts/native-turn.mjs');const {readHistory}=await import('../harness/history.mjs');
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-instructions-acp-'))),workspace=join(root,'workspace'),home=join(root,'home');await mkdir(workspace);
 const instructions='Captured analyst: retain {{unknown}} and {{cwd}} literally. λ研究.';
 const {loadPolaritonPrompt}=await import('../harness/prompt.ts');
 const {shared:orientation,identity}=await loadPolaritonPrompt();
 const config={...await loadConfig(),verification:true,workerInstructions:instructions,startupTimeoutMs:20000,requestTimeoutMs:15000};
 const harnesses=[];let deniedAttempts=0,sessionId;
 t.after(async()=>{for(const harness of harnesses)await harness.close();await rm(root,{recursive:true,force:true});});
 for(const restoring of [false,true]){
  const harness=new Harness(config,home,workspace,async()=>{deniedAttempts++;return false;});harnesses.push(harness);await harness.start();
  const session=await harness.activate(restoring?sessionId:null,[]);if(!restoring)sessionId=session.sessionId;
  await nativeTurn(harness,sessionId,restoring?'Inspect after restart':'Inspect initial instructions',config.requestTimeoutMs);
  await harness.closeSession(sessionId);
  const history=await readHistory(join(home,'sessions'),sessionId,{limit:config.maxHistoryEvents});
  const system=history.events.filter(event=>event.type==='system/message').at(-1);
  assert.ok(system,'DSH records the model-facing system message before admission');
  const text=system.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  assert.ok(text.includes(instructions),restoring?'Resume must reinstall the instructions':'Initial launch must install the instructions');
  assert.ok(text.includes(orientation));assert.ok(text.indexOf(orientation)<text.indexOf(instructions));
  assert.equal(text.split(identity).length-1,1);
  assert.ok(!text.includes('You are an AI agent powered by DeepSeek Harness.'));
  assert.ok(!text.includes('DeepSeek Harness Web GUI'));
  await harness.close();
 }
 assert.equal(deniedAttempts,2,'Both assembled model attempts were refused before contacting a provider');
});
