import {activateWorker,isActivationPrompt,isExerciseSubmission} from './fixtures/activation.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessEvents,HarnessFactory,InputPart,Activity} from '../harness/contracts.ts';
import { ResearchTree } from '../src/research.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { persistMedia } from './fixtures/media.mjs';

const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const route = (model: string) => JSON.stringify(['deepseek-official', model]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC', 'base64');
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function changedUntil(agents: AgentManager, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  return new Promise<void>(resolve => {
    const changed = () => { if (ready()) { agents.off('change', changed); resolve(); } };
    agents.on('change', changed); changed();
  });
}

/** A native inbox neighbor: delivery application and process settlement remain separate. */
class SequenceHarness extends EventEmitter<HarnessEvents> implements HarnessPort {
  private readonly signals=new EventEmitter<{message:[]}>();
  readonly calls: { method: string; params: unknown }[] = [];
  readonly messages: Array<{requestId:string;content:unknown[]}> = [];
  readonly inbox: Array<{requestId:string;content:unknown[]}> = [];
  configGate: ReturnType<typeof barrier<void>> | null = null;
  readonly configEntered = barrier<void>();
  readonly id: string;
  model: string;
  capability: boolean;
  closed = false;
  status:'idle'|'running' = 'idle';
  observation = { events: [] as { type: string; seq: number; time: number; data: unknown }[], cursor: -1, assistantStream: { revision: 0 } };
  readonly permission: Parameters<HarnessFactory>[4];
  constructor(id: string, model: string, capability: boolean, permission: Parameters<HarnessFactory>[4]) {
    super(); this.id = id; this.model = model; this.capability = capability; this.permission = permission;
  }
  options() { return [{ id: 'model', name: 'Model', type: 'select', currentValue: route(this.model), options: [
    { group:'Official',value:route('text-a'),name:'Text A' },{group:'Official',value:route('vision-b'),name:'Vision B'},
  ] }]; }
  async start(){return {image:this.capability};}
  async locate(){return null;}
  async activate(sessionId:string|null,servers:Parameters<HarnessPort['activate']>[1]){this.calls.push({method:'activate',params:{sessionId,servers}});return {sessionId:this.id,options:this.options(),mcp:[]};}
  async configure(sessionId:string,id:string,value:string){
    this.calls.push({method:'configure',params:{sessionId,id,value}});this.configEntered.resolve();if(this.configGate)await this.configGate.promise;
    this.model=JSON.parse(value)[1];return this.options();
  }
  async models(){return this.options()[0]!.options.map(option=>({value:option.value,name:option.name,image:option.value===route('vision-b')}));}
  async activity():Promise<Activity>{return {revision:0,eligible:false,blockers:[{kind:'unknown'}]};}
  async suspend(){return {suspended:false,snapshot:await this.activity()};}
  async observe(){return structuredClone(this.observation);}
  async message(sessionId:string,requestId:string,content:InputPart[]){
    if(this.closed)throw new Error('Retired harness cannot admit input');
    const message={sessionId,requestId,content};this.calls.push({method:'message',params:message});this.inbox.push(message);
    if(isActivationPrompt(message)){this.complete();return {messageId:requestId};}
    this.messages.push(message);this.status='running';this.emit('status',{sessionId:this.id,status:this.status});this.signals.emit('message');return {messageId:requestId};
  }
  async interrupt(){this.complete('cancelled');}
  async closeSession(){this.complete('cancelled');}
  complete(stopReason = 'end_turn') {
    this.status = 'idle'; this.emit('status', { sessionId: this.id, status: 'idle' });
    for(const message of this.inbox.splice(0)){
      if(stopReason==='cancelled')this.emit('submission',{sessionId:this.id,requestId:message.requestId,state:'interrupted'});
      else{
        const seq=this.observation.cursor+1,event={type:'user/message',seq,time:1000+seq,data:{role:'user',source:{kind:'user',rpcId:message.requestId},content:message.content}};
        this.observation.events.push(event);this.observation.cursor=seq;
        this.emit('source',{sessionId:this.id,seq,type:event.type,event});this.emit('submission',{sessionId:this.id,requestId:message.requestId,state:'applied'});
      }
    }
  }
  async close() { if (this.closed) return; this.closed = true; this.complete('cancelled'); this.emit('exit'); }
  entered(count = 1) {
    if (this.messages.length >= count) return Promise.resolve();
    return new Promise<void>(resolve => { const check = () => { if (this.messages.length >= count) { this.signals.off('message', check); resolve(); } }; this.signals.on('message', check); });
  }
}

async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-adr006-agents-');
  const config = { ...await loadConfig(), ...overrides, stateRoot: root, model: 'text-a', verification: false };
  const tree = new ResearchTree(config); await tree.initialize();
  let serial = 0, launches = 0, admission = 0, nextCapability: boolean | undefined;
  const id = () => `60000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const project = await tree.createProject(globalThis.crypto.randomUUID(), 'Worker contracts'); const node = id(), otherNode = id();
  for (const nodeId of [node, otherNode]) await tree.mutate(project.id, { operationId: id(), revision: tree.graph(project.id).revision,
    command: { kind: 'node.create', id: nodeId, title: 'Synthetic node', description: '' } });
  const harnesses = new Map<string, SequenceHarness[]>();
  const factory: HarnessFactory = (settings, home, _workspace, _budget, permission) => {
    launches++; const key = basename(home); const harness = new SequenceHarness(`native-${key}`, (settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model), nextCapability ?? (settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model) === 'vision-b', permission);
    nextCapability = undefined;
    harnesses.set(key, [...harnesses.get(key) ?? [], harness]); return harness;
  };
  let agents = new AgentManager(config, tree, async () => { admission++; return false; }, factory);
  agents.on('failure', () => {});
  t.after(async () => { await agents.close(); await tree.close(); await rm(root, { recursive: true, force: true }); });
  const first = agents.create(project.id, node, id(), {title:'First'}), second = agents.create(project.id, node, id(), {title:'Second'});
  return { root, config, tree, id, project: project.id, node, otherNode, first, second, harnesses,
    get agents() { return agents; }, get launches() { return launches; }, get admission() { return admission; },
    view(worker = first.id) { return agents.list(project.id, node).find(value => value.id === worker)!; },
    harness(worker = first.id) { return harnesses.get(worker)!.at(-1)!; },
    capabilityOnNextLaunch(value: boolean) { nextCapability = value; },
    async reopen() { await agents.close(); agents = new AgentManager(config, tree, async () => { admission++; return false; }, factory); agents.on('failure', () => {}); },
    async vision(worker = first.id) { await activateWorker(agents,project.id,node,worker); await agents.configure(project.id, node, worker, 'model', route('vision-b')); },
  };
}

test('worker archival changes visibility while preserving active work, permissions, identities and restart state', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id);
  const prompt = { id: f.id(), text: 'Continue research' };
  await f.agents.submit(f.project, f.node, f.first.id, prompt); await f.harness().entered();
  f.harness().observation = { events: [{ type: 'tool/call', seq: 0, time: 1000, data: { callId: 'tool', name: 'research_tool', arguments: '{"purpose":"Inspect synthetic material"}' } }], cursor: 0, assistantStream: { revision: 0 } };
  const pending = f.harness().permission({ sessionId: f.harness().id, toolCall:{toolCallId:'tool',title:'research_tool',rawInput:{purpose:'Inspect synthetic material'}}, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
  await changedUntil(f.agents, () => f.view().permissions.length === 1);
  const before = f.view(); const archived = f.agents.archive(f.project, f.node, f.first.id, true);
  assert.equal(archived.archived, true); assert.equal(archived.state, 'running'); assert.equal(archived.harnessSessionId, before.harnessSessionId);
  assert.equal(archived.agentId, before.agentId); assert.equal(archived.permissions.length, 1); assert.equal(f.harness().closed, false);
  assert.equal(archived.permissions[0]!.title, 'research_tool'); assert.deepEqual(JSON.parse(archived.permissions[0]!.detail), { purpose: 'Inspect synthetic material' });
  assert.throws(() => f.agents.archive(f.project, f.otherNode, f.first.id, false), fault('WORKER_NOT_FOUND'));
  f.agents.permission(f.project, f.node, f.first.id, archived.permissions[0]!.id, 'allow'); assert.deepEqual(await pending, { outcome: 'selected', optionId: 'allow' });
  f.harness().complete(); await changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission)[0]?.state === 'applied');
  await f.reopen(); assert.equal(f.view().archived, true); assert.equal(f.view().submissions.filter(isExerciseSubmission)[0]?.state, 'applied');
  assert.equal(f.agents.archive(f.project, f.node, f.first.id, false).archived, false);
});

test('advertised model configuration is idle-only, recycles its process and renegotiates image capability', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id);
  const before = f.view(), old = f.harness();
  assert.equal(before.imageCapability, false); assert.equal(before.configOptions[0]?.options[0]?.group, 'Official');
  await assert.rejects(f.agents.configure(f.project, f.node, f.first.id, 'model', 'invented'), fault('MODEL_OPTION'));
  const updated = await f.agents.configure(f.project, f.node, f.first.id, 'model', route('vision-b'));
  assert.equal(updated.model, route('vision-b')); assert.equal(updated.imageCapability, true); assert.equal(updated.state, 'idle');
  assert.equal(old.closed, true); assert.notEqual(updated.processId, before.processId); assert.equal(updated.harnessSessionId, before.harnessSessionId);
  assert.equal(updated.agentId, before.agentId); assert.equal(f.launches, 2);
  await f.agents.submit(f.project, f.node, f.first.id, { id: f.id(), text: 'Working' }); await f.harness().entered();
  await assert.rejects(f.agents.configure(f.project, f.node, f.first.id, 'model', route('text-a')), fault('MODEL_BUSY'));
  f.harness().complete(); await changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission)[0]?.state === 'applied');
  await f.reopen(); assert.equal(f.view().model, route('vision-b')); assert.equal(f.view().state, 'inactive');
  const launches = f.launches; assert.equal((await f.agents.observe(f.project, f.node, f.second.id)).page, null); assert.equal(f.launches, launches);
});

test('image receipts are scoped, durable and idempotent, and ordered content reaches successive native messages exactly once', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.vision();
  const imageId = f.id(); const image = await f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'pixel.png', 'image/png', png);
  assert.deepEqual(await f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'pixel.png', 'image/png', png), image);
  await assert.rejects(f.agents.stageImage(f.project, f.node, f.second.id, imageId, 'pixel.png', 'image/png', png), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'renamed.png', 'image/png', png), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.agents.stageImage(f.project, f.otherNode, f.first.id, f.id(), 'pixel.png', 'image/png', png), fault('WORKER_NOT_FOUND'));
  await f.reopen(); assert.deepEqual(await f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'pixel.png', 'image/png', png), image);
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const submission = { id: f.id(), text: 'before after', content: [
    { type: 'text' as const, text: 'before' }, { type: 'image' as const, attachmentId: imageId }, { type: 'text' as const, text: 'after' },
  ] };
  await f.agents.submit(f.project, f.node, f.first.id, submission); await f.harness().entered();
  assert.deepEqual(f.harness().calls.find(c => c.method === 'message' && !isActivationPrompt(c.params))?.params, { requestId:submission.id, sessionId: f.harness().id, content: [
    { type: 'text', text: 'before' }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'after' },
  ] });
  await f.agents.submit(f.project, f.node, f.first.id, submission); assert.equal(f.harness().messages.length, 1);
  await assert.rejects(f.agents.submit(f.project, f.node, f.first.id, { ...submission, content: [...submission.content].reverse() }), fault('SUBMISSION_CONFLICT'));
  f.harness().complete(); await changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission)[0]?.state === 'applied');
  await f.agents.submit(f.project, f.node, f.first.id, { id: f.id(), text: '', content: [{ type: 'image', attachmentId: imageId }] });
  await f.harness().entered(2); await changedUntil(f.agents,()=>f.view().submissions.filter(isExerciseSubmission)[1]?.state==='admitted'); f.harness().complete();
  await changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission)[1]?.state === 'applied');
  assert.deepEqual(await f.tree.files(f.project, f.node), [], 'chat images never become node workspace files');
});

test('unsupported, foreign and invalid images fail before prompt admission', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id);
  const image = await f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'pixel.png', 'image/png', png);
  await assert.rejects(f.agents.submit(f.project, f.node, f.first.id, { id: f.id(), text: '', content: [{ type: 'image', attachmentId: image.id }] }), fault('IMAGE_UNSUPPORTED'));
  assert.equal(f.view().submissions.filter(isExerciseSubmission).length, 0); assert.equal(f.harness().messages.length, 0);
  await assert.rejects(f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'fake.png', 'image/png', Buffer.from('not an image')), fault('IMAGE_TYPE'));
  await f.vision(f.second.id);
  await assert.rejects(f.agents.submit(f.project, f.node, f.second.id, { id: f.id(), text: '', content: [{ type: 'image', attachmentId: image.id }] }), fault('IMAGE_NOT_FOUND'));
});

test('concurrent image retries acknowledge one durable ingress receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t), imageId = f.id();
  const results = await Promise.allSettled([0, 1].map(() => f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'pixel.png', 'image/png', png)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2, 'simultaneous retry must not expose temporary-file EEXIST');
  assert.deepEqual(results[0], results[1]);
});

test('concurrent image admission cannot exceed the shared retained-byte quota', { timeout: 5000 }, async t => {
  const f = await fixture(t, { maxStagedBytes: png.length });
  const results = await Promise.allSettled([f.first.id, f.second.id].map(worker => f.agents.stageImage(f.project, f.node, worker, f.id(), 'pixel.png', 'image/png', png)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && fault('STAGING_LIMIT')(rejected.reason));
});

test('shutdown drains accepted image staging and refuses new ingress before reopening', { timeout: 5000 }, async t => {
  const f = await fixture(t), imageId = f.id();
  const accepted = f.agents.stageImage(f.project, f.node, f.first.id, imageId, 'pixel.png', 'image/png', png);
  const reopening = f.reopen();
  await assert.rejects(f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'late.png', 'image/png', png), fault('SHUTTING_DOWN'));
  const [receipt] = await Promise.all([accepted, reopening]);
  assert.equal(receipt.id, imageId);
  assert.deepEqual((await f.agents.stagedImage(f.project, f.node, f.first.id, imageId)).bytes, png);
  assert.equal(f.launches, 0);
});

test('observation retains a stable authorized baseline and scopes source and stream notices to the correct worker', { timeout: 5000 }, async t => {
  const f = await fixture(t, { historyPageSize: 2 }); await activateWorker(f.agents,f.project,f.node,f.first.id);
  const events = Array.from({ length: 3 }, (_, seq) => ({ type: 'synthetic/event', seq, time: seq, data: { value: seq } }));
  f.harness().observation = { events, cursor: 2, assistantStream: { revision: 7 } };
  const observed: unknown[] = []; f.agents.on('observation', event => observed.push(event));
  const baseline = await f.agents.observe(f.project, f.node, f.first.id);
  assert.equal(baseline.cursor, 2); assert.equal(baseline.assistantStream.revision, 7); assert.equal(baseline.process, f.view().processId);
  assert.deepEqual(baseline.page?.events.map(e => e.seq), [1, 2]);
  f.harness().observation.events.push({ type: 'synthetic/event', seq: 3, time: 3, data: {} });
  assert.deepEqual((await f.agents.history(f.project, f.node, f.first.id, baseline.page!.cut, baseline.page!.before!)).events.map(e => e.seq), [0]);
  await assert.rejects(f.agents.history(f.project, f.node, f.second.id, baseline.page!.cut), fault('NO_HISTORY'));
  f.harness().emit('source', { sessionId: 'foreign', seq: 3, type: 'synthetic/event', event: events[0] });
  f.harness().emit('assistantStream', { sessionId: 'foreign', frame: { revision: 8 } }); assert.equal(observed.length, 0);
  f.harness().emit('source', { sessionId: f.harness().id, seq: 3, type: 'synthetic/event', event: events[0] });
  f.harness().emit('assistantStream', { sessionId: f.harness().id, frame: { revision: 8 } });
  assert.equal(observed.length, 2); assert.equal(f.admission, 0);
});

test('cold observation reads persisted media without launching an execution process', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id);
  await f.agents.closeWorker(f.project, f.node, f.first.id);
  await persistMedia(join(f.root, 'harness', f.first.id), f.view().harnessSessionId!);
  const launches = f.launches; const baseline = await f.agents.observe(f.project, f.node, f.first.id);
  assert.equal(baseline.process, null); assert.equal(baseline.page?.attachments.length, 2); assert.equal(f.view().state, 'closed');
  assert.equal(f.launches, launches); assert.equal(f.admission, 0);
});

test('active observation obeys the same configured source-event bound as cold reads', { timeout: 5000 }, async t => {
  const f = await fixture(t, { maxHistoryEvents: 2 }); await activateWorker(f.agents,f.project,f.node,f.first.id);
  f.harness().observation = { events: Array.from({ length: 3 }, (_, seq) => ({ type: 'synthetic/event', seq, time: seq, data: {} })), cursor: 2, assistantStream: { revision: 0 } };
  await assert.rejects(f.agents.observe(f.project, f.node, f.first.id), fault('HISTORY_LIMIT'));
});

test('retired process generations cannot emit observations into a reconfigured worker', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id); const retired = f.harness();
  await f.agents.configure(f.project, f.node, f.first.id, 'model', route('vision-b'));
  const notices: unknown[] = []; f.agents.on('observation', value => notices.push(value));
  retired.emit('assistantStream', { sessionId: retired.id, frame: { revision: 900 } });
  retired.emit('source', { sessionId: retired.id, seq: 900, type: 'synthetic/event', event: {seq:900,time:1000,type:'synthetic/event',data:{}} });
  assert.deepEqual(notices, []);
  retired.emit('status', { sessionId: retired.id, status: 'running' });
  assert.equal(f.view().state, 'idle', 'retired status cannot reacquire a lease or rewrite the active process state');
});

test('restarted connection capability is checked before delivering a previously staged image', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.vision();
  const image = await f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'pixel.png', 'image/png', png);
  await f.reopen(); f.capabilityOnNextLaunch(false);
  const submission = { id: f.id(), text: '', content: [{ type: 'image' as const, attachmentId: image.id }] };
  await f.agents.submit(f.project, f.node, f.first.id, submission);
  await changedUntil(f.agents, () => !['pending'].includes(f.view().submissions.filter(isExerciseSubmission)[0]?.state ?? 'pending'));
  await Promise.race([f.harness().entered(), changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission)[0]?.state === 'failed')]);
  assert.equal(f.view().imageCapability, false);
  assert.equal(f.harness().calls.filter(call => call.method === 'message' && !isActivationPrompt(call.params)).length, 0, 'stale cached capability must not admit images on a new text-only connection');
  assert.equal(f.view().submissions.filter(isExerciseSubmission)[0]?.state, 'failed');
});

test('retrying an image message while running preserves every part in the native inbox', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.vision();
  const image = await f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'pixel.png', 'image/png', png);
  await f.reopen(); f.capabilityOnNextLaunch(false);
  const input = {id:f.id(),text:'Inspect all parts',content:[
    {type:'text' as const,text:'Before image'}, {type:'image' as const,attachmentId:image.id}, {type:'text' as const,text:'After image'},
  ]};
  await f.agents.submit(f.project,f.node,f.first.id,input);
  await changedUntil(f.agents,()=>f.agents.submission(input.id).state==='failed');
  assert.equal(f.agents.submission(input.id).retryable,true,'Capability rejection precedes any prompt dispatch');
  await f.agents.configure(f.project,f.node,f.first.id,'model',route('vision-b'));
  assert.equal(f.view().imageCapability,true);
  const active = f.id();
  await f.agents.submit(f.project,f.node,f.first.id,{id:active,text:'A different running turn'});
  await f.harness().entered();
  f.agents.retry(f.project,f.node,f.first.id,input.id);
  await f.harness().entered(2);
  const delivered = f.harness().calls.find(call=>call.method==='message'&&(call.params as {requestId?:string}).requestId===input.id);
  assert.deepEqual(delivered?.params,{sessionId:f.harness().id,requestId:input.id,content:[
    {type:'text',text:'Before image'}, {type:'image',data:png.toString('base64'),mimeType:'image/png'}, {type:'text',text:'After image'},
  ]});
  f.harness().complete();await changedUntil(f.agents,()=>f.agents.submission(input.id).state==='applied');
});

test('interrupt cannot settle before an image prompt finishes its local admission phase', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.vision();
  const image = await f.agents.stageImage(f.project, f.node, f.first.id, f.id(), 'pixel.png', 'image/png', png);
  const prompt = { id: f.id(), text: '', content: [{ type: 'image' as const, attachmentId: image.id }] };
  await f.agents.submit(f.project, f.node, f.first.id, prompt);
  const interruption = { id: f.id(), kind: 'interrupt' as const, text: '' };
  await f.agents.submit(f.project, f.node, f.first.id, interruption);
  await changedUntil(f.agents, () => f.view().submissions.filter(isExerciseSubmission).find(s => s.id === interruption.id)?.state === 'completed');
  assert.ok(!['pending', 'admitted'].includes(f.view().submissions.filter(isExerciseSubmission).find(s => s.id === prompt.id)!.state), 'completed interrupt must cover locally preparing prompt admission');
});

test('a prompt cannot enter the old process while model configuration is pending', { timeout: 5000 }, async t => {
  const f = await fixture(t); await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness = f.harness(); harness.configGate = barrier<void>();
  const configuring = f.agents.configure(f.project, f.node, f.first.id, 'model', route('vision-b'));
  await harness.configEntered.promise;
  try {
    await assert.rejects(f.agents.submit(f.project, f.node, f.first.id, { id: f.id(), text: 'Must await model selection' }));
    assert.equal(harness.messages.length, 0); assert.equal(f.view().submissions.filter(isExerciseSubmission).length, 0);
  } finally { harness.configGate.resolve(); await configuring; }
});
