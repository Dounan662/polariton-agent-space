import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {Operations, owner} from '../src/operations.ts';
import {Fault} from '../src/contracts.ts';

const id = (value: number) => `12300000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function fixture(t: TestContext, capacity = 4) {
  const db = new DatabaseSync(':memory:'); Operations.create(db);
  const now = {value: 1000};
  const open = () => new Operations(db, 'main:worker', capacity, () => now.value);
  t.after(() => db.close()); return {db, now, open, operations: open()};
}

test('journal shares concurrent identity, rejects changed callers and targets, and preserves the recorded result', async t => {
  const f = fixture(t); let effects = 0, finish!: (value: unknown) => void;
  const blocked = new Promise(resolve => { finish = resolve; });
  const input = {target: id(2), options: {a: 1, b: 2}};
  const first = f.operations.run(id(1), owner, 'worker.close', input, true, async () => { effects++; return blocked; });
  const duplicate = f.operations.run(id(1), owner, 'worker.close', {options: {b: 2, a: 1}, target: id(2)}, true, async () => { effects++; return null; });
  await assert.rejects(f.operations.run(id(1), owner, 'worker.close', {...input, target: id(3)}, true, async () => null), {code: 'REQUEST_CONFLICT'});
  await assert.rejects(f.operations.run(id(1), {kind: 'worker', id: id(2), processId: id(4)}, 'worker.close', input, true, async () => null), {code: 'REQUEST_CONFLICT'});
  assert.equal(effects, 1); assert.equal(f.operations.get(id(1)).state, 'running');
  f.now.value = 2000; finish({closed: id(2)});
  const result = await first; assert.deepEqual(await duplicate, result); assert.equal(result.attempts[0]!.at, 2000);
  assert.deepEqual(await f.open().run(id(1), owner, 'worker.close', input, true, async () => { effects++; return null; }), result);
  assert.equal(effects, 1);
});

test('loss of volatile coordination never repeats an unsafe dispatched effect', async t => {
  const f = fixture(t); let effects = 0;
  void f.operations.run(id(1), owner, 'worker.resume', {target: id(2)}, false, async () => { effects++; return new Promise(() => {}); });
  assert.equal(f.operations.get(id(1)).state, 'running');
  const recovered = await f.open().run(id(1), owner, 'worker.resume', {target: id(2)}, false, async () => { effects++; return null; });
  assert.equal(recovered.state, 'uncertain'); assert.equal(recovered.error!.code, 'EXECUTION_UNCERTAIN'); assert.equal(effects, 1);
  await f.open().run(id(1), owner, 'worker.resume', {target: id(2)}, true, async () => { effects++; return null; });
  assert.equal(effects, 1, 'A later caller cannot turn retained uncertainty into permission to replay');
});

test('owner-authorized recovery retains failed attempts and can recover a running request', async t => {
  const f = fixture(t); let effects = 0;
  const failed = await f.operations.run(id(1), owner, 'project.create', {root: '/owned'}, true, async () => { effects++; throw new Fault('CONTROLLED_FAILURE', 'Provisioning not finished'); });
  assert.equal(failed.state, 'failed'); f.now.value = 2000;
  const recovered = await f.open().run(id(1), owner, 'project.create', {root: '/owned'}, true, async () => { effects++; return {project: id(2)}; });
  assert.equal(recovered.state, 'succeeded'); assert.equal(effects, 2);
  assert.deepEqual(recovered.attempts.map(attempt => attempt.state), ['failed', 'succeeded']);
  assert.equal(recovered.attempts[0]!.code, 'CONTROLLED_FAILURE');
  void f.operations.run(id(3), owner, 'project.create', {root: '/another-owned'}, true, async () => new Promise(() => {}));
  const resumed = await f.open().run(id(3), owner, 'project.create', {root: '/another-owned'}, true, async () => ({project: id(4)}));
  assert.equal(resumed.state, 'succeeded'); assert.deepEqual(resumed.attempts.map(attempt => attempt.state), ['running', 'succeeded']);
});

test('synchronous domain changes roll back together and capacity rejects before any effect', t => {
  const f = fixture(t, 1);
    f.db.exec('CREATE TABLE domain_records(value TEXT NOT NULL)');
    assert.throws(() => f.operations.sync(id(1), owner, 'worker.update', {title: 'Updated'}, () => { f.db.prepare('INSERT INTO domain_records VALUES (?)').run('transient'); throw new Fault('CONTROLLED_FAILURE', 'No commit'); }), {code: 'CONTROLLED_FAILURE'});
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM domain_records').get()!.count, 0);
    assert.throws(() => f.operations.get(id(1)), {code: 'OPERATION_NOT_FOUND'});
    f.operations.sync(id(1), owner, 'worker.update', {title: 'Updated'}, () => ({title: 'Updated', absent: undefined}));
    let effects = 0;
    assert.throws(() => f.operations.sync(id(2), owner, 'worker.update', {title: 'Other'}, () => { effects++; return {}; }), {code: 'REQUEST_CAPACITY'});
    assert.equal(effects, 0); assert.deepEqual(f.operations.get(id(1)).result, {title: 'Updated'});
});
