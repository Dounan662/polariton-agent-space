import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RefreshResource, type RefreshClock, type RefreshPolicy} from '../web/src/workspace-resource.ts';

const policy: RefreshPolicy = {requestTimeoutMs: 100, retryDelayMs: 10, maxRetryDelayMs: 15, maxRetries: 2};

class Clock implements RefreshClock {
  private now = 0;
  private timers = new Set<{at: number; callback: () => void}>();
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = {at: this.now + delayMs, callback};
    this.timers.add(timer);
    return () => {this.timers.delete(timer);};
  }
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const timer = [...this.timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      this.now = timer.at;
      this.timers.delete(timer);
      timer.callback();
    }
    this.now = target;
  }
}

function reader<T>() {
  const calls: {signal: AbortSignal; resolve: (value: T) => void; reject: (error: Error) => void}[] = [];
  return {calls, read: (signal: AbortSignal) => new Promise<T>((resolve, reject) => {calls.push({signal, resolve, reject});})};
}

async function settle(): Promise<void> {await Promise.resolve();}

test('invalidations retain useful results and coalesce to one follow-up without concurrent reads', async () => {
  const source = reader<string[]>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock});
  assert.equal(source.calls.length, 0);
  resource.invalidate();
  for (let i = 0; i < 20; i++) resource.invalidate();
  assert.equal(source.calls.length, 1);
  assert.equal(resource.getSnapshot().loading, true);
  source.calls[0]!.resolve(['first']);
  await settle();
  assert.deepEqual(resource.getSnapshot().data, ['first']);
  assert.equal(resource.getSnapshot().loading, false);
  assert.equal(resource.getSnapshot().refreshing, true);
  assert.equal(source.calls.length, 2);
  source.calls[1]!.resolve(['latest']);
  await settle();
  assert.deepEqual(resource.getSnapshot(), {data: ['latest'], error: null, loading: false, refreshing: false, stale: false});
  clock.advance(1000);
  assert.equal(source.calls.length, 2);
});

test('background failures retain successful data and recover with bounded capped backoff', async () => {
  const source = reader<string>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock});
  resource.invalidate(); source.calls[0]!.resolve('saved'); await settle();
  resource.invalidate(); source.calls[1]!.reject(new Error('offline')); await settle();
  assert.equal(resource.getSnapshot().data, 'saved');
  assert.equal(resource.getSnapshot().error?.message, 'offline');
  assert.equal(resource.getSnapshot().stale, true);
  resource.invalidate(); resource.invalidate();
  clock.advance(9); assert.equal(source.calls.length, 2);
  clock.advance(1); assert.equal(source.calls.length, 3);
  source.calls[2]!.reject(new Error('still offline')); await settle();
  clock.advance(14); assert.equal(source.calls.length, 3);
  clock.advance(1); assert.equal(source.calls.length, 4);
  source.calls[3]!.resolve('recovered'); await settle();
  assert.equal(resource.getSnapshot().data, 'recovered');
  assert.equal(resource.getSnapshot().error, null);
  assert.equal(resource.getSnapshot().stale, false);
});

test('event storms do not reset the retry budget; a later invalidation can recover', async () => {
  const source = reader<string>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock});
  resource.invalidate();
  for (let i = 0; i <= policy.maxRetries; i++) {
    resource.invalidate(); resource.invalidate();
    source.calls.at(-1)!.reject(new Error('offline')); await settle();
    clock.advance(15);
  }
  clock.advance(1000);
  assert.equal(source.calls.length, 3);
  assert.equal(resource.getSnapshot().loading, false);
  assert.equal(resource.getSnapshot().stale, true);
  resource.invalidate();
  source.calls[3]!.resolve('back'); await settle();
  assert.equal(resource.getSnapshot().data, 'back');
});

test('deadline aborts immediately, ignores late data, and cannot accumulate noncooperative reads', async () => {
  const source = reader<string>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock});
  resource.invalidate();
  clock.advance(100);
  assert.equal(source.calls[0]!.signal.aborted, true);
  assert.match(resource.getSnapshot().error!.message, /timed out/);
  assert.equal(resource.getSnapshot().loading, false);
  resource.invalidate(); clock.advance(1000); resource.invalidate();
  assert.equal(source.calls.length, 1);
  source.calls[0]!.resolve('obsolete'); await settle();
  assert.equal(resource.getSnapshot().data, undefined);
  clock.advance(10);
  assert.equal(source.calls.length, 2);
  source.calls[1]!.resolve('current'); await settle();
  assert.equal(resource.getSnapshot().data, 'current');
  assert.equal(resource.getSnapshot().error, null);
});

test('abort-aware timeout recovery does not block another resource', async () => {
  const clock = new Clock();
  let calls = 0;
  const blocked = new RefreshResource<string>(signal => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
  }, policy, {clock});
  const healthy = new RefreshResource(async () => 'healthy', policy, {clock});
  blocked.invalidate(); healthy.invalidate(); await settle();
  assert.equal(healthy.getSnapshot().data, 'healthy');
  clock.advance(100); await settle();
  clock.advance(10);
  assert.equal(calls, 2);
  assert.match(blocked.getSnapshot().error!.message, /timed out/);
  blocked.dispose(); await settle();
});

test('disposal aborts active reads, cancels recovery, and prevents any later publication', async () => {
  for (const failFirst of [false, true]) {
    const source = reader<string>(), clock = new Clock();
    const resource = new RefreshResource(source.read, policy, {clock});
    let notifications = 0;
    resource.subscribe(() => notifications++);
    resource.invalidate();
    if (failFirst) {source.calls[0]!.reject(new Error('offline')); await settle();}
    resource.dispose();
    const snapshot = resource.getSnapshot(), count = notifications;
    if (!failFirst) assert.equal(source.calls[0]!.signal.aborted, true);
    source.calls[0]!.resolve('late'); await settle();
    resource.invalidate(); clock.advance(1000);
    assert.equal(source.calls.length, 1);
    assert.equal(resource.getSnapshot(), snapshot);
    assert.equal(notifications, count);
  }
});

test('equal reads preserve data identity, stable snapshots, and removable subscriptions', async () => {
  const source = reader<string[]>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock, equal: (a, b) => a.join() === b.join()});
  let notifications = 0;
  const unsubscribe = resource.subscribe(() => notifications++);
  resource.invalidate(); source.calls[0]!.resolve(['same']); await settle();
  const data = resource.getSnapshot().data;
  assert.equal(resource.getSnapshot(), resource.getSnapshot());
  resource.invalidate();
  const started = resource.getSnapshot(), count = notifications;
  resource.invalidate(); resource.invalidate();
  assert.equal(resource.getSnapshot(), started);
  assert.equal(notifications, count);
  unsubscribe();
  source.calls[1]!.resolve(['same']); await settle();
  source.calls[2]!.resolve(['same']); await settle();
  assert.equal(resource.getSnapshot().data, data);
  assert.equal(notifications, count);
});

test('permanent read errors wait for a new invalidation instead of retrying', async () => {
  const source = reader<string>(), clock = new Clock();
  const resource = new RefreshResource(source.read, policy, {clock, retryable: error => error.message !== 'missing'});
  resource.invalidate(); source.calls[0]!.reject(new Error('missing')); await settle();
  clock.advance(1000);
  assert.equal(source.calls.length, 1);
  resource.invalidate(); source.calls[1]!.resolve('recreated'); await settle();
  assert.equal(resource.getSnapshot().data, 'recreated');
});

test('synchronous reader failure follows the same bounded recovery contract', async () => {
  const clock = new Clock();
  let calls = 0;
  const resource = new RefreshResource(() => {
    if (++calls === 1) throw new Error('setup failed');
    return Promise.resolve('recovered');
  }, policy, {clock});
  resource.invalidate();
  assert.equal(resource.getSnapshot().error?.message, 'setup failed');
  clock.advance(10); await settle();
  assert.equal(resource.getSnapshot().data, 'recovered');
});
