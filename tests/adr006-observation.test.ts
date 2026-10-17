import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream';
import type { SessionAssistantStreamFrame, SessionAssistantStreamBaseline } from '@deepseek-ai/dsh-api-session-controller';
import { SourceObservation as WorkerObservation } from '../web/src/native/observation.ts';
import type { ChatSnapshot } from '../web/src/native/client/ui-chat/src/client/contract/snapshot.ts';
import type { TrajectorySnapshot } from '../web/src/native/client/ui-trajectory/src/client/trajectory-contract.ts';
import type { HistoryEvent, HistoryPage } from '../src/contracts.ts';

const scope = { project: 'project', node: 'node', workerId: 'worker' };
const attemptId = LlmAttemptId('synthetic-attempt');
const event = (seq: number, type: string, data: unknown, surfaceOp?: unknown): HistoryEvent => ({ seq, time: 1000 + seq, type, data, ...(surfaceOp ? { surfaceOp } : {}) });
const user = (seq: number, text: string) => event(seq, 'user/message', { id: `user-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, 'append');
const opening = () => [event(0, 'turn/start', { turn: 1 }), user(1, 'Synthetic question'), event(2, 'step/start', { turn: 1, step: 1 })];
const answer = (seq = 3, text = 'Durable answer') => event(seq, 'assistant/message', {
  turn: 1, step: 1, stream: [], message: { id: 'answer-1', role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture' }, content: [{ type: 'text', text }] },
}, 'append');
const page = (events: HistoryEvent[], before: number | null = null): HistoryPage => ({
  kind: 'persisted', formatVersion: 1, sourceSessionId: 'native-worker', attachments: [], events,
  cut: 'synthetic-cut', before, coverage: 'readable-persisted-prefix', total: (events.at(-1)?.seq ?? -1) + 1,
});
function fixture(maxEvents = 100) {
  const paints = new Set<() => void>();
  const paint = () => { for (const callback of [...paints]) { paints.delete(callback); callback(); } };
  let repairs = 0; const observation = new WorkerObservation(scope, () => { repairs++; }, maxEvents, callback => { paints.add(callback); return () => { paints.delete(callback); }; });
  return { observation, paint, get pendingPaints() { return paints.size; }, get repairs() { return repairs; },
    baseline(events = opening(), generation = 'generation-1', assistantStream: SessionAssistantStreamBaseline = { revision: 0 }, before: number | null = null) {
      observation.snapshot({ generation, page: page(events, before), assistantStream });
    },
    durable(sequence: number, value: HistoryEvent, generation = 'generation-1') { observation.accept({ generation, sequence, kind: 'event', event: value }); },
    frame(sequence: number, frame: SessionAssistantStreamFrame, generation = 'generation-1') { observation.accept({ generation, sequence, kind: 'assistant-stream', frame }); },
    chat() { paint(); return observation.engine.snapshot('chat') as ChatSnapshot; },
    trajectory() { paint(); return observation.engine.snapshot('trajectory') as TrajectorySnapshot; },
  };
}
const start: SessionAssistantStreamFrame = { type: 'start', attemptId, revision: 1, startedAfterSeq: SessionSeq(2), turn: 1, step: 1 };
const chunk = (revision: number, index: number, text: string): SessionAssistantStreamFrame => ({ type: 'chunk', attemptId, revision, index, time: 2000 + index, chunk: { type: 'text-delta', index: 0, text } });
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
/** The browser's public fetch boundary is held explicitly; no network or clock controls ordering. */
function historyFetch(t: TestContext) {
  const calls: { path: string; response: ReturnType<typeof barrier<Response>> }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    const response = barrier<Response>(); calls.push({ path, response }); return response.promise;
  });
  return { calls, respond(index: number, body: HistoryPage, status = 200) { calls[index]!.response.resolve(Response.json(body, { status })); } };
}
function changedUntil(observation: WorkerObservation, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  return new Promise<void>(resolve => { const unsubscribe = observation.subscribe(() => { if (ready()) { unsubscribe(); resolve(); } }); });
}
const source = () => [...opening(), answer(), event(4, 'step/end', { turn: 1, step: 1 }),
  event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(6, 'turn/start', { turn: 2 }), user(7, 'Current question')];
const cutPage = (events: HistoryEvent[], before: number | null, cut = 'new-cut') => ({ ...page(events, before), cut, total: 8 });

test('native chat and trajectory project one durable assistant settlement after its streamed prefix', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Live prefix'));
  assert.equal(f.chat().legacy.partial?.blocks[0]?.kind, 'text');
  assert.equal(f.trajectory().partial?.blocks[0]?.kind, 'text');
  f.durable(3, answer());
  assert.deepEqual(f.observation.inspectSource()!.events,[...opening(),answer()],'Raw evidence includes committed source before transient presentation settlement');
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 0, 'durable settlement waits for its matching terminal frame');
  f.frame(4, { type: 'end', attemptId, revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } });
  assert.equal(f.chat().legacy.partial, null); assert.equal(f.trajectory().partial, null);
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
  assert.equal(f.trajectory().eventNodes.filter(node => node.kind === 'assistant').length, 1);
  assert.equal(f.repairs, 0);
  f.durable(5, answer());
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1, 'durable replay cannot duplicate settled content');
});

test('abandonment removes only its live attempt and preserves durable conversation evidence', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Discarded live fragment'));
  assert.ok(f.chat().legacy.partial);
  f.frame(3, { type: 'end', attemptId, revision: 3, index: 1, outcome: { kind: 'abandoned' } });
  assert.equal(f.chat().legacy.partial, null); assert.equal(f.trajectory().partial, null);
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'user').length, 1); assert.equal(f.repairs, 0);
});

// A failed attempt is durable evidence, but its unfinished output is not a
// committed assistant message. Empty and partially displayed attempts must both
// settle without losing the reader or promoting their fragments to answers.
for (const painted of [false, true]) for (const text of ['', 'Unfinished answer']) {
  test(`failed assistant settlement preserves the reader (painted=${painted}, text=${Boolean(text)})`, () => {
    const f = fixture(); f.baseline(); f.frame(1, start);
    f.frame(2, chunk(2, 0, text));
    if (painted) { f.paint(); assert.equal(Boolean(f.chat().legacy.partial), Boolean(text)); }
    const failure = { message: 'Provider connection lost', code: 'TRANSPORT' };
    const stream = new AssistantStreamAccumulator();
    stream.push({ time: 2000, chunk: { type: 'text-delta', index: 0, text } });
    stream.push({ time: 2001, chunk: { type: 'finish', reason: { kind: 'error', failure } } });
    const attempt = event(3, 'assistant/attempt', { turn: 1, step: 1, stream: stream.snapshot() });
    const end: SessionAssistantStreamFrame = { type: 'end', attemptId, revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 3 } };
    f.durable(3, attempt); f.frame(4, end);
    assert.equal(f.chat().legacy.partial, null);
    assert.equal(f.chat().legacy.nodes.some(node => node.kind === 'assistant'), false);
    assert.equal(f.chat().order.some(key => ['assistant-step', 'turn-process'].includes(f.chat().nodes.get(key)!.kind)), false);
    for (const key of f.chat().order) assert.equal(f.chat().nodes.processSource(key).getSnapshot(), undefined);
    const stepEnd = event(4, 'step/end', { turn: 1, step: 1 });
    const turnEnd = event(5, 'turn/end', { turn: 1, reason: { kind: 'error', error: failure } });
    f.durable(5, stepEnd); f.durable(6, turnEnd);
    assert.equal(f.observation.status, 'ready'); assert.equal(f.observation.error, '');
    assert.equal(f.repairs, 0);
    assert.ok(f.chat().legacy.nodes.some(node => node.kind === 'turn-error' && node.message === failure.message));
    const events = [...opening(), attempt, stepEnd, turnEnd];
    assert.deepEqual(f.observation.inspectSource()!.events, events);
    const visible = structuredClone(f.chat().legacy.nodes);
    f.baseline(events, 'reopened');
    assert.deepEqual(f.chat().legacy.nodes, visible, 'reopening preserves the visible transcript');
    f.observation.dispose();
  });
}

test('a failed assistant attempt can retry in the same step without stale output or duplicate answers', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Failed prefix'));
  const row = f.chat().nodes.values().find(node => node.kind === 'assistant-step'); assert.ok(row);
  f.durable(3, event(3, 'assistant/attempt', { turn: 1, step: 1, stream: [] }));
  f.frame(4, { type: 'end', attemptId, revision: 3, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 3 } });
  assert.equal(f.chat().nodes.get(row.key)?.visibility, 'hidden');
  f.durable(5, event(4, 'llm/retry', { turn: 1, step: 1, retryId: 'retry-chain', provider: 'synthetic',
    policyKey: 'fixture', retry: 1, maxRetries: 1, delayMs: 0, message: 'Connection lost', code: 'TRANSPORT' }));
  f.durable(6, event(5, 'llm/retry-started', { turn: 1, step: 1, retryId: 'retry-chain', retry: 1 }));
  const nextAttempt = LlmAttemptId('retry-attempt');
  f.frame(7, { ...start, attemptId: nextAttempt, revision: 4, startedAfterSeq: SessionSeq(5) });
  f.frame(8, { ...chunk(5, 0, 'Recovered answer'), attemptId: nextAttempt });
  assert.deepEqual(f.chat().legacy.partial?.blocks, [{ kind: 'text', text: 'Recovered answer' }]);
  assert.equal(f.chat().nodes.get(row.key)?.visibility, 'visible');
  f.durable(9, answer(6, 'Recovered answer'));
  f.frame(10, { type: 'end', attemptId: nextAttempt, revision: 6, index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 } });
  assert.equal(f.chat().legacy.partial, null);
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
  assert.equal(f.observation.error, ''); assert.equal(f.repairs, 0);
  f.observation.dispose();
});

test('a reconnect baseline reconstructs accumulated native stream chunks before accepting its next index', () => {
  const f = fixture(); const accumulator = new AssistantStreamAccumulator();
  accumulator.push({ time: 2000, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } });
  f.baseline(opening(), 'generation-2', { revision: 8, activeAttempt: {
    attemptId, startedAfterSeq: SessionSeq(2), turn: 1, step: 1, nextIndex: 1, stream: accumulator.snapshot() as never,
  } });
  f.frame(1, chunk(9, 1, 'again'), 'generation-2');
  const partial = f.chat().legacy.partial;
  assert.deepEqual(partial?.blocks, [{ kind: 'text', text: 'Hello again' }]); assert.equal(f.repairs, 0);
});

test('duplicate envelopes are idempotent and conflicting durable repetitions request a fresh baseline', () => {
  const f = fixture(); f.baseline(); const before = f.observation.getSnapshot();
  f.durable(1, answer()); const after = f.observation.getSnapshot(); assert.ok(after > before);
  f.durable(1, answer()); assert.equal(f.observation.getSnapshot(), after);
  f.durable(2, answer()); assert.equal(f.observation.getSnapshot(), after); assert.equal(f.repairs, 0);
  const projected = structuredClone({ chat: f.chat().legacy.nodes, trajectory: f.trajectory().eventNodes });
  f.durable(3, answer(3, 'Conflicting bytes'));
  assert.equal(f.repairs, 1); assert.deepEqual({ chat: f.chat().legacy.nodes, trajectory: f.trajectory().eventNodes }, projected);
});

test('a contradictory replay of the same transport sequence requests repair', () => {
  const f = fixture(); f.baseline(); f.durable(1, answer());
  f.durable(1, answer(3, 'Conflicting replay at the same sequence'));
  assert.equal(f.repairs, 1);
});

test('a contradictory stream revision cannot be hidden behind a newer transport envelope', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Original prefix'));
  f.frame(3, chunk(2, 0, 'Contradictory prefix at the same revision'));
  assert.equal(f.repairs, 1);
});

test('transport, durable sequence and stream revision gaps never publish their ungrounded suffix', () => {
  for (const gap of ['transport', 'durable', 'revision', 'chunk-index'] as const) {
    const f = fixture(); f.baseline(); const projected = structuredClone({ chat: f.chat().legacy.nodes, trajectory: f.trajectory().eventNodes });
    if (gap === 'transport') f.durable(2, answer());
    else if (gap === 'durable') f.durable(1, answer(4));
    else if (gap === 'revision') f.frame(1, { ...start, revision: 2 });
    else { f.frame(1, start); f.frame(2, chunk(2, 1, 'Missing chunk zero')); }
    assert.equal(f.repairs, 1, gap); assert.deepEqual({ chat: f.chat().legacy.nodes, trajectory: f.trajectory().eventNodes }, projected, gap);
    assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 0, gap);
  }
});

test('repeated gaps request one repair until a new baseline arrives', () => {
  const f = fixture(); f.baseline(); f.durable(3, answer()); f.durable(4, answer()); f.durable(5, answer());
  assert.equal(f.repairs, 1, 'a broken follow stream must not trigger unbounded resubscriptions');
  f.baseline(); f.durable(1, answer()); assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
});

test('retired generation suffixes cannot alter a replacement projection', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Old process fragment'));
  f.baseline(opening(), 'generation-2'); const version = f.observation.getSnapshot();
  f.frame(3, chunk(3, 1, 'Late retired fragment')); f.durable(4, answer());
  assert.equal(f.observation.getSnapshot(), version); assert.equal(f.chat().legacy.partial, null); assert.equal(f.repairs, 0);
  f.durable(1, answer(), 'generation-2'); assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
});

test('reader position never gates projection freshness or changes during source delivery', () => {
  const f = fixture(); f.baseline(); f.observation.presentationState.set('chat:reading', {key:'retained',offset:120,atBottom:false});
  let notifications = 0; const unsubscribe = f.observation.subscribe(() => { notifications++; });
  f.durable(1, answer());
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
  assert.deepEqual(f.observation.presentationState.get('chat:reading'), {key:'retained',offset:120,atBottom:false}); assert.ok(notifications > 0);
  const before = notifications; unsubscribe(); f.durable(2, event(4, 'step/end', { turn: 1, step: 1 })); assert.equal(notifications, before);
});

test('disconnected snapshot recovery preserves the reading surface, verifies missing pages, then folds buffered suffix', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(), events = source(); f.baseline(events.slice(0, 2));
  f.observation.presentationState.set('chat:reading', {key:'retained',offset:240,atBottom:false});
  f.observation.snapshot({ generation: 'generation-2', page: cutPage(events.slice(6), 6), assistantStream: { revision: 0 } });
  assert.equal(fetch.calls.length, 1); assert.match(fetch.calls[0]!.path, /cut=new-cut&before=6$/);
  f.durable(1, user(8, 'Buffered follow event'), 'generation-2');
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1]);
  fetch.respond(0, cutPage(events.slice(2, 6), 2)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetch.calls.length, 2); assert.match(fetch.calls[1]!.path, /cut=new-cut&before=2$/);
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1], 'partial recovery is not a publishable joined cut');
  fetch.respond(1, cutPage(events.slice(0, 2), null));
  await changedUntil(f.observation, () => f.chat().legacy.nodes.some(node => node.seq === 8));
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1, 7, 8]);
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1);
  assert.deepEqual(f.observation.presentationState.get('chat:reading'), {key:'retained',offset:240,atBottom:false}); assert.equal(f.repairs, 0);
});

test('a superseded recovery response and its buffered suffix cannot rewrite a newer snapshot', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(), events = source(); f.baseline(events.slice(0, 2));
  f.observation.snapshot({ generation: 'generation-2', page: cutPage(events.slice(6), 6), assistantStream: { revision: 0 } });
  f.durable(1, user(8, 'Superseded buffered event'), 'generation-2');
  f.observation.snapshot({ generation: 'generation-3', page: page([event(0, 'turn/start', { turn: 1 }), user(1, 'Newest authoritative view')]), assistantStream: { revision: 0 } });
  const version = f.observation.getSnapshot();
  fetch.respond(0, cutPage(events.slice(0, 6), null)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.observation.getSnapshot(), version); assert.equal(f.observation.page?.cut, 'synthetic-cut');
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1]); assert.equal(f.repairs, 0);
});

test('recovery fetch failure preserves the reader and waits for explicit retry', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(), events = source(); f.baseline(events.slice(0, 2));
  f.observation.snapshot({ generation: 'generation-2', page: cutPage(events.slice(6), 6), assistantStream: { revision: 0 } });
  fetch.calls[0]!.response.resolve(Response.json({ error: { message: 'Source cut expired' } }, { status: 409 }));
  await changedUntil(f.observation, () => Boolean(f.observation.error));
  assert.match(f.observation.error, /Source cut expired/); assert.equal(f.repairs, 0);
  f.observation.retry(); assert.equal(f.repairs, 1);
  f.observation.retry(); assert.equal(f.repairs, 1);
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1]);
});

test('authoritative recovery pages remain bounded and do not replace a readable view on exhaustion', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(5), events = source(); f.baseline(events.slice(0, 2));
  f.observation.snapshot({ generation: 'generation-2', page: cutPage(events.slice(6), 6), assistantStream: { revision: 0 } });
  fetch.respond(0, cutPage(events.slice(0, 6), null));
  await changedUntil(f.observation, () => Boolean(f.observation.error));
  assert.match(f.observation.error, /budget|limit/i); assert.equal(f.repairs, 0);
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1]);
});

test('buffer exhaustion retires the pending recovery and never installs its late response', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(2), events = source(); f.baseline(events.slice(0, 2));
  f.observation.snapshot({ generation: 'generation-2', page: cutPage(events.slice(6), 6), assistantStream: { revision: 0 } });
  for (let sequence = 1; sequence <= 3; sequence++) f.durable(sequence, user(sequence + 7, 'Queued event'), 'generation-2');
  assert.match(f.observation.error, /buffer|budget|limit/i); assert.equal(f.repairs, 1);
  fetch.respond(0, cutPage(events.slice(0, 6), null)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'user').map(node => node.seq), [1]);
});

test('older-page response cannot contaminate a newer source generation', { timeout: 3000 }, async t => {
  const fetch = historyFetch(t), f = fixture(), events = source();
  f.baseline(events.slice(6), 'generation-1', { revision: 0 }, 6);
  const loading = f.observation.older(); assert.equal(fetch.calls.length, 1);
  f.observation.snapshot({ generation: 'generation-2', page: page([event(0, 'turn/start', { turn: 1 }), user(1, 'Replacement source')]), assistantStream: { revision: 0 } });
  fetch.respond(0, cutPage(events.slice(0, 6), null, 'synthetic-cut')); await loading;
  assert.deepEqual(f.chat().legacy.nodes.filter(node => node.kind === 'assistant'), [], 'superseded older page must not add its stale assistant answer');
  assert.equal(f.observation.page?.total, 2);
});

test('an explicit empty authoritative snapshot clears earlier projected source', () => {
  const f = fixture(); f.baseline();
  f.observation.snapshot({ generation: 'generation-2', page: null, assistantStream: { revision: 0 } });
  assert.equal(f.chat().legacy.nodes.length, 0); assert.equal(f.trajectory().eventNodes.length, 0);
});

test('baseline and incremental event budgets fail observably without publishing excess source', () => {
  const baseline = fixture(2); baseline.baseline(opening());
  assert.match(baseline.observation.error, /budget|limit/i);
  assert.equal(baseline.chat().legacy.nodes.length, 0);
  const incremental = fixture(3); incremental.baseline(); incremental.durable(1, answer());
  assert.match(incremental.observation.error, /budget|limit/i);
  assert.equal(incremental.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 0);
});

test('a settled durable assistant remains available after another subscription snapshot', () => {
  const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'prefix')); f.durable(3, answer());
  f.frame(4, { type: 'end', attemptId, revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } });
  f.baseline([answer(), event(4, 'step/end', { turn: 1, step: 1 }), event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })], 'generation-2', { revision: 0 }, 3);
  assert.equal(f.chat().legacy.nodes.filter(node => node.kind === 'assistant').length, 1, 'retained contiguous authoritative source includes settled assistant entries');
});

test('a burst of stream chunks publishes one exact prefix per paint without delaying source validation', () => {
  const f = fixture(1000); f.baseline(); f.frame(1, start);
  let notifications = 0; f.observation.subscribe(() => { notifications++; });
  const fragments = Array.from({length: 200}, (_, index) => `- Item ${index}\n`);
  fragments.forEach((text, index) => f.frame(index + 2, chunk(index + 2, index, text)));
  assert.equal(notifications, 0); assert.equal(f.pendingPaints, 1);
  f.paint(); assert.equal(notifications, 1); assert.equal(f.pendingPaints, 0);
  assert.deepEqual(f.chat().legacy.partial?.blocks, [{kind: 'text', text: fragments.join('')}]);
  assert.deepEqual(f.trajectory().partial?.blocks, [{kind: 'text', text: fragments.join('')}]);
  f.frame(202, chunk(202, 200, 'Next prefix'));
  f.frame(204, chunk(204, 201, 'Ungrounded suffix'));
  assert.equal(f.repairs, 1); assert.equal(f.observation.status, 'connecting');
  assert.equal(f.pendingPaints, 0);
  assert.deepEqual(f.chat().legacy.partial?.blocks, [{kind: 'text', text: fragments.join('') + 'Next prefix'}]);
});

test('settlement and abandonment cancel pending paints and publish immediately', () => {
  for (const committed of [true, false]) {
    const f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Pending prefix'));
    assert.equal(f.pendingPaints, 1);
    if (committed) f.durable(3, answer());
    f.frame(committed ? 4 : 3, {type: 'end', attemptId, revision: 3, index: 1, outcome: committed ? {kind: 'committed', eventType: 'assistant/message', seq: 3} : {kind: 'abandoned'}});
    assert.equal(f.pendingPaints, 0);
    const version = f.observation.getSnapshot(); f.paint(); assert.equal(f.observation.getSnapshot(), version);
    const chat = f.observation.engine.snapshot('chat') as ChatSnapshot;
    assert.equal(chat.legacy.partial, null);
    assert.equal(chat.legacy.nodes.filter(node => node.kind === 'assistant').length, committed ? 1 : 0);
  }
});

test('replacement and disposal retire scheduled screen work and late source delivery', async t => {
  const fetch = historyFetch(t), f = fixture(); f.baseline(); f.frame(1, start); f.frame(2, chunk(2, 0, 'Old prefix'));
  f.baseline(source().slice(6), 'generation-2', {revision: 0}, 6);
  assert.equal(f.pendingPaints, 0);
  // Complete the disconnected replacement before exercising disposal of older().
  fetch.respond(0, cutPage(source().slice(0, 6), null, 'synthetic-cut'));
  await changedUntil(f.observation, () => f.observation.page?.total === 8);
  const g = fixture(); g.baseline(source().slice(6), 'generation-1', {revision: 0}, 6);
  g.frame(1, {...start, startedAfterSeq: SessionSeq(7)}); g.frame(2, chunk(2, 0, 'Pending paint'));
  const loading = g.observation.older(); g.observation.dispose();
  const version = g.observation.getSnapshot(); assert.equal(g.pendingPaints, 0);
  fetch.respond(1, cutPage(source().slice(0, 6), null, 'synthetic-cut')); await loading;
  g.durable(3, user(8, 'Late event')); g.baseline(); g.paint();
  assert.equal(g.observation.getSnapshot(), version);
  assert.deepEqual(g.observation.inspectSource()!.events, source().slice(6));
});

test('expired older cursor requests one fresh baseline and resumes pagination using its replacement', async t => {
  const fetch = historyFetch(t), f = fixture(), events = source();
  f.baseline(events.slice(6), 'generation-1', {revision: 0}, 6);
  f.observation.presentationState.set('chat:reading', {key:'retained',offset:240,atBottom:false});
  const loading = f.observation.older();
  fetch.calls[0]!.response.resolve(Response.json({error: {code: 'HISTORY_CUT_EXPIRED', message: 'History cut expired; reload the latest source'}}, {status: 409}));
  assert.equal(await loading, false); assert.equal(f.repairs, 1);
  assert.equal(await f.observation.older(), false); assert.equal(fetch.calls.length, 1);
  assert.equal(f.observation.status, 'connecting'); assert.match(f.observation.error, /expired/);
  assert.deepEqual(f.observation.inspectSource()!.events, events.slice(6));
  f.observation.snapshot({generation: 'generation-2', page: cutPage(events.slice(6), 6, 'replacement-cut'), assistantStream: {revision: 0}});
  const recovered = f.observation.older(); assert.match(fetch.calls[1]!.path, /cut=replacement-cut&before=6$/);
  fetch.respond(1, cutPage(events.slice(0, 6), null, 'replacement-cut'));
  assert.equal(await recovered, true); assert.equal(f.observation.error, '');
  assert.deepEqual(f.observation.inspectSource()!.events, events);
  assert.deepEqual(f.observation.presentationState.get('chat:reading'), {key:'retained',offset:240,atBottom:false});
});

test('ordinary history failures remain retryable and successful retry clears the error', async t => {
  const fetch = historyFetch(t), f = fixture(), events = source(); f.baseline(events.slice(6), 'generation-1', {revision: 0}, 6);
  const failed = f.observation.older();
  fetch.calls[0]!.response.resolve(Response.json({error: {code: 'UNAVAILABLE', message: 'Reader unavailable'}}, {status: 503}));
  assert.equal(await failed, false); assert.equal(f.repairs, 0); assert.equal(f.observation.status, 'ready');
  const retry = f.observation.older(); fetch.respond(1, cutPage(events.slice(0, 6), null, 'synthetic-cut'));
  assert.equal(await retry, true); assert.equal(f.observation.error, '');
});

test('failed bridging after cursor expiry has bounded explicit recovery without losing the reading surface', async t => {
  const fetch = historyFetch(t), f = fixture(), events = source();
  f.baseline(events.slice(2, 4), 'generation-1', {revision: 0}, 2);
  const loading = f.observation.older();
  fetch.calls[0]!.response.resolve(Response.json({error: {code: 'HISTORY_CUT_EXPIRED', message: 'Expired'}}, {status: 409}));
  await loading; assert.equal(f.repairs, 1);
  f.observation.snapshot({generation: 'generation-2', page: cutPage(events.slice(6), 6, 'replacement'), assistantStream: {revision: 0}});
  fetch.calls[1]!.response.resolve(Response.json({error: {code: 'HISTORY_CUT_EXPIRED', message: 'Bridge expired'}}, {status: 409}));
  await changedUntil(f.observation, () => f.observation.status === 'error');
  assert.equal(f.repairs, 1); assert.equal(await f.observation.older(), false);
  assert.deepEqual(f.observation.inspectSource()!.events, events.slice(2, 4));
  f.observation.retry(); f.observation.retry(); assert.equal(f.repairs, 2);
  f.observation.snapshot({generation: 'generation-3', page: cutPage(events.slice(6), 6, 'retry-cut'), assistantStream: {revision: 0}});
  fetch.respond(2, cutPage(events.slice(0, 6), null, 'retry-cut'));
  await changedUntil(f.observation, () => f.observation.status === 'ready');
  assert.equal(f.observation.error, ''); assert.equal(f.observation.page?.cut, 'retry-cut');
  assert.deepEqual(f.observation.inspectSource()!.events, events);
});

for (const defect of ['same cursor', 'empty page', 'wrong source', 'wrong cut', 'future event']) {
 test(`older history rejects ${defect} without changing readable evidence`, async t => {
  const fetch=historyFetch(t),f=fixture(),events=source();
  f.baseline(events.slice(6),'generation-1',{revision:0},6);
  const before=f.observation.inspectSource(),loading=f.observation.older();
  const result=cutPage(events.slice(0,6),null,'synthetic-cut');
  if(defect==='same cursor')result.before=6;
  if(defect==='empty page'){result.events=[];result.before=3;}
  if(defect==='wrong source')result.sourceSessionId='another-session';
  if(defect==='wrong cut')result.cut='another-cut';
  if(defect==='future event')result.events=events.slice(6);
  fetch.respond(0,result);assert.equal(await loading,false);
  assert.match(f.observation.error,/did not advance/);
  assert.deepEqual(f.observation.inspectSource(),before);
  assert.equal(f.repairs,0);
 });
}

// Grouping consumes the same worker-owned source as trajectory; render seats
// only receive stable references and never become a second history authority.
test('native process grouping separates reasoning from the reply and publishes tool settlement atomically', () => {
  const f = fixture();
  const call = event(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' });
  f.baseline([...opening(), call]);
  const grouped = f.observation.engine.grouped('chat'); assert.ok(grouped);
  const entry = grouped.entries.find(entry => entry.kind === 'group'); assert.ok(entry);
  const source = grouped.groupSource(entry.key), roots = grouped.entries;
  const running = source.getSnapshot(); assert.ok(running);
  assert.equal(running.data.summary.running, 'commands');
  const member = running.members[0]!;
  const publications: { kind: string | undefined; toolKind: string | undefined; running: string | undefined }[] = [];
  const unsubscribe = source.subscribe(() => {
    const node = f.observation.engine.get('chat')?.nodes.get(member.key);
    publications.push({ kind: node?.kind, toolKind: (node?.data as { root?: { kind?: string } })?.root?.kind,
      running: source.getSnapshot()?.data.summary.running });
  });
  f.durable(1, event(4, 'tool/result', { turn: 1, step: 1, message: {
    id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' },
    content: [{ type: 'text', text: 'file.txt' }], isError: false,
  } }, 'append'));
  assert.equal(f.repairs, 0); assert.equal(f.observation.error, '');
  assert.deepEqual(publications, [{ kind: 'tool-call', toolKind: 'tool-result', running: undefined }]);
  assert.equal(grouped.entries, roots, 'content changes do not replace the root sequence');
  assert.equal(grouped.groupSource(entry.key), source);
  assert.equal(source.getSnapshot()?.members, running.members);
  unsubscribe();
  f.durable(2, event(5, 'assistant/message', { turn: 1, step: 1, stream: [], message: {
    id: 'answer-1', role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture' },
    content: [{ type: 'reasoning', text: 'Checked the working directory.' }, { type: 'text', text: 'Here are the files.' }],
  } }, 'append'));
  const chat = f.chat(), response = grouped.entries.find(entry => entry.kind === 'node' && entry.groupPart === 'response');
  assert.ok(response);
  const reasoning = grouped.entries.filter(entry => entry.kind === 'group')
    .flatMap(entry => grouped.groupSource(entry.key).getSnapshot()?.members ?? [])
    .find(member => member.groupPart === 'reasoning');
  assert.ok(reasoning); assert.equal(reasoning.key, response.key);
  assert.equal(chat.nodes.get(response.key)?.kind, 'assistant-step');
  assert.equal(f.repairs, 0); f.observation.dispose();
});

test('native group identity survives loading earlier process members and is retired on source replacement', async t => {
  const f = fixture(), fetch = historyFetch(t);
  const early = event(3, 'tool/call', { turn: 1, step: 1, callId: 'early', name: 'read', arguments: '{"path":"earlier.txt"}' });
  const late = event(4, 'tool/call', { turn: 1, step: 1, callId: 'late', name: 'read', arguments: '{"path":"later.txt"}' });
  f.baseline([late], 'generation-1', { revision: 0 }, 4);
  const grouped = f.observation.engine.grouped('chat'); assert.ok(grouped);
  const entry = grouped.entries.find(entry => entry.kind === 'group'); assert.ok(entry);
  const source = grouped.groupSource(entry.key), before = source.getSnapshot(); assert.ok(before);
  // An earlier-page prepend expands a group without changing the identity used
  // by the worker's disclosure and nested-reading memory.
  const loading = f.observation.older();
  fetch.respond(0, { ...page([...opening(), early]), total: 5 });
  assert.equal(await loading, true);
  assert.ok(grouped.entries.some(next => next.kind === 'group' && next.key === entry.key));
  assert.equal(grouped.groupSource(entry.key), source);
  assert.equal(source.getSnapshot()?.members.length, before.members.length + 1);
  f.baseline([], 'generation-2');
  assert.equal(source.getSnapshot(), undefined);
  assert.deepEqual(grouped.entries, []);
  f.observation.dispose();
});

test('native grouping keeps one tool identity from streamed preparation through dispatched settlement', () => {
  const f = fixture(); f.baseline(); f.frame(1, start);
  f.frame(2, { type: 'chunk', attemptId, revision: 2, index: 0, time: 2000,
    chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' } });
  const chat = f.chat(), grouped = f.observation.engine.grouped('chat'); assert.ok(grouped);
  const tool = chat.nodes.values().find(node => node.kind === 'tool-call'); assert.ok(tool);
  const first = grouped.entries.find(entry => entry.kind === 'group'); assert.ok(first);
  const source = grouped.groupSource(first.key);
  assert.equal(source.getSnapshot()?.data.summary.preparing, true);
  f.durable(3, event(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }));
  assert.equal(f.chat().nodes.values().filter(node => node.kind === 'tool-call').length, 1);
  assert.equal(f.chat().nodes.get(tool.key)?.visibility, 'visible');
  assert.equal(grouped.groupSource(first.key), source);
  assert.equal(source.getSnapshot()?.data.summary.preparing, undefined);
  assert.equal(source.getSnapshot()?.data.summary.runningDetail, 'ls');
  f.frame(4, { type: 'end', attemptId, revision: 3, index: 1, outcome: { kind: 'abandoned' } });
  assert.equal(f.chat().nodes.get(tool.key)?.visibility, 'visible', 'retiring transient preparation cannot remove the durable call');
  assert.equal(f.repairs, 0); assert.equal(f.observation.error, '');
  f.observation.dispose();
});

// DSH 0.2.1 retains successful attempt preparation until the step closes. A
// prepared call omitted from the durable answer must disappear at that boundary.
test('successful assistant settlement retires undispatched preparation at step end', () => {
  const f=fixture();f.baseline();f.frame(1,start);
  f.frame(2,{type:'chunk',attemptId,revision:2,index:0,time:2000,
    chunk:{type:'tool-call-delta',index:0,id:'never-dispatched',name:'bash',argumentsDelta:'{"description":"Checking'} });
  const tool=f.chat().nodes.values().find(node=>node.kind==='tool-call');assert.ok(tool);
  f.durable(3,answer());
  f.frame(4,{type:'end',attemptId,revision:3,index:1,outcome:{kind:'committed',eventType:'assistant/message',seq:3}});
  assert.equal(f.chat().nodes.get(tool.key)?.visibility,'visible');
  f.durable(5,event(4,'step/end',{turn:1,step:1}));
  assert.equal(f.chat().nodes.get(tool.key)?.visibility,'hidden');
  assert.equal(f.chat().legacy.runningCalls.length,0);
  f.durable(6,event(5,'step/start',{turn:1,step:2}));
  f.frame(7,{type:'start',attemptId:LlmAttemptId('second'),revision:4,startedAfterSeq:SessionSeq(5),turn:1,step:2});
  assert.equal(f.repairs,0,'a settled step permits the next native stream');
  assert.equal(f.observation.inspectSource()?.events.length,6);
  f.observation.dispose();
});

test('notice-woken turns remain in the human exchange until a later human opening', () => {
  const f=fixture();
  const events=[event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),user(2,'Human opening'),
    event(3,'step/end',{turn:1,step:1}),event(4,'turn/end',{turn:1,reason:{kind:'completed'}}),
    event(5,'agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'notice',source:{kind:'notice'}}]}),
    event(6,'agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]}),
    event(7,'turn/start',{turn:2}),event(8,'step/start',{turn:2,step:1}),
    event(9,'user/message',{id:'notice',role:'user',source:{kind:'notice'},content:[{type:'text',text:'Background result'}]},'append')];
  f.baseline(events);
  const first=f.chat().nodes.values().find(node=>node.kind==='user');assert.ok(first);
  const trigger=f.chat().nodes.values().find(node=>node.kind==='turn-trigger');assert.ok(trigger);
  assert.equal(first.groupTree,'exchange');assert.equal(trigger.groupTree,'input');
  assert.equal(f.chat().nodes.bottomSource(first.key).getSnapshot(),true);
  assert.equal(f.chat().nodes.bottomSource(trigger.key).getSnapshot(),true);
  f.durable(1,event(10,'step/end',{turn:2,step:1}));
  f.durable(2,event(11,'turn/end',{turn:2,reason:{kind:'completed'}}));
  f.durable(3,event(12,'turn/start',{turn:3}));
  f.durable(4,event(13,'step/start',{turn:3,step:1}));f.durable(5,user(14,'Next human opening'));
  assert.equal(f.chat().nodes.bottomSource(first.key).getSnapshot(),false);
  assert.equal(f.chat().nodes.bottomSource(trigger.key).getSnapshot(),false);
  f.observation.dispose();
});
