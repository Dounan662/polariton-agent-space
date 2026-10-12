import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { readHistory } from '../harness/history.mjs';
import { persistHistory } from './fixtures/history.mjs';

/** Compare complete storage bytes and membership, including any unexpected lease/repair files. */
async function storageBytes(root) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else result[name] = (await readFile(join(directory, entry.name))).toString('base64');
    }
  }
  await visit(root);
  return result;
}

test('cold logical history retains compaction and an unresolved turn without activation or repair', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polariton-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await persistHistory(root);
  const before = await storageBytes(root);
  const forbid = () => { throw new Error('Cold history attempted process or provider activation'); };
  t.mock.method(globalThis, 'fetch', forbid);
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    t.mock.method(childProcess, name, forbid);
  }
  syncBuiltinESMExports();
  try {
    const full = await readHistory(root, fixture.id, { limit: fixture.events.length + 1 });
    assert.equal(full.kind, 'persisted');
    assert.equal(full.header.id, fixture.id);
    assert.deepEqual(full.events, fixture.events);
    assert.equal(full.events.find(event => event.seq === fixture.original.seq).data.content[0].text, 'Original research evidence.');
    assert.deepEqual(full.events.filter(event => event.type.startsWith('compaction/')).map(event => event.type),
      ['compaction/start', 'compaction/summary', 'compaction/end']);
    assert.equal(full.events.at(-1).type, 'step/start');
    assert.equal(full.events.some(event => event.type === 'turn/end' && event.data.turn === 2), false);
    assert.ok(interruptedTurnClosers(full.events).length > 0, 'the fixture really requires derived interruption closure');
    const again = await readHistory(root, fixture.id, { limit: fixture.events.length + 1 });
    assert.deepEqual(again.events, full.events);
    assert.deepEqual(await storageBytes(root), before);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('bounded cold pages cover the exact source once and repeated boundaries are stable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polariton-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await persistHistory(root);
  const pages = [];
  const pageSize = 3;
  for (let offset = 0; offset < fixture.events.length; offset += pageSize) {
    const page = await readHistory(root, fixture.id, { offset, limit: pageSize });
    assert.ok(page.events.length <= pageSize);
    assert.equal(page.offset, offset);
    const replay = await readHistory(root, fixture.id, { offset, limit: pageSize });
    assert.deepEqual(replay.events, page.events);
    pages.push(...page.events);
  }
  assert.deepEqual(pages, fixture.events);
  assert.equal(new Set(pages.map(event => event.seq)).size, fixture.events.length);
  assert.deepEqual((await readHistory(root, fixture.id, { offset: fixture.events.length, limit: pageSize })).events, []);
  assert.deepEqual((await readHistory(root, fixture.id, { offset: fixture.events.length + pageSize, limit: pageSize })).events, []);
});

test('history inspection coexists with the DSH writer lease without acquiring it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polariton-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await persistHistory(root);
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root });
    const writer = await ctx.sessionPersistence.open(fixture.id, 'write');
    try {
      const before = await storageBytes(root);
      assert.deepEqual((await readHistory(root, fixture.id)).events, fixture.events);
      assert.deepEqual(await storageBytes(root), before);
      await writer.flush();
    } finally { await writer.close(); }
  } finally { await ctx.fiber.dispose(); }
});

test('invalid bounds and missing sources fail explicitly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'polariton-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const page of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: Infinity }]) {
    await assert.rejects(readHistory(root, 'missing', page), /Invalid history page/);
  }
  await assert.rejects(readHistory(root, 'missing'), error => error.name === 'SessionPersistenceNotFoundError');
});
