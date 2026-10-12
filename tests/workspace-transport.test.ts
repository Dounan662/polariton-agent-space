import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {Observations, type BrowserPolicy} from '../web/src/observations.ts';
import type {WorkspaceChange, WorkspaceScope} from '../src/workspace-contracts.ts';

const policy: BrowserPolicy = {
 nativePicker:{available:false,reason:'Headless test host'},
  filePageBytes: 1024, workspaceReadTimeoutMs: 100, workspaceDebounceMs: 10,
  workspaceReconcileMs: 1000, workspaceReadRetries: 2, choicesPollMs: 1000,
  minPanelWidth: 100, minContentWidth: 100, keyboardResizeStep: 10,
  maxPdfPages: 10, maxPdfPixels: 10000, maxFileTabs: 5, maxExpandedDirectories: 5,
  reconnectMs: 10, maxReconnectMs: 100, maxSubscriptions: 5,
  maxHistoryEvents: 100, historyCacheLimit: 5, maxFileBytes: 10000,
};
const project = '11111111-1111-4111-8111-111111111111';
const node = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const root: WorkspaceScope = {project, node, kind: 'directory', path: ''};
const file: WorkspaceScope = {project, node, kind: 'file', path: 'results.txt'};
type Command = {kind: string; scope?: WorkspaceScope};

function fixture(t: TestContext) {
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent: Command[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    constructor(_url: string) {sockets.push(this);}
    send(data: string) {this.sent.push(JSON.parse(data));}
    open() {this.readyState = Socket.OPEN; this.onopen?.();}
    close() {if (this.readyState === 3) return; this.readyState = 3; this.onclose?.();}
    receive(value: unknown) {this.onmessage?.({data: JSON.stringify(value)});}
    changed(scope: WorkspaceScope) {this.receive({kind: 'workspace-change', scope, state: 'changed'});}
  }
  const priorSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: Socket});
  Object.defineProperty(globalThis, 'location', {configurable: true, value: {host: 'localhost:9911'}});
  t.mock.timers.enable({apis: ['setTimeout']});
  let activity = 0;
  const connection: boolean[] = [];
  const observations = new Observations(policy, () => activity++, connected => connection.push(connected));
  t.after(() => {
    observations.close();
    if (priorSocket) Object.defineProperty(globalThis, 'WebSocket', priorSocket); else Reflect.deleteProperty(globalThis, 'WebSocket');
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation); else Reflect.deleteProperty(globalThis, 'location');
  });
  return {observations, sockets, connection, activity: () => activity};
}

test('workspace transport isolates exact resource scopes from general and worker refreshes', t => {
  const f = fixture(t), directoryEvents: WorkspaceChange[] = [], fileEvents: WorkspaceChange[] = [];
  f.observations.observeWorkspace(root, change => directoryEvents.push(change));
  f.observations.observeWorkspace(file, change => fileEvents.push(change));
  const socket = f.sockets[0]!; socket.open();
  socket.receive({kind: 'refresh'});
  socket.receive({kind: 'event', workerId: other});
  assert.equal(f.activity(), 2);
  assert.deepEqual(directoryEvents, []); assert.deepEqual(fileEvents, []);
  for (const scope of [{...root, project: other}, {...root, node: other}, {...root, path: 'results'}, {...file, kind: 'directory' as const}]) socket.changed(scope);
  assert.deepEqual(directoryEvents, []); assert.deepEqual(fileEvents, []);
  socket.changed(root);
  assert.deepEqual(directoryEvents, [{scope: root, state: 'changed'}]);
  assert.deepEqual(fileEvents, []);
  socket.changed(file);
  assert.deepEqual(fileEvents, [{scope: file, state: 'changed'}]);
  assert.equal(f.activity(), 2, 'workspace changes must not refresh unrelated panels');
});

test('shared subscriptions release only when their last owner leaves', t => {
  const f = fixture(t), first: WorkspaceChange[] = [], second: WorkspaceChange[] = [];
  const socket = f.sockets[0]!; socket.open();
  const releaseFirst = f.observations.observeWorkspace(root, change => first.push(change));
  const releaseSecond = f.observations.observeWorkspace({...root}, change => second.push(change));
  assert.deepEqual(socket.sent, [{kind: 'workspace-subscribe', scope: root}]);
  releaseFirst(); socket.changed(root);
  assert.deepEqual(first, []); assert.equal(second.length, 1);
  assert.equal(socket.sent.length, 1);
  releaseSecond();
  assert.deepEqual(socket.sent.at(-1), {kind: 'workspace-unsubscribe', scope: root});
  socket.changed(root); assert.equal(second.length, 1);
});

test('reconnect resubscribes retained resources once and omits owners released while disconnected', t => {
  const f = fixture(t), events: WorkspaceChange[] = [];
  f.observations.observeWorkspace(root, change => events.push(change));
  f.observations.observeWorkspace({...root}, () => {});
  const releaseFile = f.observations.observeWorkspace(file, () => {});
  const first = f.sockets[0]!; first.open(); first.close();
  assert.equal(events.at(-1)?.state, 'unavailable');
  releaseFile();
  t.mock.timers.tick(policy.reconnectMs);
  assert.equal(f.sockets.length, 2);
  const second = f.sockets[1]!; second.open();
  assert.deepEqual(second.sent, [{kind: 'workspace-subscribe', scope: root}]);
  second.changed(root);
  assert.equal(events.at(-1)?.state, 'changed');
  assert.deepEqual(f.connection, [true, false, true]);
});

test('closing cancels scheduled reconnect and clears all workspace listeners', t => {
  const f = fixture(t), events: WorkspaceChange[] = [];
  f.observations.observeWorkspace(root, change => events.push(change));
  const socket = f.sockets[0]!; socket.open(); socket.close();
  const count = events.length;
  f.observations.close();
  t.mock.timers.tick(policy.maxReconnectMs * 2);
  socket.changed(root);
  assert.equal(events.length, count);
  assert.equal(f.sockets.length, 1);
  f.observations.observeWorkspace(root, change => events.push(change));
  socket.changed(root);
  assert.equal(events.length, count, 'closed transport must not accept new subscriptions');
});

test('release is idempotent and cannot remove a replacement subscription', t => {
  const f = fixture(t), socket = f.sockets[0]!; socket.open();
  const release = f.observations.observeWorkspace(root, () => {});
  release();
  let changes = 0;
  f.observations.observeWorkspace(root, () => changes++);
  const count = socket.sent.length;
  release(); socket.changed(root);
  assert.equal(changes, 1);
  assert.equal(socket.sent.length, count);
});

test('two owners may reuse a callback without sharing subscription lifetime', t => {
  const f = fixture(t), socket = f.sockets[0]!; socket.open();
  let changes = 0;
  const listener = () => changes++;
  const first = f.observations.observeWorkspace(root, listener);
  const second = f.observations.observeWorkspace(root, listener);
  first(); socket.changed(root);
  assert.equal(changes, 1);
  assert.equal(socket.sent.length, 1);
  second(); assert.equal(socket.sent.length, 2);
});
