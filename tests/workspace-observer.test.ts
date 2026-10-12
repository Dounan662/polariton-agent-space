import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { WorkspaceObserver, type WorkspaceObserverIO, type WorkspaceSnapshot, type WorkspaceDiagnostic } from '../src/workspace-observer.ts';
import type { WorkspaceScope, WorkspaceChange } from '../src/workspace-contracts.ts';
import { ResearchTree } from '../src/research.ts';
import { loadConfig } from '../src/config.ts';
import { Fault } from '../src/contracts.ts';

const scope: WorkspaceScope = { project: '00000000-0000-4000-8000-000000000001', node: '00000000-0000-4000-8000-000000000002', path: '', kind: 'directory' };
const settings = { workspaceDebounceMs: 10, workspaceReconcileMs: 100, workspaceReadTimeoutMs: 50, maxWorkspaceWatches: 4, maxWorkspaceScans: 2 };
const research = { observationPath: async () => '/workspace', directory: async () => [] };
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

/** Deterministic boundary permits missed notifications and blocked reads without real timers. */
function fake() {
  let now = 0;
  const timers = new Set<{ due: number; callback: () => void }>();
  const watchers = new Set<{ changed: () => void; failed: (error: Error) => void }>();
  let snapshot: WorkspaceSnapshot = { watchPath: '/workspace', binding: '1', fingerprint: 'v1' };
  const io: WorkspaceObserverIO = {
    snapshot: async () => snapshot,
    schedule: (delay, callback) => { const timer = { due: now + delay, callback }; timers.add(timer); return () => { timers.delete(timer); }; },
    watch: (_path, changed, failed) => { const watcher = { changed, failed }; watchers.add(watcher); return () => { watchers.delete(watcher); }; },
  };
  return { io, timers, watchers, set(value: Partial<WorkspaceSnapshot>) { snapshot = { ...snapshot, ...value }; },
    changed() { for (const watcher of watchers) watcher.changed(); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const timer = [...timers].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!timer) break;
        now = timer.due; timers.delete(timer); timer.callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

test('shared resources coalesce events, reconcile missed changes, and clean up', async () => {
  const f = fake(), observer = new WorkspaceObserver(settings, research, undefined, f.io);
  const a: WorkspaceChange[] = [], b: WorkspaceChange[] = [];
  const releaseA = observer.subscribe(scope, change => a.push(change)); await flush();
  const releaseB = observer.subscribe({ ...scope }, change => b.push(change));
  assert.equal(f.watchers.size, 1); assert.equal(a.length, 1); assert.equal(b.length, 1);
  f.set({ fingerprint: 'v2' });
  for (let i = 0; i < 100; i++) f.changed();
  await f.advance(settings.workspaceDebounceMs);
  assert.equal(a.length, 2); assert.equal(b.length, 2); assert.equal(observer.stats().scans, 2);
  f.changed(); await f.advance(settings.workspaceDebounceMs);
  assert.equal(a.length, 2, 'unchanged data does not invalidate');
  f.set({ fingerprint: 'missed-event' }); await f.advance(settings.workspaceReconcileMs);
  assert.equal(a.length, 3);
  releaseA(); assert.equal(f.watchers.size, 1);
  releaseB(); assert.equal(f.watchers.size, 0); assert.equal(f.timers.size, 0);
  observer.close();
});

test('continuous writes have bounded debounce and different scopes stay isolated', async () => {
  const f = fake(), observer = new WorkspaceObserver(settings, research, undefined, f.io);
  const a: WorkspaceChange[] = [], b: WorkspaceChange[] = [];
  observer.subscribe(scope, change => a.push(change));
  observer.subscribe({ ...scope, node: '00000000-0000-4000-8000-000000000003' }, change => b.push(change)); await flush();
  f.set({ fingerprint: 'new' });
  const first = [...f.watchers][0]!;
  first.changed(); await f.advance(5); first.changed(); await f.advance(5);
  assert.equal(a.length, 2); assert.equal(b.length, 1);
  observer.close(); assert.equal(f.timers.size, 0);
});

test('each subscription owns its release even when the same callback is registered twice', async () => {
  const f = fake(), observer = new WorkspaceObserver(settings, research, undefined, f.io);
  let calls = 0; const listener = () => calls++;
  const first = observer.subscribe(scope, listener); await flush();
  const second = observer.subscribe(scope, listener);
  first(); first(); assert.equal(observer.stats().resources, 1);
  const baseline = calls; f.set({ fingerprint: 'updated' }); f.changed(); await f.advance(settings.workspaceDebounceMs);
  assert.equal(calls, baseline + 1);
  second(); assert.equal(observer.stats().resources, 0); observer.close();
});

test('watch failures and replaced directories recover through reconciliation', async () => {
  const f = fake(), events: WorkspaceChange[] = [], diagnostics: WorkspaceDiagnostic[] = [];
  const observer = new WorkspaceObserver(settings, research, event => diagnostics.push(event), f.io);
  observer.subscribe(scope, event => events.push(event)); await flush();
  [...f.watchers][0]!.failed(new Error('watch lost'));
  assert.equal(events.at(-1)?.state, 'unavailable');
  f.set({ watchPath: null, binding: '', fingerprint: 'missing' }); await f.advance(settings.workspaceDebounceMs);
  assert.equal(f.watchers.size, 0); assert.equal(events.at(-1)?.state, 'changed');
  f.set({ watchPath: '/workspace', binding: 'replacement-inode', fingerprint: 'restored' }); await f.advance(settings.workspaceReconcileMs);
  assert.equal(f.watchers.size, 1); assert.equal(events.at(-1)?.state, 'changed'); assert.equal(diagnostics.length, 1);
  observer.close();
});

test('scan failure is observable and reconciliation recovers without spinning', async () => {
  const f = fake(), events: WorkspaceChange[] = [], diagnostics: WorkspaceDiagnostic[] = [];
  const healthy = f.io.snapshot; f.io.snapshot = async () => { throw new Error('filesystem unavailable'); };
  const observer = new WorkspaceObserver(settings, research, event => diagnostics.push(event), { ...f.io, snapshot: scope => f.io.snapshot(scope) });
  observer.subscribe(scope, event => events.push(event)); await flush();
  assert.equal(events.at(-1)?.state, 'unavailable'); assert.equal(diagnostics.length, 1);
  f.io.snapshot = healthy; await f.advance(settings.workspaceReconcileMs);
  assert.equal(events.at(-1)?.state, 'changed'); assert.equal(observer.stats().scans, 2);
  observer.close();
});

test('timeouts retain concurrency ownership while unrelated work progresses; close ignores late reads', async () => {
  const f = fake(), events: WorkspaceChange[] = [], diagnostics: WorkspaceDiagnostic[] = [];
  let unblock!: (snapshot: WorkspaceSnapshot) => void;
  const blocked = new Promise<WorkspaceSnapshot>(resolve => { unblock = resolve; });
  const observer = new WorkspaceObserver(settings, research, event => diagnostics.push(event), { ...f.io,
    snapshot: input => input.path === 'blocked' ? blocked : f.io.snapshot(input),
  });
  observer.subscribe({ ...scope, path: 'blocked' }, event => events.push(event));
  let healthy = 0; observer.subscribe(scope, () => healthy++); await flush(); assert.equal(healthy, 1);
  await f.advance(settings.workspaceReadTimeoutMs);
  assert.equal(events.at(-1)?.state, 'unavailable'); assert.equal(diagnostics[0]?.event, 'scan-timeout');
  await f.advance(settings.workspaceReconcileMs * 3);
  assert.equal(observer.stats().scansInFlight, 1); assert.equal(observer.stats().timeouts, 1);
  observer.close(); const count = events.length;
  unblock({ watchPath: '/blocked', binding: '1', fingerprint: 'late' }); await flush();
  assert.equal(events.length, count); assert.equal(observer.stats().scansInFlight, 0); assert.equal(f.timers.size, 0); assert.equal(f.watchers.size, 0);
});

test('admission and scans are bounded; terminal denial releases the resource budget', async () => {
  const f = fake(); let finish!: (snapshot: WorkspaceSnapshot) => void;
  const pending = new Promise<WorkspaceSnapshot>(resolve => { finish = resolve; });
  const observer = new WorkspaceObserver({ ...settings, maxWorkspaceScans: 1, maxWorkspaceWatches: 2 }, research, undefined, { ...f.io, snapshot: () => pending });
  observer.subscribe(scope, () => {}); observer.subscribe({ ...scope, path: 'other' }, () => {});
  assert.equal(observer.stats().scansInFlight, 1); assert.equal(observer.stats().queued, 1);
  assert.throws(() => observer.subscribe({ ...scope, path: 'third' }, () => {}), /capacity/);
  assert.throws(() => observer.subscribe({ ...scope, path: '../escape' }, () => {}));
  observer.close(); finish({ watchPath: null, binding: '', fingerprint: 'closed' }); await flush();
  const denied: WorkspaceChange[] = [];
  const next = new WorkspaceObserver({ ...settings, maxWorkspaceWatches: 1 }, research, undefined, { ...f.io,
    snapshot: input => input.path === 'denied' ? Promise.reject(new Fault('FILE_DENIED', 'Denied')) : f.io.snapshot(input),
  });
  const oldRelease = next.subscribe({ ...scope, path: 'denied' }, event => denied.push(event)); await flush();
  assert.equal(denied[0]?.terminal, true); assert.equal(next.stats().resources, 0);
  next.subscribe(scope, () => {}); oldRelease(); await flush(); assert.equal(next.stats().resources, 1); next.close();
});

async function realFixture(t: TestContext) {
  const root = await temporaryDirectory('workspace-observer-'), stateRoot = join(root, 'state'); await mkdir(stateRoot);
  const config = { ...await loadConfig(), stateRoot, verification: false };
  const tree = new ResearchTree(config); await tree.initialize();
  const project = await tree.createProject(crypto.randomUUID(), 'Observation fixture'), node = crypto.randomUUID();
  await tree.mutate(project.id, { operationId: crypto.randomUUID(), revision: tree.graph(project.id).revision,
    command: { kind: 'node.create', id: node, title: 'Observed node', description: '' } });
  t.after(async () => { tree.close(); await rm(root, { recursive: true, force: true }); });
  return { tree, config, project: project.id, node, root, workspace: tree.workspace(project.id, node) };
}

test('real filesystem watcher detects same-size writes, atomic replacement and deletion', { timeout: 10000 }, async t => {
  const f = await realFixture(t), file = join(f.workspace, 'notes.txt'); await writeFile(file, 'before');
  const observer = new WorkspaceObserver(f.config, f.tree); t.after(() => observer.close());
  let next!: () => void;
  const changed = () => new Promise<void>(resolve => { next = resolve; });
  const ready = changed();
  observer.subscribe({ project: f.project, node: f.node, path: 'notes.txt', kind: 'file' }, event => { if (event.state === 'changed') next(); });
  await ready;
  let update = changed(); await writeFile(file, 'edited'); await update;
  update = changed(); const temporary = file + '.tmp'; await writeFile(temporary, 'atomic'); await rename(temporary, file); await update;
  update = changed(); await rm(file); await update;
  observer.close(); assert.equal(observer.stats().watches, 0);
});

test('observation denies links, reserved paths and replaced roots, while admitting absent children', async t => {
  const f = await realFixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.workspace, 'escape')); await symlink(join(outside, 'absent'), join(f.workspace, 'dangling'));
  for (const path of ['escape/new/file.txt', 'dangling', '../outside', '.git/config'])
    await assert.rejects(f.tree.observationPath(f.project, f.node, path), error => (error as { code: string }).code === 'FILE_DENIED');
  assert.equal(await f.tree.observationPath(f.project, f.node, 'new/directory/file.txt'), join(f.workspace, 'new/directory/file.txt'));
  await assert.rejects(f.tree.file(f.project, f.node, 'missing.txt'), error => (error as { code: string }).code === 'FILE_NOT_FOUND');
  await assert.rejects(f.tree.directory(f.project, f.node, 'missing'), error => (error as { code: string }).code === 'DIRECTORY_NOT_FOUND');
  await rename(f.workspace, f.workspace + '-original'); await symlink(outside, f.workspace);
  await assert.rejects(f.tree.observationPath(f.project, f.node), error => (error as { code: string }).code === 'FILE_DENIED');
  await assert.rejects(f.tree.directory(f.project, f.node), error => (error as { code: string }).code === 'FILE_DENIED');
});
