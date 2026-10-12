import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createCapability, fixtureState } from './fixtures/adr009/capability.mjs';

async function connect(t, version, state = fixtureState()) {
  const server = createCapability(version, state);
  const client = new Client({ name: 'independent-fixture-verifier', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, state };
}

const withinTolerance = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12 + 1e-10 * Math.abs(expected), `${actual} differs from ${expected}`);

test('fixture R1 exposes independently checkable population statistics and its version resource', async t => {
  const { client } = await connect(t, 1);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'statistics'));
  assert.ok(!tools.tools.some(tool => tool.name === 'weighted_statistics'));
  for (const [values, mean, sd] of [[[2, 4, 4, 4, 5, 5, 7, 9], 5, 2], [[-3], -3, 0], [[7, 7, 7], 7, 0], [[-3, -1, 1, 3], 0, Math.sqrt(5)]]) {
    const result = await client.callTool({ name: 'statistics', arguments: { values } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.count, values.length);
    withinTolerance(result.structuredContent.mean, mean);
    withinTolerance(result.structuredContent.standardDeviation, sd);
  }
  const info = await client.readResource({ uri: 'stats://capability' });
  assert.deepEqual(JSON.parse(info.contents[0].text), { version: 1, operations: ['statistics'] });
  const empty = await client.callTool({ name: 'statistics', arguments: { values: [] } });
  assert.equal(empty.isError, true);
});

test('fixture R2 preserves R1 behavior, adds weighted statistics, and reports invalid weights as tool errors', async t => {
  const { client } = await connect(t, 2);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'weighted_statistics'));
  const result = await client.callTool({ name: 'weighted_statistics', arguments: { values: [1, 3], weights: [1, 3] } });
  withinTolerance(result.structuredContent.mean, 2.5);
  withinTolerance(result.structuredContent.standardDeviation, Math.sqrt(0.75));
  const zero = await client.callTool({ name: 'weighted_statistics', arguments: { values: [10, 500], weights: [1, 0] } });
  withinTolerance(zero.structuredContent.mean, 10); withinTolerance(zero.structuredContent.standardDeviation, 0);
  for (const weights of [[0, 0], [-1, 2], [1]]) {
    const bad = await client.callTool({ name: 'weighted_statistics', arguments: { values: [1, 3], weights } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /invalid_weights/);
  }
  assert.equal((await client.callTool({ name: 'deliberate_error', arguments: {} })).isError, true);
});

test('two independent MCP sessions overlap at an explicit barrier without cross-routing', async t => {
  const shared = fixtureState();
  const one = await connect(t, 1, shared), two = await connect(t, 1, shared);
  const first = one.client.callTool({ name: 'echo', arguments: { identity: 'one', barrier: 'pair' } });
  const second = two.client.callTool({ name: 'echo', arguments: { identity: 'two', barrier: 'pair' } });
  // In-memory transport schedules requests through microtasks, independent of wall-clock timing.
  for (let attempt = 0; attempt < 100 && shared.waiting.size !== 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...shared.waiting.keys()].sort(), ['pair:one', 'pair:two']);
  for (const release of [...shared.waiting.values()]) release();
  assert.equal((await first).structuredContent.identity, 'one');
  assert.equal((await second).structuredContent.identity, 'two');
  assert.equal(shared.waiting.size, 0);
});

test('resource faults are controlled independently of action-tool invocation', async t => {
  const { client, state } = await connect(t, 1);
  state.resource = { mode: 'malformed', delayMs: 0, bytes: 0 };
  const malformed = await client.readResource({ uri: 'stats://capability' });
  assert.throws(() => JSON.parse(malformed.contents[0].text));
  state.resource = { mode: 'oversized', delayMs: 0, bytes: 1048577 };
  assert.equal((await client.readResource({ uri: 'stats://capability' })).contents[0].text.length, 1048577);
  state.resource = { mode: 'error', delayMs: 0, bytes: 0 };
  await assert.rejects(client.readResource({ uri: 'stats://capability' }), /controlled_resource_failure/);
  assert.equal(state.calls.length, 0);
});
