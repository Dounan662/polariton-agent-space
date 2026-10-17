import { execFileSync } from 'node:child_process';
import {owner} from '../src/caller.ts';
import {activateWorker,isActivationPrompt,isExerciseSubmission} from './fixtures/activation.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessFactory} from '../harness/contracts.ts';
import { ResearchTree } from '../src/research.ts';
import { loadConfig } from '../src/config.ts';
import { ControlledHarness } from './fixtures/harness.ts';
import { persistHistory } from './fixtures/history.mjs';
import { Context } from '@deepseek-ai/cordis';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { MessageId } from '@deepseek-ai/dsh-llm';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type { Config } from '../src/config.ts';

const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

/** Wait for an externally visible manager state, with no polling or fabricated timing. */
function changedUntil(agents: AgentManager, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise(resolve => {
    const changed = () => { if (ready()) { agents.off('change', changed); resolve(); } };
    agents.on('change', changed);
    changed();
  });
}

async function activeFixture(t: TestContext, options: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-agents-');
  const config = { ...await loadConfig(), ...options, stateRoot: root };
  const tree = new ResearchTree(config);
  await tree.initialize();
  let sequence = 0;
  const id = () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const project = await tree.createProject(globalThis.crypto.randomUUID(), 'Controlled execution');
  const node = id();
  await tree.mutate(project.id, { operationId: id(), revision: 0, command: { kind: 'node.create', id: node, title: 'Shared workspace', description: '' } });
  const harnesses = new Map<string, ControlledHarness>();
  const factory: HarnessFactory = (_config, home, _workspace, _budget, permission) => {
    const harness = new ControlledHarness(`harness-${basename(home)}`, permission);
    harnesses.set(basename(home), harness);
    return harness;
  };
  const agents = new AgentManager(config, tree, async () => false, factory);
  let agentsClosed = false;
  const failures: unknown[] = [];
  agents.on('failure', value => failures.push(value));
  t.after(async () => {
    for (const harness of harnesses.values()) { harness.autoClose = true; harness.exit(); }
    await new Promise(resolve => setImmediate(resolve));
    if (!agentsClosed) await agents.close(); await tree.close(); await rm(root, { recursive: true, force: true });
  });
  const first = agents.create(project.id, node, id(), {title:'First'});
  const second = agents.create(project.id, node, id(), {title:'Second'});
  const view = (worker: string) => agents.list(project.id, node).find(value => value.id === worker)!;
  const submit = (worker: string, kind: 'message' | 'interrupt', text = 'research task') => {
    const value = kind==='interrupt'?{id:id(),kind:'interrupt' as const,text}:{id:id(),text};
    return { value, promise: agents.submit(project.id, node, worker, value) };
  };
  return { root, config, tree, agents, project: project.id, node, id, first, second, harnesses, view, submit, failures,
    async shutdown() { await agents.close(); agentsClosed = true; },
  };
}

test('inactive worker identities persist independently and controls reject cross-node substitutions', async t => {
  const root = await temporaryDirectory('test-agents-');
  const config = { ...await loadConfig(), stateRoot: root };
  const tree = new ResearchTree(config);
  await tree.initialize();
  let calls = 0;
  const refuseProvider = async () => { calls++; return false; };
  let agents = new AgentManager(config, tree, refuseProvider);
  t.after(async () => { await agents.close(); await tree.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const id = () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const project = await tree.createProject(globalThis.crypto.randomUUID(), 'Workers');
  const first = id(), second = id();
  for (const node of [first, second]) await tree.mutate(project.id, {
    operationId: id(), revision: tree.graph(project.id).revision,
    command: { kind: 'node.create', id: node, title: 'Workspace', description: '' },
  });
  const a = agents.create(project.id, first, id(), {title:'First conversation'});
  const b = agents.create(project.id, first, id(), {title:'Second conversation'});
  assert.equal(a.state, 'inactive');
  assert.equal(a.harnessSessionId, null);
  assert.notEqual(a.agentId, b.agentId);
  assert.notEqual(a.assignmentId, b.assignmentId);
  assert.notEqual(a.id, a.agentId);
  assert.deepEqual(agents.create(project.id, first, a.id, {title:a.title}), a);
  assert.deepEqual(agents.list(project.id, first), [a, b]);
  assert.throws(() => agents.create(project.id, second, a.id, {title:a.title}), fault('WORKER_CONFLICT'));
  await assert.rejects(agents.history(project.id, second, a.id), fault('WORKER_NOT_FOUND'));
  await assert.rejects(agents.history(project.id, first, a.id), fault('NO_HISTORY'));
  await assert.rejects(agents.submit(project.id, second, a.id, { id: id(), text: 'must not route' }), fault('WORKER_NOT_FOUND'));
  await assert.rejects(agents.submit(project.id, first, a.id, {id:id(),kind:'interrupt',text:''}), fault('NOT_RUNNING'));
  assert.throws(() => agents.permission(project.id, first, a.id, id(), 'allow'), fault('PERMISSION_STALE'));
  await agents.close();
  agents = new AgentManager(config, tree, refuseProvider);
  assert.deepEqual(agents.list(project.id, first), [a, b]);
  assert.deepEqual(agents.list(project.id, second), []);
  assert.equal(calls, 0, 'identity and cold queries never request provider admission');
});

test('overlapping workers scope prompts, steering, permissions and interrupt, including duplicate requests', { timeout: 10000 }, async t => {
  const f = await activeFixture(t);
  await Promise.all([activateWorker(f.agents,f.project,f.node,f.first.id), activateWorker(f.agents,f.project,f.node,f.second.id)]);
  const first = f.harnesses.get(f.first.id)!, second = f.harnesses.get(f.second.id)!;
  const p1 = f.submit(f.first.id, 'message'), p2 = f.submit(f.second.id, 'message');
  await Promise.all([p1.promise, p2.promise, first.promptEntered.promise, second.promptEntered.promise]);
  assert.equal(f.view(f.first.id).state, 'running');
  assert.equal(f.view(f.second.id).state, 'running');
  const workspace = f.tree.workspace(f.project, f.node);
  await writeFile(join(workspace, 'first-draft.txt'), 'Unfinished first contribution');
  await writeFile(join(workspace, 'second-draft.txt'), 'Unfinished second contribution');
  const publisher = {kind:'worker' as const,id:f.first.id,processId:f.view(f.first.id).processId!};
  const sharedCheckpoint = await f.tree.checkpoint(f.project, f.node, f.id(), {publisher});
  assert.deepEqual(execFileSync('git',['-C',workspace,'ls-tree','-r','--name-only',sharedCheckpoint.commit],{encoding:'utf8'}).trim().split('\n'), ['first-draft.txt', 'second-draft.txt']);
  assert.deepEqual(sharedCheckpoint.publisher, publisher);
  assert.equal(f.view(f.first.id).state, 'running');
  assert.equal(f.view(f.second.id).state, 'running');
  await f.agents.submit(f.project, f.node, f.first.id, p1.value);
  assert.equal(first.calls.filter(call => call.method === 'message' && !isActivationPrompt(call.params)).length, 1);
  await assert.rejects(f.agents.submit(f.project, f.node, f.first.id, { ...p1.value, text: 'different retry' }), fault('SUBMISSION_CONFLICT'));
  const steering = f.submit(f.first.id, 'message', 'change direction');
  await steering.promise;
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === steering.value.id)?.state === 'admitted');
  assert.equal(first.calls.filter(call => call.method === 'message'&&!isActivationPrompt(call.params)).length, 2);
  assert.equal(second.calls.filter(call => call.method === 'message'&&!isActivationPrompt(call.params)).length, 1);
  const decision = first.askPermission('tool-first');
  await changedUntil(f.agents, () => f.view(f.first.id).permissions.length === 1);
  const permission = f.view(f.first.id).permissions[0]!;
  assert.equal(permission.title, 'synthetic_tool');
  assert.deepEqual(JSON.parse(permission.detail), { purpose: 'Review tool-first' });
  assert.equal(f.view(f.second.id).permissions.length, 0);
  assert.throws(() => f.agents.permission(f.project, f.node, f.second.id, permission.id, 'allow-once'), fault('PERMISSION_STALE'));
  f.agents.permission(f.project, f.node, f.first.id, permission.id, 'allow-once');
  assert.deepEqual(await decision, { outcome: 'selected', optionId: 'allow-once' });
  assert.throws(() => f.agents.permission(f.project, f.node, f.first.id, permission.id, 'allow-once'), fault('PERMISSION_STALE'));
  const cancelledPermission = first.askPermission('tool-cancelled');
  const interrupt = f.submit(f.first.id, 'interrupt', '');
  await interrupt.promise;
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === interrupt.value.id)?.state === 'completed');
  assert.deepEqual(await cancelledPermission, { outcome: 'cancelled' });
  assert.equal(second.calls.filter(call => call.method === 'interrupt').length, 0);
  assert.equal(f.view(f.second.id).state, 'running');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
  second.complete();
  await changedUntil(f.agents, () => f.view(f.second.id).submissions.filter(isExerciseSubmission).find(value => value.id === p2.value.id)?.state === 'applied');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
});

test('prompt transport failure preserves lifecycle uncertainty without blocking checkpoint capture', { timeout: 10000 }, async t => {
  const f = await activeFixture(t);
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness = f.harnesses.get(f.first.id)!;
  harness.autoClose = false;
  const prompt = f.submit(f.first.id, 'message');
  await prompt.promise;
  await harness.promptEntered.promise;
  harness.emit('transportError',new Error('Simulated transport failure'));
  await harness.closeEntered.promise;
  assert.equal(f.view(f.first.id).state, 'uncertain');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
  harness.exit();
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === prompt.value.id)?.state === 'uncertain');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
  await assert.rejects(f.submit(f.first.id, 'message').promise, fault('RESUME_REQUIRED'));
});

test('a transport failure stops only its worker and resolves all unsettled receipts honestly', { timeout: 10000 }, async t => {
  const f = await activeFixture(t);
  await Promise.all([activateWorker(f.agents,f.project,f.node,f.first.id), activateWorker(f.agents,f.project,f.node,f.second.id)]);
  const first = f.harnesses.get(f.first.id)!, second = f.harnesses.get(f.second.id)!;
  first.autoClose = false;
  const p1 = f.submit(f.first.id, 'message'), p2 = f.submit(f.second.id, 'message');
  await Promise.all([p1.promise, p2.promise, first.promptEntered.promise, second.promptEntered.promise]);
  const steering = f.submit(f.first.id, 'message');
  await steering.promise;
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === steering.value.id)?.state === 'admitted');
  first.emit('transportError', new Error('Control pipe failed'));
  await first.closeEntered.promise;
  assert.equal(f.view(f.first.id).state, 'uncertain');
  assert.equal(f.view(f.second.id).state, 'running');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
  first.exit();
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).every(value => value.state === 'uncertain'));
  assert.equal(f.view(f.second.id).submissions.filter(isExerciseSubmission).find(value => value.id === p2.value.id)?.state, 'admitted');
  second.complete();
  await changedUntil(f.agents, () => f.view(f.second.id).submissions.filter(isExerciseSubmission).find(value => value.id === p2.value.id)?.state === 'applied');
});

test('interrupt waits for the native cancellation barrier despite an idle observation', { timeout: 10000 }, async t => {
  const f = await activeFixture(t);
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness = f.harnesses.get(f.first.id)!;
  harness.promptStillAdmitting = true;
  harness.settleCancellation = false;
  const prompt = f.submit(f.first.id, 'message');
  await prompt.promise;
  await harness.promptEntered.promise;
  const interrupt = f.submit(f.first.id, 'interrupt', '');
  await interrupt.promise;
  // Drain currently runnable delivery work; no clock or elapsed-time assumption is involved.
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === interrupt.value.id)?.state, 'completed',
    'idle on another control pipe is not an acknowledgment of cancellation');
  await f.tree.checkpoint(f.project, f.node, f.id(), {publisher:owner});
  harness.complete('cancelled');
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === interrupt.value.id)?.state === 'completed');
});

test('historical pages use a stable authorized source cut across later persisted appends', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { historyPageSize: 3 });
  await Promise.all([activateWorker(f.agents,f.project,f.node,f.first.id), activateWorker(f.agents,f.project,f.node,f.second.id)]);
  const sessionId = f.view(f.first.id).harnessSessionId!;
  const secondSessionId = f.view(f.second.id).harnessSessionId!;
  await Promise.all([f.agents.closeWorker(f.project, f.node, f.first.id), f.agents.closeWorker(f.project, f.node, f.second.id)]);
  const root = join(f.root, 'harness', f.first.id, 'sessions');
  const fixture = await persistHistory(root, sessionId);
  await persistHistory(join(f.root, 'harness', f.second.id, 'sessions'), secondSessionId);
  const lastPage = await f.agents.history(f.project, f.node, f.first.id);
  assert.equal(lastPage.total, fixture.events.length);
  assert.equal(lastPage.coverage, 'readable-persisted-prefix');
  await assert.rejects(f.agents.history(f.project, f.node, f.second.id, lastPage.cut), fault('HISTORY_CUT_EXPIRED'));
  await assert.rejects(f.agents.history(f.project, f.node, f.first.id, lastPage.cut, fixture.events.length + 1), fault('INVALID_CURSOR'));
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root });
    const writer = await ctx.sessionPersistence.open(SessionId(sessionId), 'write');
    try {
      const seq = fixture.events.length;
      const time = fixture.events.at(-1)!.time + 1;
      await writer.append([
        { type: 'step/end', seq: SessionSeq(seq), time, data: { turn: 2, step: 1 } },
        { type: 'turn/end', seq: SessionSeq(seq + 1), time: time + 1, data: { turn: 2, reason: { kind: 'completed' } } },
      ]);
      await writer.flush();
    } finally { await writer.close(); }
  } finally { await ctx.fiber.dispose(); }
  const rebuilt = [...lastPage.events];
  let before = lastPage.before;
  while (before !== null) {
    const page = await f.agents.history(f.project, f.node, f.first.id, lastPage.cut, before);
    assert.equal(page.total, fixture.events.length);
    rebuilt.unshift(...page.events);
    before = page.before;
  }
  assert.deepEqual(rebuilt, fixture.events);
  assert.deepEqual(await f.agents.history(f.project, f.node, f.first.id, lastPage.cut), lastPage);
  const fresh = await f.agents.history(f.project, f.node, f.first.id);
  assert.equal(fresh.total, fixture.events.length + 2);
  assert.notEqual(fresh.cut, lastPage.cut);
  assert.equal(f.view(f.first.id).state, 'closed');
  assert.equal(f.harnesses.size, 2, 'reading history does not create any new harness');
});

test('cold reader capacity rejects overlap, preserves responsive controls and returns capacity after completion', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { maxHistoryReaders: 1 });
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  await f.agents.closeWorker(f.project, f.node, f.first.id);
  const fixture = await persistHistory(join(f.root, 'harness', f.first.id, 'sessions'), f.view(f.first.id).harnessSessionId!);
  const first = f.agents.history(f.project, f.node, f.first.id);
  await assert.rejects(f.agents.history(f.project, f.node, f.first.id), fault('HISTORY_BUSY'));
  assert.equal(f.agents.list(f.project, f.node).length, 2, 'source work cannot block unrelated worker inspection');
  assert.equal((await first).total, fixture.events.length);
  assert.equal((await f.agents.history(f.project, f.node, f.first.id)).total, fixture.events.length);
  assert.equal(f.harnesses.size, 1, 'cold workers never activate an execution harness');
});

test('cold reader deadline terminates the read and permits a fresh successful read', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { maxHistoryReaders: 1 });
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  await f.agents.closeWorker(f.project, f.node, f.first.id);
  const fixture = await persistHistory(join(f.root, 'harness', f.first.id, 'sessions'), f.view(f.first.id).harnessSessionId!);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const timedOut = assert.rejects(f.agents.history(f.project, f.node, f.first.id), fault('HISTORY_TIMEOUT'));
    t.mock.timers.tick(f.config.requestTimeoutMs);
    await timedOut;
  } finally { t.mock.timers.reset(); }
  assert.equal((await f.agents.history(f.project, f.node, f.first.id)).total, fixture.events.length);
  assert.equal(f.view(f.first.id).state, 'closed');
});

test('cold history limits fail explicitly without caching a truncated successful source cut', { timeout: 10000 }, async t => {
  for (const [name, limits] of [
    ['event count', { maxHistoryEvents: 9, historyPageSize: 3 }],
    ['decoded byte count', { maxFrameBytes: 100 }],
  ] as const) {
    await t.test(name, async inner => {
      const f = await activeFixture(inner, { ...limits, maxHistoryReaders: 1 });
      await activateWorker(f.agents,f.project,f.node,f.first.id);
      await f.agents.closeWorker(f.project, f.node, f.first.id);
      await persistHistory(join(f.root, 'harness', f.first.id, 'sessions'), f.view(f.first.id).harnessSessionId!);
      await assert.rejects(f.agents.history(f.project, f.node, f.first.id), fault('HISTORY_LIMIT'));
      await assert.rejects(f.agents.history(f.project, f.node, f.first.id), fault('HISTORY_LIMIT'));
      assert.equal(f.view(f.first.id).state, 'closed');
    });
  }
});

test('a source exactly at the configured event limit remains readable across worker pages', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { maxHistoryEvents: 10, historyPageSize: 3 });
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  await f.agents.closeWorker(f.project, f.node, f.first.id);
  const fixture = await persistHistory(join(f.root, 'harness', f.first.id, 'sessions'), f.view(f.first.id).harnessSessionId!);
  assert.equal(fixture.events.length, f.config.maxHistoryEvents);
  const page = await f.agents.history(f.project, f.node, f.first.id);
  assert.equal(page.total, fixture.events.length);
  assert.deepEqual(page.events, fixture.events.slice(-f.config.historyPageSize));
});

test('permission deadlines cancel only the pending request and old replies cannot authorize a later one', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { permissionTimeoutMs: 100 });
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness = f.harnesses.get(f.first.id)!;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = harness.askPermission('first-tool');
    await changedUntil(f.agents, () => f.view(f.first.id).permissions.length === 1);
    const expired = f.view(f.first.id).permissions[0]!;
    t.mock.timers.tick(f.config.permissionTimeoutMs);
    assert.deepEqual(await first, { outcome: 'cancelled' });
    assert.equal(f.view(f.first.id).permissions.length, 0);
    const second = harness.askPermission('later-tool');
    await changedUntil(f.agents, () => f.view(f.first.id).permissions.length === 1);
    const current = f.view(f.first.id).permissions[0]!;
    assert.notEqual(current.id, expired.id);
    assert.throws(() => f.agents.permission(f.project, f.node, f.first.id, expired.id, 'allow-once'), fault('PERMISSION_STALE'));
    f.agents.permission(f.project, f.node, f.first.id, current.id, 'reject-once');
    assert.deepEqual(await second, { outcome: 'selected', optionId: 'reject-once' });
  } finally { t.mock.timers.reset(); }
});

test('configured process capacity admits concurrent workers and is returned by a scoped close', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { maxActiveWorkers: 2 });
  const third = f.agents.create(f.project, f.node, f.id(), {title:'Third'});
  await Promise.all([activateWorker(f.agents,f.project,f.node,f.first.id), activateWorker(f.agents,f.project,f.node,f.second.id)]);
  await assert.rejects(activateWorker(f.agents,f.project,f.node,third.id), /Close an idle worker/);
  await f.agents.closeWorker(f.project, f.node, f.first.id);
  assert.equal(f.harnesses.get(f.second.id)!.exited, false);
  await activateWorker(f.agents,f.project,f.node,third.id);
  assert.equal(f.view(f.second.id).state, 'idle');
  assert.equal(f.view(third.id).state, 'idle');
});

test('graceful shutdown rejects new activation, settles permission waiters and waits for actual harness exit', { timeout: 10000 }, async t => {
  const f = await activeFixture(t);
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness = f.harnesses.get(f.first.id)!;
  harness.autoClose = false;
  const prompt = f.submit(f.first.id, 'message');
  await prompt.promise; await harness.promptEntered.promise;
  const permission = harness.askPermission('shutdown-tool');
  await changedUntil(f.agents, () => f.view(f.first.id).permissions.length === 1);
  let closed = false;
  const shutdown = f.shutdown().then(() => { closed = true; });
  await harness.closeEntered.promise;
  assert.deepEqual(await permission, { outcome: 'cancelled' });
  assert.equal(closed, false, 'shutdown must retain ownership until the process exits');
  await assert.rejects(f.agents.resume(f.project,f.node,f.second.id), fault('SHUTTING_DOWN'));
  harness.exit(); await shutdown;
  const reopened = new AgentManager(f.config, f.tree, async () => { throw new Error('Recovery must not request a provider'); });
  try {
    const worker = reopened.list(f.project, f.node).find(value => value.id === f.first.id)!;
    assert.equal(worker.state, 'inactive');
    assert.equal(worker.submissions.filter(isExerciseSubmission).find(value => value.id === prompt.value.id)?.state, 'uncertain');
    assert.deepEqual(worker.permissions, []);
  } finally { await reopened.close(); }
});

test('scoped close retains process capacity until exit and reconciles unsettled steering', { timeout: 10000 }, async t => {
  const f = await activeFixture(t, { maxActiveWorkers: 2 });
  const third = f.agents.create(f.project, f.node, f.id(), {title:'Waiting worker'});
  await Promise.all([activateWorker(f.agents,f.project,f.node,f.first.id), activateWorker(f.agents,f.project,f.node,f.second.id)]);
  const harness = f.harnesses.get(f.first.id)!;
  const prompt = f.submit(f.first.id, 'message');
  await prompt.promise; await harness.promptEntered.promise;
  const steer = f.submit(f.first.id, 'message', 'follow-up not yet applied');
  await steer.promise;
  await changedUntil(f.agents, () => f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === steer.value.id)?.state === 'admitted');
  harness.autoClose = false;
  const closing = f.agents.closeWorker(f.project, f.node, f.first.id);
  await harness.closeEntered.promise;
  try { await assert.rejects(activateWorker(f.agents,f.project,f.node,third.id), /Close an idle worker/); }
  finally { harness.exit(); await closing; }
  assert.equal(f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === steer.value.id)?.state, 'uncertain');
  const sessionId = f.view(f.first.id).harnessSessionId!;
  const root = join(f.root, 'harness', f.first.id, 'sessions');
  const persisted = await persistHistory(root, sessionId);
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root });
    const writer = await ctx.sessionPersistence.open(SessionId(sessionId), 'write');
    try {
      await writer.append([{ type: 'user/message', seq: SessionSeq(persisted.events.length), time: persisted.events.at(-1)!.time + 1,
        data: { id: MessageId(f.id()), role: 'user', source: { kind: 'user', rpcId: steer.value.id as SessionRequestId }, content: [{ type: 'text', text: steer.value.text }] }, surfaceOp: 'append' }]);
      await writer.flush();
    } finally { await writer.close(); }
  } finally { await ctx.fiber.dispose(); }
  await f.agents.history(f.project, f.node, f.first.id);
  const reconciled = f.view(f.first.id).submissions.filter(isExerciseSubmission).find(value => value.id === steer.value.id)!;
  assert.equal(reconciled.state, 'applied');
  assert.equal(reconciled.detail, undefined, 'authoritative application removes obsolete uncertainty text');
  await activateWorker(f.agents,f.project,f.node,third.id);
});

test('node activity includes empty nodes and archived lifecycle counts without activating workers', async t=>{
  const f=await activeFixture(t),empty=f.id();
  await f.tree.mutate(f.project,{operationId:f.id(),revision:f.tree.graph(f.project).revision,command:{kind:'node.create',id:empty,title:'Empty',description:''}});
  const foreign=await f.tree.createProject(globalThis.crypto.randomUUID(),'Other project');
  assert.deepEqual(f.agents.activity(foreign.id),[]);
  const summary=()=>f.agents.activity(f.project).find(value=>value.nodeId===f.node)!;
  assert.equal(summary().total,2);assert.equal(summary().states.inactive,2);
  assert.equal(f.agents.activity(f.project).find(value=>value.nodeId===empty)!.total,0);
  assert.equal(f.harnesses.size,0,'read-only summaries must not activate a worker');
  await activateWorker(f.agents,f.project,f.node,f.first.id);
  const harness=f.harnesses.get(f.first.id)!;
  const submission=f.submit(f.first.id,'message');await submission.promise;await harness.promptEntered.promise;
  f.agents.archive(f.project,f.node,f.first.id,true);
  const decision=harness.askPermission('summary-permission');
  await changedUntil(f.agents,()=>summary().permissions===1);
  assert.equal(summary().total,2);assert.equal(summary().archived,1);
  assert.equal(summary().states.running,1);assert.equal(summary().states.inactive,1);assert.equal(summary().active,1);
  assert.equal(Object.values(summary().states).reduce((sum,count)=>sum+count,0),summary().total);
  const permission=f.view(f.first.id).permissions[0]!;
  f.agents.permission(f.project,f.node,f.first.id,permission.id,'reject-once');await decision;
  harness.complete();await changedUntil(f.agents,()=>summary().states.idle===1);
  assert.equal(summary().active,0);assert.equal(summary().permissions,0);assert.equal(summary().archived,1);
});

for(const resolution of ['applied','discarded'] as const)test(`lost interrupt preserves uncertain in-flight delivery until native ${resolution} evidence`,{timeout:10000},async t=>{
 const f=await activeFixture(t);await activateWorker(f.agents,f.project,f.node,f.first.id);
 const harness=f.harnesses.get(f.first.id)!,dispatch=harness.message.bind(harness);
 let release!:()=>void;const acknowledgement=new Promise<void>(resolve=>{release=resolve;});
 harness.interrupt=async()=>{throw new Error('Cancellation acknowledgement was lost');};
 harness.message=async(...args)=>{
  await dispatch(...args);await acknowledgement;throw new Error('Message acknowledgement was lost');
 };
 const message=f.submit(f.first.id,'message');await message.promise;await harness.promptEntered.promise;
 assert.equal(f.agents.submission(message.value.id).state,'pending');
 assert.equal(f.agents.submission(message.value.id).retryable,false,'Message has crossed the native dispatch boundary');
 const queued=f.submit(f.first.id,'message','Still waiting locally');await queued.promise;
 const interrupt=f.submit(f.first.id,'interrupt','');await interrupt.promise;
 await changedUntil(f.agents,()=>f.agents.submission(interrupt.value.id).state==='uncertain');
 assert.equal(f.agents.submission(message.value.id).state,'uncertain');
 assert.equal(f.agents.submission(queued.value.id).state,'interrupted','Only undispatched input can be locally canceled');
 assert.equal(f.view(f.first.id).state,'interrupting');
 await f.tree.checkpoint(f.project,f.node,f.id(), {publisher:owner});
 release();
 harness.complete(resolution==='applied'?'end_turn':'cancelled');
 await changedUntil(f.agents,()=>f.agents.submission(message.value.id).state===(resolution==='applied'?'applied':'interrupted'));
 assert.equal(f.agents.submission(message.value.id).retryable,false);
 assert.equal(f.view(f.first.id).submissions[0]!.state,'applied','Cancellation must preserve earlier application receipts');
});
