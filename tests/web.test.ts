import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { testConfig } from './fixtures/config.ts';
import { once } from 'node:events';
import type { InjectOptions } from 'fastify';
import { createApp } from '../src/main.ts';
import { type Config } from '../src/config.ts';
import type { Project, Graph, WorkerView, HistoryPage } from '../src/contracts.ts';
import type {HarnessFactory} from '../harness/contracts.ts';
import { ControlledHarness } from './fixtures/harness.ts';
import {configureTestProviders} from './fixtures/providers.ts';
import { activationText,awaitSubmission } from './fixtures/activation.ts';
import { persistMedia } from './fixtures/media.mjs';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';

/** An isolated browser boundary with optional deterministic harnesses; no provider requests. */
async function browser(t: TestContext, factory?: HarnessFactory, overrides:Partial<Config>={}) {
  const root = await temporaryDirectory('test-web-');
  const config = { ...await testConfig(root), verification: false, stateRoot: root, maxBodyBytes: 1024, ...overrides };
  if(factory)await configureTestProviders(config);
  let runtime = await createApp(config, factory);
  await runtime.app.ready();
  let cookie = '';
  t.after(async () => { await runtime.app.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${config.port}`;
  const host = `127.0.0.1:${config.port}`;
  let sequence = 0;
  const id = () => `30000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const request = (options: InjectOptions) => runtime.app.inject({
    ...options, headers: { host, ...(cookie ? { cookie } : {}), ...(options.method && options.method !== 'GET' ? { origin } : {}), ...options.headers },
  });
  const login = async () => {
    const token = new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token')!;
    const result = await request({ method: 'POST', url: '/api/bootstrap', payload: { token } });
    assert.equal(result.statusCode, 200);
    const header = result.headers['set-cookie'];
    assert.equal(typeof header, 'string');
    cookie = (header as string).split(';')[0]!;
    return { token, result };
  };
  const project = async (name: string) => {
    const result = await request({ method: 'POST', url: '/api/projects', payload: { id:id(), name } });
    assert.equal(result.statusCode, 200);
    return result.json<Project>();
  };
  const node = async (projectId: string) => {
    const result = await request({ method: 'GET', url: `/api/projects/${projectId}/graph` });
    const nodeId = id();
    const created = await request({ method: 'POST', url: `/api/projects/${projectId}/graph`, payload: {
      operationId: id(), revision: result.json<Graph>().revision,
      command: { kind: 'node.create', id: nodeId, title: 'Research node', description: '' },
    } });
    assert.equal(created.statusCode, 200);
    return nodeId;
  };
  return {
    root, config, origin, host, id, request, login, project, node,
    get runtime() { return runtime; }, get cookie() { return cookie; },
    async reopen() { await runtime.app.close(); runtime = await createApp(config, factory); await runtime.app.ready(); cookie = ''; },
  };
}

test('launch bootstrap is one-use and browser cookies are required for API reads', async t => {
  const b = await browser(t);
  assert.equal((await b.request({ method: 'GET', url: '/api/projects' })).statusCode, 401);
  const wrong = await b.request({ method: 'POST', url: '/api/bootstrap', payload: { token: 'incorrect-token' } });
  assert.equal(wrong.statusCode, 401);
  const { token, result } = await b.login();
  const header = result.headers['set-cookie'] as string;
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.match(header, /Path=\//i);
  const read = await b.request({ method: 'GET', url: '/api/projects' });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.headers['x-content-type-options'], 'nosniff');
  assert.match(read.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  assert.equal((await b.request({ method: 'POST', url: '/api/bootstrap', payload: { token } })).statusCode, 401);
  assert.equal((await b.request({ method: 'GET', url: '/api/projects', headers: { cookie: 'polariton=invalid' } })).statusCode, 401);
});

test('Host, Origin and fetch-site guards reject cross-origin reads and unauthenticated mutation sources', async t => {
  const b = await browser(t);
  await b.login();
  for (const host of ['attacker.invalid', `localhost:${b.config.port}`, `${b.host}.attacker.invalid`]) {
    assert.equal((await b.request({ method: 'GET', url: '/api/projects', headers: { host } })).statusCode, 403);
  }
  for (const origin of ['https://attacker.invalid', 'null', `${b.origin}.attacker.invalid`]) {
    assert.equal((await b.request({ method: 'GET', url: '/api/projects', headers: { origin } })).statusCode, 403);
  }
  assert.equal((await b.request({ method: 'GET', url: '/api/projects', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  const noOrigin = await b.runtime.app.inject({ method: 'POST', url: '/api/projects', headers: { host: b.host, cookie: b.cookie }, payload: { name: 'Denied' } });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal((await b.request({ method: 'POST', url: '/api/projects', headers: { origin: 'https://attacker.invalid' }, payload: { name: 'Denied' } })).statusCode, 403);
  assert.deepEqual((await b.request({ method: 'GET', url: '/api/projects' })).json(), []);
});

test('non-ASCII malformed authentication values are rejected without an internal error', async t => {
  const b = await browser(t);
  const token = new URLSearchParams(new URL(b.runtime.launchUrl).hash.slice(1)).get('token')!;
  const result = await b.request({ method: 'POST', url: '/api/bootstrap', payload: { token: 'é'.repeat(token.length) } });
  assert.equal(result.statusCode, 401);
  await b.login();
  const cookieValue = b.cookie.slice('polariton='.length);
  assert.equal((await b.request({ method: 'GET', url: '/api/projects', headers: { cookie: `polariton=${encodeURIComponent('é'.repeat(cookieValue.length))}` } })).statusCode, 401);
});

test('project/node/worker substitutions fail before any harness activation and refresh survives restart', async t => {
  const b = await browser(t);
  await b.login();
  const p1 = await b.project('First project'), p2 = await b.project('Second project');
  const a = await b.node(p1.id), c = await b.node(p2.id);
  const workers = `/api/projects/${p1.id}/nodes/${a}/workers`;
  const first = await b.request({ method: 'POST', url: workers, payload: { id: b.id(), title: 'One' } });
  const second = await b.request({ method: 'POST', url: workers, payload: { id: b.id(), title: 'Two' } });
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  const s1 = first.json<WorkerView>(), s2 = second.json<WorkerView>();
  assert.notEqual(s1.agentId, s2.agentId);
  const wrongNode = `/api/projects/${p1.id}/nodes/${c}`;
  for (const suffix of ['files', 'checkpoints', 'workers']) assert.equal((await b.request({ method: 'GET', url: `${wrongNode}/${suffix}` })).statusCode, 404);
  const wrongWorker = `/api/projects/${p2.id}/nodes/${c}/workers/${s1.id}`;
  assert.equal((await b.request({ method: 'GET', url: `${wrongWorker}/history` })).statusCode, 404);
  assert.equal((await b.request({ method: 'POST', url: `${wrongWorker}/resume`, payload: {} })).statusCode, 404);
  assert.equal((await b.request({ method: 'POST', url: `${wrongWorker}/submissions`, payload: { id: b.id(), text: 'must not execute' } })).statusCode, 404);
  assert.equal((await b.request({ method: 'POST', url: `${wrongWorker}/permissions`, payload: { id: b.id(), option: 'allow' } })).statusCode, 404);
  assert.equal((await b.request({ method: 'POST', url: `/api/projects/${p2.id}/nodes/${c}/workers`, payload: { id: s1.id, title: 'substituted' } })).statusCode, 409);
  const graph = (await b.request({ method: 'GET', url: `/api/projects/${p1.id}/graph` })).json();
  const savedWorkers = (await b.request({ method: 'GET', url: workers })).json();
  assert.deepEqual(savedWorkers, [s1, s2]);
  await b.reopen();
  assert.equal((await b.request({ method: 'GET', url: workers })).statusCode, 401);
  await b.login();
  assert.deepEqual((await b.request({ method: 'GET', url: `/api/projects/${p1.id}/graph` })).json(), graph);
  assert.deepEqual((await b.request({ method: 'GET', url: workers })).json(), savedWorkers);
});

test('workspace downloads reject traversal and symlink escape and render active content inertly', async t => {
  const b = await browser(t);
  await b.login();
  const project = await b.project('Files');
  const node = await b.node(project.id);
  const root = b.runtime.tree.workspace(project.id, node);
  const fileRoute = `/api/projects/${project.id}/nodes/${node}/file`;
  await writeFile(join(root, 'output.html'), '<script>alert("untrusted")</script>');
  const download = await b.request({ method: 'GET', url: `${fileRoute}?path=output.html` });
  assert.equal(download.statusCode, 200);
  assert.match(download.headers['content-type'] as string, /^application\/json/);
  const preview = download.json();
  assert.equal(preview.text, '<script>alert("untrusted")</script>');
  assert.match(preview.version, /^[a-f0-9]{64}$/);
  const media = await b.request({ method: 'GET', url: `/api/projects/${project.id}/nodes/${node}/media?path=output.html&version=${preview.version}` });
  assert.equal(media.statusCode, 200);
  assert.match(media.headers['content-type'] as string, /^text\/plain/);
  assert.equal(media.body, preview.text);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  for (const path of ['../outside', '.git/config', '/etc/passwd']) {
    assert.equal((await b.request({ method: 'GET', url: `${fileRoute}?path=${encodeURIComponent(path)}` })).statusCode, 403);
  }
  const outside = join(b.root, 'outside.txt');
  await writeFile(outside, 'outside authorized workspace');
  await symlink(outside, join(root, 'escape.txt'));
  assert.equal((await b.request({ method: 'GET', url: `${fileRoute}?path=escape.txt` })).statusCode, 403);
});

test('browser publishes during an active worker turn and derives publisher from authenticated access', async t => {
  let harness!:ControlledHarness;
  const ready=Promise.withResolvers<void>();
  const b=await browser(t,(_config,home,_workspace,_budget,permission)=>{
    harness=new ControlledHarness(`harness-${basename(home)}`,permission);ready.resolve();return harness;
  });
  await b.login();const project=await b.project('Active checkpoints'),node=await b.node(project.id);
  const base=`/api/projects/${project.id}/nodes/${node}`,worker=b.id();
  assert.equal((await b.request({method:'POST',url:`${base}/workers`,payload:{id:worker,title:'Still working'}})).statusCode,200);
  const sent=await b.request({method:'POST',url:`${base}/workers/${worker}/submissions`,payload:{id:b.id(),text:'Continue working'}});
  assert.equal(sent.statusCode,200);await ready.promise;await harness.promptEntered.promise;
  await writeFile(join(b.runtime.tree.workspace(project.id,node),'unfinished.txt'),'partial work');
  const payload={id:b.id(),note:'Unfinished work retained'};
  const published=await b.request({method:'POST',url:`${base}/checkpoints`,payload});
  assert.equal(published.statusCode,200,published.body);
  const checkpoint=published.json();
  assert.deepEqual(checkpoint.publisher,{kind:'owner',id:'local-owner'});
  assert.equal(checkpoint.note,payload.note);assert.equal(checkpoint.capture.consistency,'cooperative-verified');
  assert.equal(b.runtime.agents.get(worker).state,'running');
  assert.deepEqual((await b.request({method:'POST',url:`${base}/checkpoints`,payload})).json(),checkpoint);
  assert.deepEqual((await b.request({method:'GET',url:`${base}/checkpoints`})).json(),[checkpoint]);
  for(const field of [{externalEditorsPaused:true},{publisher:{kind:'worker',id:worker,processId:b.id()}}]){
    assert.equal((await b.request({method:'POST',url:`${base}/checkpoints`,payload:{id:b.id(),...field}})).statusCode,400);
  }
  harness.complete();
});

test('malformed JSON and oversized bodies preserve client-error HTTP status', async t => {
  const b = await browser(t);
  await b.login();
  const malformed = await b.request({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: '{malformed' });
  assert.equal(malformed.statusCode, 400);
  const oversized = await b.request({ method: 'POST', url: '/api/projects', payload: { name: 'x'.repeat(b.config.maxBodyBytes + 1) } });
  assert.equal(oversized.statusCode, 413);
});

test('cold retained media is scoped to its worker and history cut, integrity checked and served inertly', async t => {
  let activations = 0;
  const factory: HarnessFactory = (_config, home, _workspace, _budget, permission) => {
    activations++;
    return new ControlledHarness(`harness-${basename(home)}`, permission);
  };
  const b = await browser(t, factory);
  await b.login();
  const project = await b.project('Media evidence'), otherProject = await b.project('Other evidence');
  const node = await b.node(project.id), otherNode = await b.node(otherProject.id);
  const route = `/api/projects/${project.id}/nodes/${node}/workers`;
  const bind = async () => {
    const id = b.id();
    assert.equal((await b.request({ method: 'POST', url: route, payload: { id, title: 'Retained media' } })).statusCode, 200);
    assert.equal((await b.request({ method: 'POST', url: `${route}/${id}/resume`, payload: {} })).statusCode, 409);
    const submissionId=b.id();
    assert.equal((await b.request({method:'POST',url:`${route}/${id}/submissions`,payload:{id:submissionId,text:activationText}})).statusCode,200);
    await awaitSubmission(b.runtime.agents,project.id,node,id,submissionId);
    assert.equal((await b.request({ method: 'POST', url: `${route}/${id}/close`, payload: {} })).statusCode, 200);
    return id;
  };
  const first = await bind(), second = await bind();
  const fixture = await persistMedia(join(b.root, 'harness', first), `harness-${first}`);
  await persistMedia(join(b.root, 'harness', second), `harness-${second}`, 'second worker evidence');
  const historyResponse = await b.request({ method: 'GET', url: `${route}/${first}/history` });
  assert.equal(historyResponse.statusCode, 200);
  const history = historyResponse.json<HistoryPage>();
  assert.equal(history.formatVersion, SESSION_FORMAT_VERSION);
  assert.equal(history.sourceSessionId, `harness-${first}`);
  assert.equal(history.coverage, 'readable-persisted-prefix');
  assert.equal(history.attachments.length, 2);
  const image = history.attachments.find(value => value.mediaType === 'image/png')!;
  const file = history.attachments.find(value => value.mediaType === 'application/octet-stream')!;
  assert.ok(image); assert.ok(file);
  const query = (value: typeof image) => `cut=${history.cut}&seq=${value.seq}&index=${value.index}`;
  const imageResponse = await b.request({ method: 'GET', url: `${route}/${first}/attachment?${query(image)}` });
  assert.equal(imageResponse.statusCode, 200);
  assert.equal(imageResponse.headers['content-type'], 'image/png');
  assert.deepEqual(imageResponse.rawPayload, fixture.png);
  const fileResponse = await b.request({ method: 'GET', url: `${route}/${first}/attachment?${query(file)}` });
  assert.equal(fileResponse.statusCode, 200);
  assert.equal(fileResponse.headers['content-type'], 'application/octet-stream');
  assert.match(fileResponse.headers['content-disposition'] as string, /^attachment;/);
  assert.equal(fileResponse.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(fileResponse.rawPayload, fixture.fileBytes);
  assert.equal((await b.request({ method: 'GET', url: `${route}/${second}/attachment?${query(image)}` })).statusCode, 409);
  assert.equal((await b.request({ method: 'GET', url: `/api/projects/${otherProject.id}/nodes/${otherNode}/workers/${first}/attachment?${query(image)}` })).statusCode, 404);
  for (const suffix of [`cut=${history.cut}&seq=999&index=0`, `cut=${history.cut}&seq=${image.seq}&index=999`]) {
    assert.equal((await b.request({ method: 'GET', url: `${route}/${first}/attachment?${suffix}` })).statusCode, 404);
  }
  for (const suffix of [`cut=../../etc/passwd&seq=1&index=0`, `cut=${history.cut}&seq=-1&index=0`, 'path=/etc/passwd']) {
    assert.equal((await b.request({ method: 'GET', url: `${route}/${first}/attachment?${suffix}` })).statusCode, 400);
  }
  assert.equal((await b.runtime.app.inject({ method: 'GET', url: `${route}/${first}/attachment?${query(image)}`, headers: { host: b.host } })).statusCode, 401);
  assert.ok(fixture.imagePath);
  await chmod(fixture.imagePath, 0o600);
  await writeFile(fixture.imagePath, Buffer.alloc(fixture.png.length));
  const corrupt = await b.request({ method: 'GET', url: `${route}/${first}/attachment?${query(image)}` });
  assert.equal(corrupt.statusCode, 409);
  assert.equal(corrupt.json().error.code, 'ATTACHMENT_UNAVAILABLE');
  await b.reopen(); await b.login();
  assert.equal((await b.request({ method: 'GET', url: `${route}/${first}/attachment?${query(file)}` })).statusCode, 409);
  const refreshed = (await b.request({ method: 'GET', url: `${route}/${first}/history` })).json<HistoryPage>();
  const retained = refreshed.attachments.find(value => value.mediaType === 'application/octet-stream')!;
  const afterRestart = await b.request({ method: 'GET', url: `${route}/${first}/attachment?cut=${refreshed.cut}&seq=${retained.seq}&index=${retained.index}` });
  assert.equal(afterRestart.statusCode, 200);
  assert.deepEqual(afterRestart.rawPayload, fixture.fileBytes);
  assert.equal(activations, 2, 'cold source and attachment reads must not activate any harness');
});

test('WebSocket refresh uses the same cookie, Host and Origin boundary', { timeout: 10000 }, async t => {
  const b = await browser(t);
  await b.login();
  await assert.rejects(b.runtime.app.injectWS('/api/live', { headers: { host: b.host, origin: b.origin } }), /401/);
  await assert.rejects(b.runtime.app.injectWS('/api/live', { headers: { host: b.host, cookie: b.cookie, origin: 'https://attacker.invalid' } }), /403/);
  await assert.rejects(b.runtime.app.injectWS('/api/live', { headers: { host: 'attacker.invalid', cookie: b.cookie, origin: b.origin } }), /403/);
  let initial!: Promise<unknown[]>;
  const socket = await b.runtime.app.injectWS('/api/live', { headers: { host: b.host, cookie: b.cookie, origin: b.origin } }, { onInit: ws => { initial = once(ws, 'message'); } });
  try {
    const [payload] = await initial;
    assert.deepEqual(JSON.parse(String(payload)), { kind: 'refresh' });
    const changed = once(socket, 'message');
    await b.project('Live refresh');
    assert.deepEqual(JSON.parse(String((await changed)[0])), { kind: 'refresh' });
  } finally { const closed = once(socket, 'close'); socket.terminate(); await closed; }
});


test('native folder chooser requires authenticated same-origin requests before any dialog opens', async t => {
  const b = await browser(t);
  assert.equal((await b.request({method:'POST',url:'/api/directories/pick',payload:{}})).statusCode,401);
  await b.login();
  assert.equal((await b.request({method:'POST',url:'/api/directories/pick',headers:{origin:'https://attacker.invalid'},payload:{}})).statusCode,403);
  assert.equal((await b.request({method:'POST',url:'/api/directories/pick',payload:{path:'/unexpected'}})).statusCode,400);
  assert.equal((await b.request({method:'GET',url:'/api/projects'})).statusCode,200);
});


test('exact submission reads recover paged-out receipts and reject cross-worker ownership without execution',async t=>{
 const harnesses:ControlledHarness[]=[];
 const b=await browser(t,(settings,home,_workspace,_budget,permission)=>{const harness=new ControlledHarness(`native-${basename(home)}`,permission,(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));harnesses.push(harness);return harness;},{cliPageSize:1});
 await b.login();const project=await b.project('Receipt recovery'),node=await b.node(project.id),otherNode=await b.node(project.id);
 const workers=`/api/projects/${project.id}/nodes/${node}/workers`,workerId=b.id(),otherWorker=b.id();
 for(const id of [workerId,otherWorker])assert.equal((await b.request({method:'POST',url:workers,payload:{id,title:'Recovery worker'}})).statusCode,200);
 const ids=[b.id(),b.id()];
 for(const id of ids){
  assert.equal((await b.request({method:'POST',url:`${workers}/${workerId}/submissions`,payload:{id,text:activationText}})).statusCode,200);
  await awaitSubmission(b.runtime.agents,project.id,node,workerId,id);
 }
 const view=(await b.request({method:'GET',url:workers})).json<WorkerView[]>().find(value=>value.id===workerId)!;
 assert.deepEqual(view.submissions.map(value=>value.id),[ids[1]],'Recent worker projection excludes the old receipt');
 const calls=harnesses.flatMap(h=>h.calls).length,launches=harnesses.length;
 const recovered=await b.request({method:'GET',url:`${workers}/${workerId}/submissions/${ids[0]}`});
 assert.equal(recovered.statusCode,200);assert.equal(recovered.json().state,'applied');assert.equal(recovered.json().id,ids[0]);
 for(const url of [`${workers}/${otherWorker}/submissions/${ids[0]}`,`/api/projects/${project.id}/nodes/${otherNode}/workers/${workerId}/submissions/${ids[0]}`,`${workers}/${workerId}/submissions/${b.id()}`])assert.equal((await b.request({method:'GET',url})).statusCode,404);
 assert.equal(harnesses.length,launches);assert.equal(harnesses.flatMap(h=>h.calls).length,calls,'Receipt recovery neither executes nor replays input');
});
