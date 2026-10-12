import {CanvasBridge} from '../src/canvas.ts';
import {CanvasSnapshots} from '../src/canvas-snapshots.ts';
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessFactory,InputPart} from '../harness/contracts.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import {isActivationPrompt} from './fixtures/activation.ts';
import {persistMedia} from './fixtures/media.mjs';
import {submissionContent} from '../src/contracts.ts';
import {MainOperations,Projects} from '../src/cli/main-operations.ts';
import {Request} from '../src/cli/contracts.ts';
import {EnvironmentClient} from '../src/environment/daemon.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {Operation,owner} from '../src/operations.ts';

/** Observe owner outcomes; the neighboring harness controls execution without a provider. */
function until(agents: AgentManager, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise(resolve => {
    const changed = () => { if (ready()) { agents.off('change', changed); resolve(); } };
    agents.on('change', changed); changed();
  });
}

async function fixture(t: TestContext, settings: {maxPendingMessages?:number} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr012-agents-')));
  const config = {...await loadConfig(), stateRoot: root, verification: false,...settings};
  let sequence = 0;
  const id = () => `12000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const tree = new ResearchTree(config); await tree.initialize();
  const project = await tree.createProject(id(), 'CLI delivery');
  const node = id();
  await tree.mutate(project.id, {operationId: id(), revision: 0, command: {kind: 'node.create', id: node, title: 'Workspace', description: ''}});
  const harnesses: ControlledHarness[] = [];
  const faults = {message: 'none' as 'none' | 'not-admitted' | 'lost-ack' | 'applied-lost-ack',messageGate:undefined as Promise<void>|undefined,messageEntered:undefined as (()=>void)|undefined};
  const factory: HarnessFactory = (settings, home, _workspace, _budget, permission) => {
    class Neighbor extends ControlledHarness {
      override async message(sessionId:string,requestId:string,content:InputPart[],origin:Parameters<ControlledHarness['message']>[3]){
        const params={sessionId,requestId,content};
        if(faults.message!=='none'){
          this.calls.push({method:'message',params});
          if(faults.message==='not-admitted'){this.complete();throw Object.assign(new Error('Controlled definite refusal before enqueue'),{code:'SESSION_INACTIVE'});}
          if(faults.message==='applied-lost-ack')this.emit('submission',{sessionId:this.id,requestId,state:'applied'});
          throw new Error('Transport acknowledgement lost');
        }
        if(faults.messageGate){this.calls.push({method:'message',params});faults.messageEntered?.();await faults.messageGate;return {messageId:requestId};}
        return super.message(sessionId,requestId,content,origin);
      }

    }
    const harness = new Neighbor(`session-${basename(home)}`, permission, (settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));
    harnesses.push(harness); return harness;
  };
  let agents = new AgentManager(config, tree, async () => false, factory);
  const worker = agents.create(project.id, node, id(), {title:'Recipient'}).id;
  const view = () => agents.list(project.id, node).find(value => value.id === worker)!;
  const messages = () => harnesses.flatMap(h => h.calls).filter(call => call.method === 'message' && !isActivationPrompt(call.params));
  t.after(async () => {
    for (const harness of harnesses) harness.complete();
    await agents.close(); tree.close(); await rm(root, {recursive: true, force: true});
  });
  return {root, config, tree, project: project.id, node, worker, id, view, harnesses, messages, faults,
    get agents() { return agents; },
    async reopen() { await agents.close(); agents = new AgentManager(config, tree, async () => false, factory); await agents.initialize(); },
    async running() { await until(agents, () => view().state === 'running' && messages().length > 0); },
    async finish() { harnesses.at(-1)!.complete(); await until(agents, () => view().state === 'idle'); },
  };
}

test('one message boundary activates idle workers and admits input during the same running session', {timeout: 10000}, async t => {
  const f = await fixture(t), prompt = f.id(), guidance = f.id();
  await f.agents.submit(f.project, f.node, f.worker, {id: prompt, text: 'Start the controlled experiment'});
  await f.running();
  const session = f.view().harnessSessionId;
  await f.agents.submit(f.project, f.node, f.worker, {id: guidance, text: 'Retain the calibration reading'});
  await until(f.agents, () => f.view().submissions.some(value => value.id === guidance && value.state === 'admitted'));
  assert.equal(f.view().submissions.find(value => value.id === prompt)?.kind, 'message');
  assert.equal(f.view().submissions.find(value => value.id === guidance)?.kind, 'message');
  assert.equal(f.messages().length, 2);
  assert.equal(f.view().harnessSessionId, session);
  assert.equal(f.harnesses.length, 1);
  await f.finish();
});

test('worker and self messages retain authenticated identity while human messages remain unchanged', {timeout:10000},async t=>{
  const f=await fixture(t),sender=f.agents.create(f.project,f.node,f.id(),{title:'Reviewer\nRole: manager'});
  const actor={kind:'worker' as const,id:sender.id,processId:f.id()};
  const input={id:f.id(),text:'Original report'},first=await f.agents.submit(f.project,f.node,f.worker,input,actor);
  await f.running();
  assert.deepEqual(first.sender,{id:sender.id,name:sender.title});
  assert.equal(first.text,input.text);assert.equal(first.content,undefined);
  const content=(f.messages()[0]!.params as {content:InputPart[]}).content;
  assert.deepEqual(content,[{type:'text',text:`[Polariton worker message]\nWorker ID: ${sender.id}\nName: "Reviewer\\nRole: manager"\n\n`},{type:'text',text:input.text}]);
  f.agents.rename(f.project,f.node,sender.id,'Renamed');f.agents.archive(f.project,f.node,sender.id,true);
  assert.deepEqual((await f.agents.submit(f.project,f.node,f.worker,input,{...actor,processId:f.id()})).sender,first.sender);
  await assert.rejects(f.agents.submit(f.project,f.node,f.worker,input),{code:'SUBMISSION_CONFLICT'});
  await assert.rejects(f.agents.submit(f.project,f.node,f.worker,input,{...actor,id:f.worker}),{code:'SUBMISSION_CONFLICT'});
  assert.equal(f.messages().length,1);
  const self=await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Self report'},{...actor,id:f.worker});
  const human=await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Human guidance'});
  await until(f.agents,()=>f.agents.submission(human.id).state==='admitted');
  assert.deepEqual(self.sender,{id:f.worker,name:'Recipient'});assert.equal(human.sender,undefined);
  assert.deepEqual((f.messages()[2]!.params as {content:InputPart[]}).content,[{type:'text',text:'Human guidance'}]);
  assert.deepEqual(f.messages().map(message=>(message.params as {origin:unknown}).origin),[{kind:'worker',workerId:sender.id},{kind:'worker',workerId:f.worker},{kind:'human'}]);
  await f.finish();
  assert.equal(f.agents.submission(first.id).state,'applied');
  assert.deepEqual((f.harnesses[0]!.sourceEvents[0]!.data as {content:InputPart[]}).content,content);
  await f.reopen();
  assert.deepEqual(submissionContent(f.agents.readSubmission(f.project,f.node,f.worker,first.id)),content);
});

test('safe retry after restart preserves the original worker header despite rename and archive', {timeout:10000},async t=>{
  const f=await fixture(t),actor={kind:'worker' as const,id:f.worker,processId:f.id()};
  f.faults.message='not-admitted';
  const receipt=await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Retry this original body'},actor);
  await until(f.agents,()=>f.agents.submission(receipt.id).state==='failed');
  assert.equal(f.agents.submission(receipt.id).retryable,true);
  const original=(f.messages()[0]!.params as {content:InputPart[]}).content;
  f.agents.rename(f.project,f.node,f.worker,'Later name');f.agents.archive(f.project,f.node,f.worker,true);
  await f.reopen();f.faults.message='none';
  f.agents.retry(f.project,f.node,f.worker,receipt.id);
  await until(f.agents,()=>f.agents.submission(receipt.id).state==='admitted');
  assert.deepEqual((f.messages()[1]!.params as {content:InputPart[]}).content,original);
  assert.deepEqual((f.messages()[1]!.params as {origin:unknown}).origin,{kind:'worker',workerId:f.worker},'Restart recovery preserves authenticated origin, independently of visible text');
  assert.equal(original.filter(part=>part.type==='text'&&part.text.includes('[Polariton worker message]')).length,1);
  await f.finish();assert.equal(f.agents.submission(receipt.id).state,'applied');
});

test('CLI cannot adopt failed browser input with a different sender or body', {timeout:10000},async t=>{
  const f=await fixture(t);
  const snapshots=await CanvasSnapshots.open(f.config.stateRoot,f.config.canvas,error=>{throw error;});t.after(()=>snapshots.close());
  const operations=new MainOperations(f.config,f.tree,f.agents,new Projects(f.tree,f.agents),new EnvironmentClient(RackConfig.parse({stateRoot:join(f.root,'rack'),socketPath:join(f.root,'rack.sock')})),new CanvasBridge(f.config.canvas),snapshots);
  f.faults.message='not-admitted';
  for(const changed of ['sender','body']){
    const id=f.id(),text='Original human input';
    await f.agents.submit(f.project,f.node,f.worker,{id,text,content:[{type:'text',text}]});
    await until(f.agents,()=>f.agents.submission(id).state==='failed');
    const before=f.messages().length;
    const request=Request.parse({version:1,requestId:id,command:{kind:'worker.send',input:{target:f.worker,text:changed==='body'?'Changed input':text}}});
    const result=Operation.parse(await operations.execute(request,changed==='sender'?{kind:'worker',id:f.worker,processId:f.id()}:owner));
    assert.equal(result.state,'failed');assert.equal(result.error?.code,'SUBMISSION_CONFLICT');
    assert.equal(f.messages().length,before);assert.equal(f.agents.submission(id).sender,undefined);
  }
});

test('concurrent identical sends retain one logical input and conflicting content cannot replace it', {timeout: 10000}, async t => {
  const f = await fixture(t), input = {id: f.id(), text: 'One logical task'};
  await Promise.all([f.agents.submit(f.project, f.node, f.worker, input), f.agents.submit(f.project, f.node, f.worker, input)]);
  await f.running();
  await assert.rejects(f.agents.submit(f.project, f.node, f.worker, {...input, text: 'Changed task'}));
  assert.equal(f.view().submissions.filter(value => value.id === input.id).length, 1);
  assert.equal(f.messages().length, 1);
  await f.finish();
  await f.agents.submit(f.project, f.node, f.worker, input);
  assert.equal(f.messages().length, 1, 'Retry after completion must return the original result');
});

test('concurrent messages admitted during startup share activation and preserve every input', {timeout: 10000}, async t => {
  const f = await fixture(t);
  const inputs = ['First', 'Second'].map(text => ({id: f.id(), text}));
  await Promise.all(inputs.map(input => f.agents.submit(f.project, f.node, f.worker, input)));
  await until(f.agents, () => f.view().submissions.every(value => value.state === 'admitted'));
  assert.equal(f.harnesses.length, 1);
  assert.deepEqual(f.messages().map(call => (call.params as {requestId:string}).requestId), inputs.map(input => input.id));
  await f.finish();
  assert(f.view().submissions.every(value => value.state === 'applied'));
});

test('explicit closure survives restart and send requires explicit resume', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Initial task'});
  await f.running(); await f.finish();
  await f.agents.closeWorker(f.project, f.node, f.worker);
  await f.reopen();
  const count = f.harnesses.length;
  await assert.rejects(f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Must not undo Close'}));
  assert.equal(f.harnesses.length, count);
  await f.agents.resume(f.project, f.node, f.worker);
  assert.equal(f.view().state, 'idle');
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Resumed task'});
  await until(f.agents, () => f.messages().length === 2); await f.finish();
});

test('retained evidence resolves after restart without activating archived workers', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Establish the retained session'});
  await f.running(); await f.finish();
  const session = f.view().harnessSessionId!;
  await f.agents.closeWorker(f.project, f.node, f.worker);
  const media = await persistMedia(join(f.root, 'harness', f.worker), session, 'Retained calibration result');
  const page = await f.agents.history(f.project, f.node, f.worker);
  const image = page.attachments.find(value => value.mediaType === 'image/png')!;
  const file = page.attachments.find(value => value.mediaType === 'application/octet-stream')!;
  assert.ok(image.reference); assert.ok(file.reference);
  f.agents.archive(f.project, f.node, f.worker, true);
  await f.reopen();
  const count = f.harnesses.length;
  assert.deepEqual((await f.agents.evidence(f.project, f.node, f.worker, image.reference)).bytes, media.png);
  assert.deepEqual((await f.agents.evidence(f.project, f.node, f.worker, file.reference)).bytes, media.fileBytes);
  assert.equal(f.harnesses.length, count);
  assert.equal(f.view().archived, true);
  assert.ok(media.imagePath); await rm(media.imagePath);
  await assert.rejects(f.agents.evidence(f.project, f.node, f.worker, image.reference));
  assert.equal(f.harnesses.length, count, 'Missing retained evidence must not activate execution');
});

test('confirmed message refusal requires explicit retry and retains one logical input', {timeout: 10000}, async t => {
  const f = await fixture(t), original = f.id(), next = f.id();
  await f.agents.submit(f.project, f.node, f.worker, {id: original, text: 'Original task'});
  await f.running(); f.faults.message = 'not-admitted';
  await f.agents.submit(f.project, f.node, f.worker, {id: next, text: 'Message at completion'});
  await until(f.agents, () => f.view().submissions.find(value => value.id === next)?.state === 'failed');
  assert.equal(f.view().submissions.find(value => value.id === original)?.state, 'applied');
  assert.equal(f.view().submissions.find(value => value.id === next)?.retryable, true);
  assert.equal(f.messages().length, 2, 'No automatic retry after definite refusal');
  f.faults.message = 'none';
  f.agents.retry(f.project, f.node, f.worker, next);
  await until(f.agents, () => f.view().submissions.find(value => value.id === next)?.state === 'admitted');
  await f.finish();
  assert.equal(f.view().submissions.find(value => value.id === next)?.state, 'applied');
  assert.equal(f.view().submissions.filter(value => value.id === next).length, 1);
  assert.equal(f.messages().length, 3);
});

test('lost message acknowledgement remains uncertain and repeating its identity never sends again', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Original task'});
  await f.running(); f.faults.message = 'lost-ack';
  const input = {id: f.id(), text: 'Potentially admitted guidance'};
  await f.agents.submit(f.project, f.node, f.worker, input);
  await until(f.agents, () => f.view().submissions.find(value => value.id === input.id)?.state === 'uncertain');
  await f.agents.submit(f.project, f.node, f.worker, input);
  assert.equal(f.messages().length, 2);
  await f.finish();
  await f.agents.submit(f.project, f.node, f.worker, input);
  assert.equal(f.messages().length, 2);
});

test('closing an unstarted worker can be reversed explicitly without starting inference', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.closeWorker(f.project, f.node, f.worker);
  await assert.rejects(f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Blocked'}));
  await f.agents.resume(f.project, f.node, f.worker);
  assert.equal(f.view().state, 'inactive'); assert.equal(f.harnesses.length, 0);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Authorized task'});
  await f.running(); await f.finish();
});

test('normal daemon shutdown does not invent explicit worker closure', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Settled task'});
  await f.running(); await f.finish(); await f.reopen();
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Continue after daemon restart'});
  await until(f.agents, () => f.messages().length === 2); await f.finish();
});

test('retry identity does not bypass worker scope checks', {timeout: 10000}, async t => {
  const f = await fixture(t), input = {id: f.id(), text: 'Scoped task'};
  await f.agents.submit(f.project, f.node, f.worker, input);
  await f.running(); await f.finish();
  const other = f.id();
  await f.tree.mutate(f.project, {operationId: f.id(), revision: f.tree.graph(f.project).revision, command: {kind: 'node.create', id: other, title: 'Different scope', description: ''}});
  await assert.rejects(f.agents.submit(f.project, other, f.worker, input), {code: 'WORKER_NOT_FOUND'});
  await assert.rejects(f.agents.submit(f.id(), f.node, f.worker, input));
  assert.equal(f.messages().length, 1);
});

test('ordered text content is retained while the recipient is running', {timeout: 10000}, async t => {
  const f = await fixture(t);
  await f.agents.submit(f.project, f.node, f.worker, {id: f.id(), text: 'Original task'});
  await f.running();
  const id = f.id();
  await f.agents.submit(f.project, f.node, f.worker, {id, text: '', content: [{type: 'text', text: 'Calibration first'}, {type: 'text', text: 'Then preserve the result'}]});
  await until(f.agents, () => f.view().submissions.find(value => value.id === id)?.state === 'admitted');
  const request = f.messages().find(call => (call.params as {requestId:string}).requestId === id)!.params as {content: unknown[]};
  assert.deepEqual(request.content, [{type: 'text', text: 'Calibration first'}, {type: 'text', text: 'Then preserve the result'}]);
  await f.finish();
});


test('concurrent messages share activation and retain every immutable input in admission order', {timeout:10000}, async t=>{
  const f=await fixture(t);
  const inputs=Array.from({length:8},(_,index)=>({id:f.id(),text:`Report ${index}`,content:[{type:'text' as const,text:`Report ${index}`}]}));
  const accepted=inputs.map(input=>f.agents.submit(f.project,f.node,f.worker,input));
  inputs[3]!.content[0]!.text='Caller mutated its own payload';
  const receipts=await Promise.all(accepted);
  receipts[7]!.text='Caller mutated its receipt';
  receipts[7]!.content![0]={type:'text',text:'Caller mutated its receipt content'};
  await until(f.agents,()=>f.view().submissions.every(value=>value.state==='admitted'));
  assert.equal(f.harnesses.length,1,'Activation is shared');
  const guidance=f.messages().map(call=>call.params as {requestId:string;content:Array<{type:string;text:string}>});
  assert.deepEqual(guidance.map(value=>value.requestId),inputs.map(value=>value.id));
  assert.deepEqual(guidance.map(value=>value.content[0]!.text),inputs.map((_,index)=>`Report ${index}`));
  for(const input of inputs.filter((_,index)=>index!==3))await f.agents.submit(f.project,f.node,f.worker,input);
  assert.equal(f.messages().length,8);
  await f.finish();
});

test('message capacity is bounded without rejecting ordinary running-worker input', {timeout:10000},async t=>{
  const f=await fixture(t,{maxPendingMessages:2});
  await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Original'});await f.running();
  const second=f.id();await f.agents.submit(f.project,f.node,f.worker,{id:second,text:'Guidance'});
  await until(f.agents,()=>f.view().submissions.find(value=>value.id===second)?.state==='admitted');
  await assert.rejects(f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Exceeds configured capacity'}),{code:'MESSAGE_CAPACITY'});
  const harness=f.harnesses[0]!;
  harness.emit('submission',{sessionId:harness.id,requestId:second,state:'applied'});
  const third=f.id();await f.agents.submit(f.project,f.node,f.worker,{id:third,text:'Capacity returned after application'});
  await until(f.agents,()=>f.view().submissions.find(value=>value.id===third)?.state==='admitted');
  await f.finish();
});

test('simultaneous messages after turn settlement are admitted exactly once without cancellation', {timeout:10000},async t=>{
  const f=await fixture(t);
  await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Original'});await f.running();await f.finish();
  const inputs=['First report','Second report','Third report'].map(text=>({id:f.id(),text}));
  await Promise.all(inputs.map(input=>f.agents.submit(f.project,f.node,f.worker,input)));
  await until(f.agents,()=>inputs.every(input=>f.view().submissions.find(value=>value.id===input.id)?.state==='admitted'));
  await f.finish();
  const dispatched=f.messages().map(call=>(call.params as {requestId:string}).requestId);
  for(const input of inputs){
    assert.equal(dispatched.filter(id=>id===input.id).length,1);
    assert.equal(f.view().submissions.find(value=>value.id===input.id)?.state,'applied');
  }
  assert.equal(f.harnesses.flatMap(h=>h.calls).filter(call=>call.method==='interrupt').length,0);
});

test('persisted message application outranks a lost acknowledgement', {timeout:10000},async t=>{
 const f=await fixture(t);await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Original'});await f.running();
 f.faults.message='applied-lost-ack';const id=f.id();
 await f.agents.submit(f.project,f.node,f.worker,{id,text:'Applied before lost ack'});
 await until(f.agents,()=>f.view().submissions.find(value=>value.id===id)?.state==='applied');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.view().submissions.find(value=>value.id===id)?.state,'applied');await f.finish();
});

test('late message acknowledgement cannot resurrect input discarded by interruption', {timeout:10000},async t=>{
 const f=await fixture(t);await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Original'});await f.running();
 let release!:()=>void;f.faults.messageGate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
 const id=f.id();await f.agents.submit(f.project,f.node,f.worker,{id,text:'Guidance'});
 await new Promise(resolve=>setImmediate(resolve));
 const interruption=f.id();await f.agents.submit(f.project,f.node,f.worker,{id:interruption,kind:'interrupt',text:''});
 const h=f.harnesses[0]!;h.emit('submission',{sessionId:h.id,requestId:id,state:'interrupted'});release();
 await until(f.agents,()=>f.view().submissions.find(value=>value.id===interruption)?.state==='completed');
 assert.equal(f.view().submissions.find(value=>value.id===id)?.state,'interrupted');
});

for(const reason of ['blocked','error','aborted','completed'] as const)test(`claimed input settles after ${reason} without settling another turn's queued message`, {timeout:10000},async t=>{
  const f=await fixture(t);
  const applied=f.id(), claimed=f.id(), queued=f.id();
  await f.agents.submit(f.project,f.node,f.worker,{id:applied,text:'Already applied'});await f.running();
  await f.agents.submit(f.project,f.node,f.worker,{id:claimed,text:'Claimed before terminal'});
  await f.agents.submit(f.project,f.node,f.worker,{id:queued,text:'Queued for another turn'});
  await until(f.agents,()=>f.view().submissions.every(value=>value.state==='admitted'));
  const h=f.harnesses[0]!;
  h.emit('submission',{sessionId:h.id,requestId:applied,state:'applied'});
  h.emit('submission',{sessionId:h.id,requestId:claimed,state:reason==='aborted'?'interrupted':'failed',detail:'Input settled without application'});
  const receipts=f.view().submissions;
  assert.equal(receipts.find(value=>value.id===applied)?.state,'applied');
  assert.equal(receipts.find(value=>value.id===claimed)?.state,reason==='aborted'?'interrupted':'failed');
  assert.equal(receipts.find(value=>value.id===claimed)?.retryable,false);
  assert.equal(receipts.find(value=>value.id===queued)?.state,'admitted');
  await f.agents.submit(f.project,f.node,f.worker,{id:claimed,text:'Claimed before terminal'});
  assert.equal(f.messages().length,3,'Terminal input is not automatically replayed');
});

test('terminal claimed-input failure before acknowledgement cannot become admitted again', {timeout:10000},async t=>{
  const f=await fixture(t);
  await f.agents.submit(f.project,f.node,f.worker,{id:f.id(),text:'Original'});await f.running();
  let release!:()=>void;f.faults.messageGate=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{f.faults.messageEntered=resolve;});
  const id=f.id();
  try{
    await f.agents.submit(f.project,f.node,f.worker,{id,text:'Claimed before delayed acknowledgement'});
    await entered;
    const h=f.harnesses[0]!;
    h.emit('submission',{sessionId:h.id,requestId:id,state:'failed',detail:'Input settled without application'});
  }finally{release();}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.view().submissions.find(value=>value.id===id)?.state,'failed');
  assert.equal(f.view().submissions.find(value=>value.id===id)?.retryable,false);
});
