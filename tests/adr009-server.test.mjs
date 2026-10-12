import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function launch(t) {
  const home = await mkdtemp(join(tmpdir(), 'polariton-adr009-server-'));
  const auth = join(home, 'authority.json'), control = randomUUID();
  const tokens = { one: randomUUID(), two: randomUUID(), observer: randomUUID() };
  const authority = { generation: 'test-generation', bindings: Object.entries(tokens).map(([id, token]) => ({ id, principal: `test-${id}`, hash: createHash('sha256').update(token).digest('hex'), access: id === 'observer' ? 'observe' : 'call' })) };
  await writeFile(auth, JSON.stringify(authority));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/adr009/server.mjs', import.meta.url))], {
    env: { PORT: '0', POLARITON_AUTH_FILE: auth, POLARITON_FIXTURE_CONTROL_TOKEN: control, POLARITON_FIXTURE_VERSION: '2' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(home, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${stderr}`)), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Fixture exited before ready: ${stderr}`)); });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(stdout.split('\n')[0])); } });
  });
  const base = `http://127.0.0.1:${ready.port}`;
  const connect = async id => {
    const client = new Client({ name: `verifier-${id}`, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[id]}` } } });
    await client.connect(transport); t.after(() => client.close()); return { client, transport };
  };
  const request = (path, body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${control}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { base, connect, request, tokens, auth, authority, stderr: () => stderr };
}

test('real HTTP MCP clients enforce direct binding authority, observation-only access, and revocation', { timeout: 20000 }, async t => {
  const fixture = await launch(t);
  const first = await fixture.connect('one'), observer = await fixture.connect('observer');
  const value = await first.client.callTool({ name: 'statistics', arguments: { values: [2, 4, 4, 4, 5, 5, 7, 9] } });
  assert.equal(value.structuredContent.standardDeviation, 2);
  assert.equal(JSON.parse((await observer.client.readResource({ uri: 'stats://capability' })).contents[0].text).version, 2);
  await assert.rejects(observer.client.callTool({ name: 'echo', arguments: { identity: 'unauthorized' } }), /403|Observation grant/);
  const stolenSession = await fetch(`${fixture.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${fixture.tokens.two}`, 'mcp-session-id': first.transport.sessionId, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list' }) });
  assert.equal(stolenSession.status, 403);
  const noGrant = await fetch(`${fixture.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noGrant.status, 401);
  fixture.authority.bindings = fixture.authority.bindings.filter(binding => binding.id !== 'one');
  await writeFile(fixture.auth, JSON.stringify(fixture.authority));
  await assert.rejects(first.client.callTool({ name: 'echo', arguments: { identity: 'released' } }), /401|Invalid or released/);
  assert.equal((await observer.client.listTools()).tools.some(tool => tool.name === 'statistics'), true);
});

test('real HTTP sessions overlap without cross-routing and test-only faults remain separately authorized', { timeout: 20000 }, async t => {
  const fixture = await launch(t);
  const one = await fixture.connect('one'), two = await fixture.connect('two');
  const first = one.client.callTool({ name: 'echo', arguments: { identity: 'one', barrier: 'pair' } });
  const second = two.client.callTool({ name: 'echo', arguments: { identity: 'two', barrier: 'pair' } });
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) { observed = await (await fixture.request('/evidence')).json(); if (observed.waiting.length === 2) break; }
  assert.deepEqual(observed.waiting.sort(), ['pair:one', 'pair:two']);
  assert.equal((await fetch(`${fixture.base}/control`, { method: 'POST', body: JSON.stringify({ action: 'release', barrier: 'pair' }) })).status, 401);
  assert.deepEqual(await (await fixture.request('/control', { action: 'release', barrier: 'pair' })).json(), { released: 2 });
  assert.equal((await first).structuredContent.identity, 'one');
  assert.equal((await second).structuredContent.identity, 'two');
  assert.equal((await fixture.request('/control', { action: 'exhaust', mode: 'memory' })).status, 409, 'Host exhaustion must be impossible');
  await fixture.request('/control', { action: 'resource', mode: 'error' });
  await assert.rejects(one.client.readResource({ uri: 'stats://capability' }), /controlled_resource_failure/);
  assert.equal((await two.client.callTool({ name: 'echo', arguments: { identity: 'unrelated-call' } })).structuredContent.identity, 'unrelated-call');
  await fixture.request('/control', { action: 'resource', mode: 'normal', delayMs: 500 });
  await assert.rejects(one.client.readResource({ uri: 'stats://capability' }, { timeout: 20 }), /timed out|timeout/i);
  assert.equal((await two.client.callTool({ name: 'echo', arguments: { identity: 'after-timeout' } })).structuredContent.identity, 'after-timeout');
  const cancel = new AbortController();
  const pending = one.client.callTool({ name: 'echo', arguments: { identity: 'cancelled', barrier: 'cancel' } }, { signal: cancel.signal });
  pending.catch(() => {});
  for (let attempt = 0; attempt < 100; attempt++) { observed = await (await fixture.request('/evidence')).json(); if (observed.waiting.includes('cancel:cancelled')) break; }
  assert.ok(observed.waiting.includes('cancel:cancelled'));
  cancel.abort(new Error('Verifier cancellation'));
  await assert.rejects(pending, /Verifier cancellation|abort/i);
  for (let attempt = 0; attempt < 100; attempt++) { observed = await (await fixture.request('/evidence')).json(); if (!observed.waiting.includes('cancel:cancelled')) break; }
  assert.equal(observed.waiting.includes('cancel:cancelled'), false);
});
