import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { temporaryDirectory } from './fixtures/storage.ts';
import { testConfig } from './fixtures/config.ts';
import type { InjectOptions } from 'fastify';
import { createApp } from '../src/main.ts';
import { type Config } from '../src/config.ts';
import type {HarnessFactory} from '../harness/contracts.ts';
import type { ProjectView } from '../src/contracts.ts';
import type { WorkspaceScope as Scope } from '../src/workspace-contracts.ts';

type Frame = { kind: string; scope?: Scope; state?: 'changed' | 'unavailable'; detail?: string; error?: string };
const budget = { workspaceDebounceMs: 10, workspaceReconcileMs: 50, workspaceReadTimeoutMs: 1000 };
const testTimeout = 10000;

/** Main, authentication, transport and filesystem are real; any execution launch is a test failure. */
async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-workspace-web-');
  const config = { ...await testConfig(root), ...budget, ...overrides, stateRoot: root, verification: false };
  let launches = 0;
  const factory: HarnessFactory = () => { launches++; throw new Error('Workspace observation must not activate workers'); };
  const runtime = await createApp(config, factory);
  await runtime.app.ready();
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    try { for (const cleanup of cleanups) await cleanup(); await runtime.app.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
    assert.equal(launches, 0, 'Workspace reads and notifications cannot launch a harness');
  });
  const host = `127.0.0.1:${config.port}`, origin = `http://${host}`;
  let cookie = '', sequence = 0;
  const id = () => `75000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const request = (options: InjectOptions) => runtime.app.inject({ ...options, headers: {
    host, cookie, ...(options.method && options.method !== 'GET' ? { origin } : {}), ...options.headers,
  } });
  const token = new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token')!;
  const bootstrap = await request({ method: 'POST', url: '/api/bootstrap', payload: { token } });
  assert.equal(bootstrap.statusCode, 200);
  cookie = (bootstrap.headers['set-cookie'] as string).split(';')[0]!;
  const project = async (name: string) => {
    const result = await request({ method: 'POST', url: '/api/projects', payload: { id: id(), name } });
    assert.equal(result.statusCode, 200);
    const value = result.json<ProjectView>();
    assert.ok(value.mainNodeId);
    const scope: Scope = { project: value.id, node: value.mainNodeId, path: '', kind: 'directory' };
    return { value, scope, workspace: runtime.tree.workspace(value.id, value.mainNodeId) };
  };
  const a = await project('Workspace A');
  return { runtime, root, config, host, origin, cookie, request, id, project, a, cleanups };
}

/** Install frame capture before opening, then use observed replies as barriers instead of timing sleeps. */
async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  const frames: Frame[] = [], listeners = new Set<() => void>();
  const socket = await f.runtime.app.injectWS('/api/live', { headers: { host: f.host, origin: f.origin, cookie: f.cookie } }, {
    onInit: ws => ws.on('message', (raw: unknown) => {
      frames.push(JSON.parse(String(raw)) as Frame);
      for (const notify of listeners) notify();
    }),
  });
  const close = async () => {
    if (socket.readyState === socket.CLOSED) return;
    const closed = once(socket, 'close'); socket.terminate(); await closed;
  };
  f.cleanups.push(close);
  const send = (command: unknown) => socket.send(JSON.stringify(command));
  const next = (predicate: (frame: Frame) => boolean, after = frames.length): Promise<Frame> => {
    const existing = frames.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const check = () => {
        const value = frames.slice(after).find(predicate);
        if (value) { listeners.delete(check); resolve(value); }
      };
      listeners.add(check);
    });
  };
  const change = (scope: Scope, after = frames.length) => next(frame => frame.kind === 'workspace-change'
    && frame.scope?.project === scope.project && frame.scope.node === scope.node
    && frame.scope.path === scope.path && frame.scope.kind === scope.kind, after);
  return { frames, send, next, change, close,
    async subscribe(scope: Scope) {
      const changed = change(scope);
      send({ kind: 'workspace-subscribe', scope });
      return changed;
    },
  };
}

const workspaceFrames = (frames: Frame[]) => frames.filter(frame => frame.kind === 'workspace-change');

test('external nested edits, same-length replacement, rename and deletion invalidate live workspace scopes', { timeout: testTimeout }, async t => {
  const f = await fixture(t), wire = await connect(f);
  const folder = { ...f.a.scope, path: 'nested' };
  const file = { ...folder, path: 'nested/result.txt', kind: 'file' as const };
  await mkdir(join(f.a.workspace, 'nested'));
  await writeFile(join(f.a.workspace, file.path), 'first');
  assert.equal((await wire.subscribe(folder)).state, 'changed');
  assert.equal((await wire.subscribe(file)).state, 'changed');
  const base = `/api/projects/${file.project}/nodes/${file.node}`;
  const preview = () => f.request({ method: 'GET', url: `${base}/file?path=${file.path}` });
  const original = (await preview()).json<{ version: string }>();

  let updated = wire.change(file);
  await writeFile(join(f.a.workspace, file.path), 'other');
  assert.equal((await updated).state, 'changed');
  const changed = (await preview()).json<{ text: string; version: string }>();
  assert.equal(changed.text, 'other'); assert.notEqual(changed.version, original.version);

  // Editors commonly save through a temporary file plus atomic rename.
  await writeFile(join(f.a.workspace, 'nested/replacement.tmp'), 'third');
  updated = wire.change(file);
  await rename(join(f.a.workspace, 'nested/replacement.tmp'), join(f.a.workspace, file.path));
  assert.equal((await updated).state, 'changed');
  assert.equal((await preview()).json().text, 'third');

  const moved = wire.change(folder), removed = wire.change(file);
  await rename(join(f.a.workspace, file.path), join(f.a.workspace, 'nested/renamed.txt'));
  await moved; await removed;
  const listed = await f.request({ method: 'GET', url: `${base}/files?path=nested` });
  assert.equal(listed.statusCode, 200);
  assert.match(listed.body, /renamed\.txt/); assert.doesNotMatch(listed.body, /result\.txt/);

  const deleted = wire.change(folder);
  await rm(join(f.a.workspace, 'nested/renamed.txt'));
  await deleted;
  const created = wire.change(file);
  await writeFile(join(f.a.workspace, file.path), 'again');
  assert.equal((await created).state, 'changed');
  assert.equal((await preview()).json().text, 'again');
  assert.equal(wire.frames.some(frame => frame.kind === 'snapshot' || frame.kind === 'event'), false);
});

test('subscriptions isolate nodes and projects and reconnect discovers changes made while disconnected', { timeout: testTimeout }, async t => {
  const f = await fixture(t), b = await f.project('Workspace B'), node = f.id();
  const created = await f.request({ method: 'POST', url: `/api/projects/${f.a.value.id}/graph`, payload: {
    operationId: f.id(), revision: f.runtime.tree.graph(f.a.value.id).revision,
    command: { kind: 'node.create', id: node, title: 'Independent node', description: '' },
  } });
  assert.equal(created.statusCode, 200);
  const secondNode = { ...f.a.scope, node };
  const wire = await connect(f), otherProject = await connect(f), otherNode = await connect(f);
  await wire.subscribe(f.a.scope); await otherProject.subscribe(b.scope); await otherNode.subscribe(secondNode);
  const beforeActivity = wire.frames.length;
  const refreshed = wire.next(frame => frame.kind === 'refresh');
  f.runtime.agents.emit('change'); await refreshed;
  assert.deepEqual(workspaceFrames(wire.frames.slice(beforeActivity)), [], 'worker activity cannot invalidate workspace scopes');
  const projectMark = otherProject.frames.length, nodeMark = otherNode.frames.length;
  const changed = wire.change(f.a.scope);
  await writeFile(join(f.a.workspace, 'new.txt'), 'external write'); await changed;
  assert.deepEqual(workspaceFrames(otherProject.frames.slice(projectMark)), []);
  assert.deepEqual(workspaceFrames(otherNode.frames.slice(nodeMark)), []);

  await wire.close();
  await writeFile(join(f.a.workspace, 'offline.txt'), 'written without a browser');
  const reopened = await connect(f);
  assert.equal((await reopened.subscribe(f.a.scope)).state, 'changed');
  const listing = await f.request({ method: 'GET', url: `/api/projects/${f.a.scope.project}/nodes/${f.a.scope.node}/files` });
  assert.equal(listing.statusCode, 200); assert.match(listing.body, /offline\.txt/);
  const projectChanged = otherProject.change(b.scope), nodeChanged = otherNode.change(secondNode);
  await writeFile(join(b.workspace, 'own.txt'), 'B');
  await writeFile(join(f.runtime.tree.workspace(secondNode.project, secondNode.node), 'own.txt'), 'node');
  await projectChanged; await nodeChanged;
  assert.deepEqual(workspaceFrames(otherProject.frames).map(frame => frame.scope?.project),
    workspaceFrames(otherProject.frames).map(() => b.scope.project));
  assert.ok(workspaceFrames(otherNode.frames).every(frame => frame.scope?.node === secondNode.node));
});

test('shared browser subscriptions retain observation until the final release and return watch capacity', { timeout: testTimeout }, async t => {
  const f = await fixture(t, { maxWorkspaceWatches: 1 }), b = await f.project('Workspace B');
  const first = await connect(f), second = await connect(f), third = await connect(f);
  await first.subscribe(f.a.scope); await second.subscribe(f.a.scope);
  const denied = third.next(frame => frame.kind === 'error' || frame.state === 'unavailable');
  third.send({ kind: 'workspace-subscribe', scope: b.scope });
  const refused = await denied;
  assert.match(refused.error ?? refused.detail ?? '', /limit|watch|subscription|capacity/i);
  await first.close();
  const retained = second.change(f.a.scope);
  await writeFile(join(f.a.workspace, 'retained.txt'), 'shared observation'); await retained;
  second.send({ kind: 'workspace-unsubscribe', scope: f.a.scope });
  // Ordered commands on one socket establish release before the subsequent admission.
  assert.equal((await second.subscribe(b.scope)).state, 'changed');
  const afterRelease = second.frames.length;
  await writeFile(join(f.a.workspace, 'unsubscribed.txt'), 'no observer');
  const ownChange = second.change(b.scope);
  await writeFile(join(b.workspace, 'observed.txt'), 'new owner'); await ownChange;
  assert.ok(workspaceFrames(second.frames.slice(afterRelease)).every(frame => frame.scope?.project === b.scope.project));
  await second.close();
  assert.equal((await third.subscribe(f.a.scope)).state, 'changed', 'closing the final subscriber releases watch capacity');
});

test('workspace observation enforces browser authentication, project ownership and admitted file paths', { timeout: testTimeout }, async t => {
  const f = await fixture(t, { maxWorkspaceWatches: 1, maxExpandedDirectories: 1, maxFileTabs: 1 }), b = await f.project('Workspace B');
  await assert.rejects(f.runtime.app.injectWS('/api/live', { headers: { host: f.host, origin: f.origin } }), /401/);
  await assert.rejects(f.runtime.app.injectWS('/api/live', { headers: { host: f.host, origin: 'https://foreign.invalid', cookie: f.cookie } }), /403/);
  const wire = await connect(f);
  const outside = join(f.root, 'private.txt'); await writeFile(outside, 'private data');
  for (const name of ['redirected.txt', 'another-link.txt']) await symlink(outside, join(f.a.workspace, name));
  const scopes: Scope[] = [
    { ...f.a.scope, node: b.scope.node },
    ...['../private.txt', '.git/config', '.polariton/private', 'redirected.txt', 'another-link.txt'].map(path => ({ ...f.a.scope, kind: 'file' as const, path })),
  ];
  for (const scope of scopes) {
    const refused = wire.next(frame => frame.kind === 'error' || frame.kind === 'workspace-change');
    wire.send({ kind: 'workspace-subscribe', scope });
    const frame = await refused;
    assert.ok(frame.kind === 'error' || frame.state === 'unavailable', `Unexpected admission of ${scope.path || scope.node}`);
    assert.doesNotMatch(JSON.stringify(frame), /private data|capacity|too many workspace subscriptions/i);
  }
  assert.equal((await wire.subscribe(f.a.scope)).state, 'changed', 'invalid subscriptions do not poison a valid view');
});
