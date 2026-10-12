import {testDeadline} from './fixtures/timing.ts';
import {activationText,isActivationPrompt,awaitSubmission} from './fixtures/activation.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { testConfig } from './fixtures/config.ts';
import { createHash } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { createApp } from '../src/main.ts';
import { type Config } from '../src/config.ts';
import type {HarnessPort,HarnessEvents,HarnessFactory,InputPart,Activity} from '../harness/contracts.ts';
import type { HistoryEvent, Project, WorkerView } from '../src/contracts.ts';
import { persistMedia } from './fixtures/media.mjs';
import { persistHistory } from './fixtures/history.mjs';
import {configureTestProviders} from './fixtures/providers.ts';
import sharp from 'sharp';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC', 'base64');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const model = (value: string) => JSON.stringify(['custom-fixture', value]);
function barrier<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
type Baseline = { events: HistoryEvent[]; cursor: number; assistantStream: { revision: number } };

/** Only the execution neighbor is fake. HTTP routing, ownership, auth, persistence and WS transport are real. */
class ApiHarness extends EventEmitter<HarnessEvents> implements HarnessPort {
  private readonly signals=new EventEmitter<{opening:[]}>();
  id: string; model: string; closed = false;
  calls: { method: string; params: unknown }[] = [];
  openings: ReturnType<typeof barrier<Baseline>>[] = [];
  holdObservation = false;
  constructor(id: string, selected: string) { super(); this.id = id; this.model = selected; }
  async start() { return {image:true}; }
  options() { return [{ id: 'model', name: 'Model', type: 'select', currentValue: model(this.model), options: [
    { value: model('fixture-a'), name: 'Fixture A' }, { value: model('fixture-b'), name: 'Fixture B' },
  ] }]; }
  async locate(){return null;}
  async activate(sessionId:string|null,servers:Parameters<HarnessPort['activate']>[1]){this.calls.push({method:'activate',params:{sessionId,servers}});return {sessionId:this.id,options:this.options(),mcp:[]};}
  async configure(sessionId:string,id:string,value:string){this.calls.push({method:'configure',params:{sessionId,id,value}});this.model=JSON.parse(value)[1];return this.options();}
  async models(){return this.options()[0]!.options.map(option=>({...option,image:true}));}
  async activity():Promise<Activity>{return {revision:0,eligible:false,blockers:[{kind:'unknown'}]};}
  async suspend(){return {suspended:false,snapshot:await this.activity()};}
  async interrupt(){}
  async closeSession(){}
  async message(sessionId:string,requestId:string,content:InputPart[]){
    const input={sessionId,requestId,content};this.calls.push({method:'message',params:input});
    if(!isActivationPrompt(input))throw new Error('Only activation input expected');
    const event={type:'user/message',seq:0,time:1000,data:{source:{kind:'user',rpcId:requestId},content}};this.emit('source',{sessionId:this.id,seq:0,type:event.type,event});this.emit('submission',{sessionId:this.id,requestId,state:'applied'});return {messageId:requestId};
  }
  async observe(){
    if(!this.holdObservation)return {events:[],cursor:-1,assistantStream:{revision:0}};
    const result=barrier<Baseline>();this.openings.push(result);this.signals.emit('opening');return result.promise;
  }
  async close() { if (this.closed) return; this.closed = true; this.emit('exit'); }
  opened(count = 1) {
    if (this.openings.length >= count) return Promise.resolve();
    return new Promise<void>(resolve => { const check = () => { if (this.openings.length >= count) { this.signals.off('opening', check); resolve(); } }; this.signals.on('opening', check); });
  }
}

async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-adr006-web-');
  const config = { ...await testConfig(root), ...overrides, stateRoot: root, provider:'custom-fixture', model: 'fixture-a', verification: false };
  await configureTestProviders(config,[{id:'fixture-a',name:'Fixture A',image:true},{id:'fixture-b',name:'Fixture B',image:true}]);
  const harnesses = new Map<string, ApiHarness[]>(); let launches = 0;
  const factory: HarnessFactory = (settings, home) => { launches++; const id = basename(home); const harness = new ApiHarness(`native-${id}`, (settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model)); harnesses.set(id, [...harnesses.get(id) ?? [], harness]); return harness; };
  const runtime = await createApp(config, factory); await runtime.app.ready();
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await runtime.app.close(); await rm(root, { recursive: true, force: true }); });
  const host = `127.0.0.1:${config.port}`, origin = `http://${host}`; let cookie = '', sequence = 0;
  const id = () => `70000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const request = (options: InjectOptions) => runtime.app.inject({ ...options,
    headers: { host, cookie, ...(options.method && options.method !== 'GET' ? { origin } : {}), ...options.headers } });
  const token = new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token')!;
  const authenticated = await request({ method: 'POST', url: '/api/bootstrap', payload: { token } }); assert.equal(authenticated.statusCode, 200);
  cookie = (authenticated.headers['set-cookie'] as string).split(';')[0]!;
  const project = async (name: string) => { const response = await request({ method: 'POST', url: '/api/projects', payload: { id:id(), name } }); assert.equal(response.statusCode, 200); return response.json<Project>(); };
  const a = await project('A'), b = await project('B'); const node = id(), foreignNode = id();
  for (const [project, value] of [[a, node], [b, foreignNode]] as const) {
    const response = await request({ method: 'POST', url: `/api/projects/${project.id}/graph`, payload: { operationId: id(), revision: runtime.tree.graph(project.id).revision, command: { kind: 'node.create', id: value, title: 'Synthetic node', description: '' } } }); assert.equal(response.statusCode, 200);
  }
  const base = `/api/projects/${a.id}/nodes/${node}`, foreignBase = `/api/projects/${b.id}/nodes/${foreignNode}`;
  const workers: WorkerView[] = [];
  for (const name of ['First', 'Second']) { const response = await request({ method: 'POST', url: `${base}/workers`, payload: { id: id(), title: name } }); assert.equal(response.statusCode, 200); workers.push(response.json()); }
  const first = workers[0]!, second = workers[1]!;
  return { root, runtime, config, host, origin, cookie, id, request, a, b, node, foreignNode, base, foreignBase, first, second, cleanups,
    get launches() { return launches; }, harness(worker = first.id) { return harnesses.get(worker)!.at(-1)!; },
    async activate(worker = first.id) {
      const submission=id();const result=await request({method:'POST',url:`${base}/workers/${worker}/submissions`,payload:{id:submission,text:activationText}});
      assert.equal(result.statusCode,200);await awaitSubmission(runtime.agents,a.id,node,worker,submission);
    },
  };
}

/** Captures every wire frame before subscription starts and provides predicate barriers without sleeps. */
async function socketFor(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  type Frame = { kind: string; workerId?: string; generation?: string; sequence?: number; event?: HistoryEvent; error?: string; page?: { events: HistoryEvent[] }; [key: string]: unknown };
  const frames: Frame[] = []; const listeners = new Set<() => void>();
  const socket = await f.runtime.app.injectWS('/api/live', { headers: { host: f.host, origin: f.origin, cookie: f.cookie } }, {
    onInit: ws => ws.on('message', (raw: unknown) => { frames.push(JSON.parse(String(raw)) as Frame); for (const listener of listeners) listener(); }),
  });
  f.cleanups.push(async () => { if (socket.readyState !== socket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed; } });
  return { socket, frames,
    send(value: unknown) { socket.send(JSON.stringify(value)); },
    subscribe(worker = f.first.id) { socket.send(JSON.stringify({ kind: 'subscribe', project: f.a.id, node: f.node, workerId:worker })); },
    until(predicate: (frames: Frame[]) => boolean) { if (predicate(frames)) return Promise.resolve(); return new Promise<void>(resolve => { const check = () => { if (predicate(frames)) { listeners.delete(check); resolve(); } }; listeners.add(check); }); },
  };
}
const sourceEvent = (seq: number): HistoryEvent => ({ seq, time: 1000 + seq, type: 'synthetic/event', data: { seq } });
const baseline = (cursor = -1): Baseline => ({ events: Array.from({ length: cursor + 1 }, (_, seq) => sourceEvent(seq)), cursor, assistantStream: { revision: 0 } });

test('workspace upload, publication, paging and media require auth and retain scoped collision protection', { timeout: 5000 }, async t => {
  const f = await fixture(t, { filePageBytes: 4 }); const bytes = Buffer.from('Synthetic file');
  const input = { operationId: f.id(), path: 'nested/result.txt', digest: hash(bytes) };
  const upload = `${f.base}/uploads?${new URLSearchParams(input)}`;
  assert.equal((await f.request({ method: 'POST', url: upload, headers: { cookie: '', 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode, 401);
  assert.equal((await f.request({ method: 'POST', url: upload, headers: { origin: 'https://foreign.invalid', 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode, 403);
  assert.equal((await f.request({ method: 'POST', url: upload, headers: { 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode, 200);
  assert.equal((await f.request({ method: 'POST', url: `${f.foreignBase}/uploads/publish`, payload: input })).statusCode, 404);
  assert.equal((await f.request({ method: 'POST', url: `${f.base}/uploads/publish`, payload: input })).statusCode, 200);
  const preview = await f.request({ method: 'GET', url: `${f.base}/file?path=nested/result.txt` }); assert.equal(preview.statusCode, 200); assert.equal(preview.json().text, 'Synt');
  const media = await f.request({ method: 'GET', url: `${f.base}/media?path=nested/result.txt&version=${input.digest}` }); assert.equal(media.statusCode, 200); assert.deepEqual(media.rawPayload, bytes); assert.match(media.headers['content-type'] as string, /text\/plain/);
  await writeFile(join(f.runtime.tree.workspace(f.a.id, f.node), input.path), 'independent edit');
  assert.equal((await f.request({ method: 'GET', url: `${f.base}/file?path=nested/result.txt&offset=4&version=${input.digest}` })).statusCode, 409);
  assert.equal((await f.request({ method: 'GET', url: `${f.base}/media?path=nested/result.txt&version=${input.digest}` })).statusCode, 409);
  for (const path of ['../escape.txt', '.git/config', '.polariton/secret']) {
    const result = await f.request({ method: 'POST', url: `${f.base}/uploads?${new URLSearchParams({ ...input, operationId: f.id(), path })}`, headers: { 'content-type': 'application/octet-stream' }, payload: bytes }); assert.equal(result.statusCode, 403);
  }
  assert.equal(f.launches, 0);
});

test('archive, configure and staged images enforce worker identity and advertised choices', { timeout: 5000 }, async t => {
  const f = await fixture(t), worker = `${f.base}/workers/${f.first.id}`, foreign = `${f.foreignBase}/workers/${f.first.id}`;
  for (const [action, payload] of [['archive', { archived: true }], ['configure', { configId: 'model', value: model('fixture-b') }]] as const) {
    assert.equal((await f.request({ method: 'POST', url: `${worker}/${action}`, headers: { cookie: '' }, payload })).statusCode, 401);
    assert.equal((await f.request({ method: 'POST', url: `${foreign}/${action}`, payload })).statusCode, 404);
  }
  const archived = await f.request({ method: 'POST', url: `${worker}/archive`, payload: { archived: true } }); assert.equal(archived.json<WorkerView>().archived, true); assert.equal(f.launches, 0);
  assert.equal((await f.request({ method: 'POST', url: `${worker}/configure`, payload: { configId: 'model', value: model('fixture-b') } })).statusCode, 200);
  await f.activate(); const firstProcess = f.runtime.agents.list(f.a.id, f.node)[0]!.processId;
  assert.equal((await f.request({ method: 'POST', url: `${worker}/configure`, payload: { configId: 'model', value: model('unadvertised') } })).statusCode, 400);
  const configured = await f.request({ method: 'POST', url: `${worker}/configure`, payload: { configId: 'model', value: model('fixture-b') } }); assert.equal(configured.statusCode, 200); assert.notEqual(configured.json<WorkerView>().processId, firstProcess);
  const id = f.id(); const url = `${worker}/images?${new URLSearchParams({ id, name: 'pixel.png', mediaType: 'image/png' })}`;
  assert.equal((await f.request({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: png })).statusCode, 200);
  const read = await f.request({ method: 'GET', url: `${worker}/staged-image?id=${id}` }); assert.equal(read.statusCode, 200); assert.deepEqual(read.rawPayload, png);
  assert.equal((await f.request({ method: 'GET', url: `${f.base}/workers/${f.second.id}/staged-image?id=${id}` })).statusCode, 404);
  assert.equal((await f.request({ method: 'GET', url: `${foreign}/staged-image?id=${id}` })).statusCode, 404);
  assert.equal((await f.request({ method: 'GET', url: `${worker}/staged-image?id=${id}`, headers: { cookie: '' } })).statusCode, 401);
});

test('image ingress rejects truncated encoded images before issuing an accepted receipt', { timeout: 5000 }, async t => {
  const f = await fixture(t); const signatures = [
    { mediaType: 'image/png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    { mediaType: 'image/jpeg', bytes: Buffer.from([255, 216]) },
    { mediaType: 'image/gif', bytes: Buffer.from('GIF89a') },
    { mediaType: 'image/webp', bytes: Buffer.from('RIFF0000WEBP') },
  ];
  for (const fixture of signatures) {
    const id = f.id(), worker = `${f.base}/workers/${f.first.id}`;
    const response = await f.request({ method: 'POST', url: `${worker}/images?${new URLSearchParams({ id, name: 'truncated', mediaType: fixture.mediaType })}`, headers: { 'content-type': 'application/octet-stream' }, payload: fixture.bytes });
    assert.equal(response.statusCode, 400, `signature alone is not a decoded ${fixture.mediaType}`);
    assert.equal((await f.request({ method: 'GET', url: `${worker}/staged-image?id=${id}` })).statusCode, 404);
  }
  assert.equal(f.launches, 0);
});

for (const limit of ['pixel', 'decoded-byte'] as const) {
  test(`image ingress enforces its configured ${limit} allocation limit`, { timeout: 5000 }, async t => {
    const config: Partial<Config> = limit === 'pixel' ? { maxImagePixels: 1 } : { maxDecodedImageBytes: 3 };
    const bytes = limit === 'pixel' ? await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer() : png;
    const f = await fixture(t, config), id = f.id(), worker = `${f.base}/workers/${f.first.id}`;
    const result = await f.request({ method: 'POST', url: `${worker}/images?${new URLSearchParams({ id, name: 'bounded.png', mediaType: 'image/png' })}`, headers: { 'content-type': 'application/octet-stream' }, payload: bytes });
    assert.equal(result.statusCode, 400); assert.equal(result.json().error.code, 'IMAGE_DECODE');
    assert.equal((await f.request({ method: 'GET', url: `${worker}/staged-image?id=${id}` })).statusCode, 404);
    assert.equal(f.launches, 0);
  });
}

test('recorded image lookup is authorized by durable worker references without cold activation', { timeout: testDeadline(5000) }, async t => {
  const f = await fixture(t); await f.activate(); await f.activate(f.second.id);
  const native = f.runtime.agents.list(f.a.id, f.node)[0]!.harnessSessionId!;
  await f.runtime.agents.closeWorker(f.a.id, f.node, f.first.id); await f.runtime.agents.closeWorker(f.a.id, f.node, f.second.id);
  const media = await persistMedia(join(f.root, 'harness', f.first.id), native);
  await persistHistory(join(f.root, 'harness', f.second.id, 'sessions'), f.runtime.agents.list(f.a.id, f.node)[1]!.harnessSessionId!);
  const id = encodeURIComponent(media.image.attachmentId), launches = f.launches;
  const response = await f.request({ method: 'GET', url: `${f.base}/workers/${f.first.id}/image?id=${id}` }); assert.equal(response.statusCode, 200);
  assert.equal((await f.request({ method: 'GET', url: `${f.base}/workers/${f.first.id}/image?id=${id}`, headers: { cookie: '' } })).statusCode, 401);
  assert.equal((await f.request({ method: 'GET', url: `${f.foreignBase}/workers/${f.first.id}/image?id=${id}` })).statusCode, 404);
  const foreignImage=await f.request({method:'GET',url:`${f.base}/workers/${f.second.id}/image?id=${id}`});assert.equal(foreignImage.statusCode,404,foreignImage.body);
  assert.equal((await f.request({ method: 'GET', url: `${f.base}/workers/${f.first.id}/image?id=${encodeURIComponent('sha256:' + '0'.repeat(64))}` })).statusCode, 404);
  assert.equal(f.launches, launches);
});

test('WS sends a baseline before buffered suffix, filters overlap and multiplexes independently', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.activate(); await f.activate(f.second.id);
  const first = f.harness(), second = f.harness(f.second.id); first.holdObservation = true; second.holdObservation = true;
  const wire = await socketFor(t, f); wire.subscribe(); await first.opened(); wire.subscribe(f.second.id); await second.opened();
  first.emit('source', { sessionId: first.id, seq: 1, type: 'synthetic/event', event: sourceEvent(1) });
  first.emit('source', { sessionId: first.id, seq: 2, type: 'synthetic/event', event: sourceEvent(2) });
  assert.equal(wire.frames.filter(frame => frame.workerId === f.first.id).length, 0);
  second.openings[0]!.resolve(baseline()); await wire.until(frames => frames.some(frame => frame.kind === 'snapshot' && frame.workerId === f.second.id));
  first.openings[0]!.resolve(baseline(1)); await wire.until(frames => frames.some(frame => frame.kind === 'event' && frame.workerId === f.first.id));
  const frames = wire.frames.filter(frame => frame.workerId === f.first.id);
  assert.deepEqual(frames.map(frame => [frame.kind, frame.sequence]), [['snapshot', 0], ['event', 1]]);
  assert.equal(frames[1]!.event?.seq, 2); assert.equal(frames[1]!.generation, frames[0]!.generation);
  assert.notEqual(frames[0]!.generation, wire.frames.find(frame => frame.workerId === f.second.id)!.generation);
});

test('resubscription replaces an opening generation and unsubscribe prevents late publication', { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.activate(); const harness = f.harness(); harness.holdObservation = true;
  const wire = await socketFor(t, f); wire.subscribe(); await harness.opened(); wire.subscribe(); await harness.opened(2);
  harness.openings[1]!.resolve(baseline(1)); await wire.until(frames => frames.some(frame => frame.kind === 'snapshot'));
  harness.openings[0]!.resolve(baseline()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.frames.filter(frame => frame.kind === 'snapshot').length, 1);
  wire.subscribe(); await harness.opened(3); wire.send({ kind: 'unsubscribe', workerId: f.first.id });
  await new Promise(resolve => setImmediate(resolve)); harness.openings[2]!.resolve(baseline(2)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.frames.filter(frame => frame.kind === 'snapshot').length, 1);
});

test('subscription and opening-buffer limits fail observably without leaking late source', { timeout: 5000 }, async t => {
  const f = await fixture(t, { maxSubscriptions: 1, maxObservationEvents: 1 }); await f.activate();
  const harness = f.harness(); harness.holdObservation = true; const wire = await socketFor(t, f);
  wire.subscribe(); await harness.opened(); wire.subscribe(f.second.id); await wire.until(frames => frames.some(frame => frame.kind === 'error'));
  assert.match(String(wire.frames.find(frame => frame.kind === 'error')!.error), /subscription/i);
  for (const seq of [0, 1]) harness.emit('source', { sessionId: harness.id, seq, type: 'synthetic/event', event: sourceEvent(seq) });
  await wire.until(frames => frames.some(frame => frame.kind === 'observation-error'));
  harness.openings[0]!.resolve(baseline()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.frames.filter(frame => frame.kind === 'snapshot').length, 0);
  wire.subscribe(f.second.id); await wire.until(frames => frames.some(frame => frame.kind === 'snapshot' && frame.workerId === f.second.id));
  assert.equal(f.launches, 1, 'subscribing an inactive worker must not activate it');
});

test('WebSocket subscription identity substitution cannot expose another node worker', { timeout: 5000 }, async t => {
  const f = await fixture(t), wire = await socketFor(t, f);
  wire.send({ kind: 'subscribe', project: f.b.id, node: f.foreignNode, workerId: f.first.id });
  await wire.until(frames => frames.some(frame => frame.kind === 'observation-error'));
  assert.equal(wire.frames.some(frame => frame.kind === 'snapshot'), false); assert.equal(f.launches, 0);
  wire.subscribe(); await wire.until(frames => frames.some(frame => frame.kind === 'snapshot'));
  assert.equal(wire.frames.find(frame => frame.kind === 'snapshot')?.page, null);
});
