import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, readdir, rm, stat, chmod, symlink, cp } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { owner } from '../src/caller.ts';
import { ResearchTree } from '../src/research.ts';
import { loadConfig } from '../src/config.ts';
import type { Mutation } from '../src/contracts.ts';

const execute = promisify(execFile);
const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

/** Each test owns a real isolated store; identities encode fixture order, never wall-clock time. */
async function fixture(t: TestContext, clock: () => number = Date.now) {
  const root = await temporaryDirectory('test-research-');
  const config = { ...await loadConfig(), stateRoot: root };
  let tree = new ResearchTree(config, clock);
  await tree.initialize();
  t.after(async () => { tree.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  return {
    root, config, id, get tree() { return tree; },
    async reopen() { tree.close(); tree = new ResearchTree(config, clock); await tree.initialize(); },
    async copyTo(destination: string) {
      tree.close();
      try { await cp(root, destination, { recursive: true }); }
      finally { tree = new ResearchTree(config, clock); await tree.initialize(); }
    },
    async node(project: string, title = 'Research action', source?: { nodeId: string; checkpointId: string }) {
      const node = id();
      await tree.mutate(project, { operationId: id(), revision: tree.graph(project).revision,
        command: { kind: 'node.create', id: node, title, description: '', ...(source ? { source } : {}) } });
      return node;
    },
    async change(project: string, command: Mutation['command']) {
      const mutation = { operationId: id(), revision: tree.graph(project).revision, command };
      await tree.mutate(project, mutation);
      return mutation;
    },
  };
}

test('graph replay preserves identities, free relations, cycles, multiple parents and append-only edits', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Graph research');
  const a = await f.node(project.id, 'A');
  const b = await f.node(project.id, 'B');
  const c = await f.node(project.id, 'C');
  const edge = f.id();
  const relation = 'questions the premise → 再検討 / 2';
  const initial = await f.change(project.id, { kind: 'edge.create', id: edge, from: a, to: b, relation, explanation: 'Researcher-defined meaning.' });
  const log = join(f.root, 'projects', project.id, '.polariton', 'graph.jsonl');
  const prefix = await readFile(log);
  assert.equal((await f.tree.mutate(project.id, initial)).revision, initial.revision + 1);
  assert.deepEqual(await readFile(log), prefix, 'retry must append nothing');
  await assert.rejects(f.tree.mutate(project.id, { ...initial, command: { kind: 'edge.create', id: edge, from: a, to: b, relation, explanation: 'changed retry' } }), fault('OPERATION_CONFLICT'));
  await f.change(project.id, { kind: 'edge.create', id: f.id(), from: c, to: b, relation: 'another parent', explanation: '' });
  await f.change(project.id, { kind: 'edge.create', id: f.id(), from: b, to: a, relation: 'descriptive cycle', explanation: '' });
  await f.change(project.id, { kind: 'node.edit', id: a, title: 'A revised', description: 'Updated purpose.' });
  await f.change(project.id, { kind: 'edge.edit', id: edge, relation, explanation: 'Updated explanation.' });
  assert.deepEqual((await readFile(log)).subarray(0, prefix.length), prefix);
  const expected = f.tree.graph(project.id);
  await f.reopen();
  assert.deepEqual(f.tree.graph(project.id), expected);
  assert.equal(f.tree.graph(project.id).edges.filter(value => value.to === b).length, 2);
  assert.equal(f.tree.graph(project.id).edges.find(value => value.id === edge)?.relation, relation);
  assert.deepEqual(await f.tree.mutate(project.id, initial), expected, 'an old retry returns current graph without reapplying');
  await assert.rejects(f.change(project.id, { kind: 'edge.create', id: f.id(), from: a, to: f.id(), relation: 'missing target', explanation: '' }), fault('INVALID_EDGE'));
});

test('concurrent revisions admit one change and leave a replayable log', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Concurrent commands');
  const a = await f.node(project.id);
  const revision = f.tree.graph(project.id).revision;
  const results = await Promise.allSettled(['first', 'second'].map(title => f.tree.mutate(project.id, {
    operationId: f.id(), revision, command: { kind: 'node.edit', id: a, title, description: '' },
  })));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = results.find(value => value.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && fault('REVISION_CONFLICT')(rejected.reason));
  const expected = f.tree.graph(project.id);
  assert.match(rejected.reason.message, new RegExp(`expected ${revision}, current ${expected.revision}`));
  await f.reopen();
  assert.deepEqual(f.tree.graph(project.id), expected);
});

test('archival and retraction retain workspaces and permit cooperative checkpoints', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Archival');
  const a = await f.node(project.id), b = await f.node(project.id);
  await writeFile(join(f.tree.workspace(project.id, a), 'evidence.txt'), 'retained evidence');
  const checkpoint = await f.tree.checkpoint(project.id, a, f.id(), {publisher:owner});
  const edge = f.id();
  await f.change(project.id, { kind: 'edge.create', id: edge, from: a, to: b, relation: 'related', explanation: '' });
  await f.change(project.id, { kind: 'node.archive', id: a, archived: true });
  await f.change(project.id, { kind: 'edge.retract', id: edge });
  assert.equal(f.tree.graph(project.id).nodes.find(value => value.id === a)?.archived, true);
  assert.equal(f.tree.graph(project.id).edges.find(value => value.id === edge)?.retracted, true);
  assert.equal((await f.tree.file(project.id, a, 'evidence.txt')).toString(), 'retained evidence');
  assert.deepEqual(f.tree.checkpoints(project.id, a), [checkpoint]);
  await f.tree.checkpoint(project.id, a, f.id(), {publisher:owner});
  const expected = f.tree.graph(project.id);
  await f.reopen();
  assert.deepEqual(f.tree.graph(project.id), expected);
  assert.equal((await f.tree.file(project.id, a, 'evidence.txt')).toString(), 'retained evidence');
});

test('torn suffix requires explicit repair, keeps a durable backup, and permits replay afterward', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Torn suffix');
  const a = await f.node(project.id);
  const expected = f.tree.graph(project.id);
  const directory = join(f.root, 'projects', project.id, '.polariton');
  const log = join(directory, 'graph.jsonl');
  const original = await readFile(log);
  const fragment = '{"version":1,"unfinished":';
  await appendFile(log, fragment);
  await f.reopen();
  assert.match(f.tree.graph(project.id).recovery!, /Incomplete/);
  assert.deepEqual(f.tree.graph(project.id).nodes, expected.nodes);
  await assert.rejects(f.change(project.id, { kind: 'node.edit', id: a, title: 'blocked', description: '' }), fault('RECOVERY_REQUIRED'));
  assert.deepEqual(await f.tree.repair(project.id), expected);
  assert.deepEqual(await readFile(log), original);
  const backups = (await readdir(directory)).filter(name => name.startsWith('graph.jsonl.damaged-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(join(directory, backups[0]!)), Buffer.concat([original, Buffer.from(fragment)]));
  await f.change(project.id, { kind: 'node.edit', id: a, title: 'after repair', description: '' });
  const repaired = f.tree.graph(project.id);
  await f.reopen();
  assert.deepEqual(f.tree.graph(project.id), repaired);
});

test('interior corruption cannot be silently repaired or overwritten', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Corruption');
  await f.node(project.id);
  const log = join(f.root, 'projects', project.id, '.polariton', 'graph.jsonl');
  const original = await readFile(log);
  await writeFile(log, Buffer.concat([Buffer.from('{broken}\n'), original]));
  const damaged = await readFile(log);
  await f.reopen();
  assert.match(f.tree.graph(project.id).recovery!, /corruption/i);
  await assert.rejects(f.tree.repair(project.id), fault('GRAPH_CORRUPT'));
  await assert.rejects(f.node(project.id), fault('RECOVERY_REQUIRED'));
  assert.deepEqual(await readFile(log), damaged);
});

test('empty and inherited nodes use independent Git repositories and exactly the selected checkpoint', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Inheritance');
  const a = await f.node(project.id, 'Source');
  const source = f.tree.workspace(project.id, a);
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'result.txt'), 'checkpoint value');
  await writeFile(join(source, 'binary.dat'), Buffer.from([0, 1, 128, 255]));
  const checkpoint = await f.tree.checkpoint(project.id, a, f.id(), {publisher:owner});
  assert.deepEqual(await f.tree.checkpoint(project.id, a, checkpoint.id, {publisher:owner}), checkpoint);
  await writeFile(join(source, 'nested', 'result.txt'), 'later uncommitted value');
  await writeFile(join(source, 'later.txt'), 'not in selected checkpoint');
  const b = await f.node(project.id, 'Inherited', { nodeId: a, checkpointId: checkpoint.id });
  const c = await f.node(project.id, 'Empty');
  assert.deepEqual(await f.tree.files(project.id, b), ['binary.dat', join('nested', 'result.txt')]);
  assert.deepEqual(await f.tree.files(project.id, c), []);
  assert.equal((await f.tree.file(project.id, b, 'nested/result.txt')).toString(), 'checkpoint value');
  assert.deepEqual(await f.tree.file(project.id, b, 'binary.dat'), Buffer.from([0, 1, 128, 255]));
  assert.deepEqual(f.tree.graph(project.id).nodes.find(value => value.id === b)?.source, { nodeId: a, checkpointId: checkpoint.id });
  const target = f.tree.workspace(project.id, b);
  assert.equal((await execute('git', ['-C', target, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  await assert.rejects(execute('git', ['-C', target, 'rev-parse', '--verify', `refs/polariton/checkpoints/${checkpoint.id}`]));
  await writeFile(join(target, 'nested', 'result.txt'), 'child edit');
  assert.equal((await f.tree.file(project.id, a, 'nested/result.txt')).toString(), 'later uncommitted value');
  await f.reopen();
  assert.deepEqual(f.tree.checkpoints(project.id, a), [checkpoint]);
});

test('checkpoint inheritance retains executable file mode', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Executable inheritance');
  const a = await f.node(project.id);
  const script = join(f.tree.workspace(project.id, a), 'run.sh');
  await writeFile(script, '#!/bin/sh\nprintf research\n');
  await chmod(script, 0o755);
  const checkpoint = await f.tree.checkpoint(project.id, a, f.id(), {publisher:owner});
  const b = await f.node(project.id, 'Continuation', { nodeId: a, checkpointId: checkpoint.id });
  assert.notEqual((await stat(join(f.tree.workspace(project.id, b), 'run.sh'))).mode & 0o111, 0,
    'a copied checkpoint must preserve the executable bit');
});

test('capture retains raw unfinished workspace contents without changing HEAD or the ordinary index', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Unfinished files');
  const node = await f.node(project.id), work = f.tree.workspace(project.id, node);
  const git = (...args: string[]) => execute('git', ['-C', work, ...args]);
  await writeFile(join(work, 'draft.txt'), 'committed version\n');
  await writeFile(join(work, 'removed.txt'), 'deleted before capture\n');
  await git('add', '--all');
  await git('-c', 'user.name=Researcher', '-c', 'user.email=researcher@localhost', 'commit', '--quiet', '-m', 'Research baseline');
  await writeFile(join(work, 'draft.txt'), 'staged version\n');
  await git('add', 'draft.txt');
  const raw = Buffer.from('unfinished working version\r\nsecond line\r\n');
  await writeFile(join(work, 'draft.txt'), raw);
  await rm(join(work, 'removed.txt'));
  await writeFile(join(work, '.gitignore'), '*.dat\n');
  await writeFile(join(work, '.gitattributes'), '*.txt text eol=lf\n');
  await writeFile(join(work, 'ignored.dat'), Buffer.from([0, 13, 10, 255]));
  await writeFile(join(work, 'untracked.txt'), 'new incomplete work\r\n');
  await writeFile(join(work, 'run.sh'), '#!/bin/sh\nexit 1\n');
  await chmod(join(work, 'run.sh'), 0o755);
  const head = (await git('rev-parse', 'HEAD')).stdout, index = await readFile(join(work, '.git', 'index'));
  const checkpoint = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner,note:'Work in progress'});
  assert.equal((await git('rev-parse', 'HEAD')).stdout, head);
  assert.deepEqual(await readFile(join(work, '.git', 'index')), index);
  assert.equal((await git('show', ':draft.txt')).stdout, 'staged version\n');
  assert.deepEqual(checkpoint.files, ['.gitattributes', '.gitignore', 'draft.txt', 'ignored.dat', 'run.sh', 'untracked.txt']);
  const captured = await execute('git', ['-C', work, 'show', `${checkpoint.commit}:draft.txt`], {encoding:'buffer'});
  assert.deepEqual(captured.stdout, raw, 'Git line-ending conversion must not alter captured bytes');
  assert.deepEqual((await execute('git', ['-C', work, 'show', `${checkpoint.commit}:ignored.dat`], {encoding:'buffer'})).stdout, Buffer.from([0, 13, 10, 255]));
  assert.equal((await git('show', `${checkpoint.commit}:untracked.txt`)).stdout, 'new incomplete work\r\n');
  assert.match((await git('ls-tree', checkpoint.commit, '--', 'run.sh')).stdout, /^100755 /);
  assert.equal((await git('ls-tree', checkpoint.commit, '--', 'removed.txt')).stdout, '');
  assert.deepEqual(await readFile(join(work, 'draft.txt')), raw);
});

test('configured Git clean filters cannot transform a checkpoint', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Raw filter capture');
  const node = await f.node(project.id), work = f.tree.workspace(project.id, node);
  const git = (...args: string[]) => execute('git', ['-C', work, ...args]);
  await writeFile(join(work, '.gitattributes'), '*.txt filter=uppercase\n');
  await git('config', 'filter.uppercase.clean', 'tr a-z A-Z');
  await writeFile(join(work, 'result.txt'), 'raw scientific observation\n');
  const filtered = (await git('hash-object', '--path=result.txt', 'result.txt')).stdout;
  const unfiltered = (await git('hash-object', '--no-filters', 'result.txt')).stdout;
  assert.notEqual(filtered, unfiltered, 'The fixture must exercise an effective clean filter');
  const checkpoint = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner});
  assert.equal((await git('show', `${checkpoint.commit}:result.txt`)).stdout, 'raw scientific observation\n');
  assert.equal((await git('rev-parse', `${checkpoint.commit}:result.txt`)).stdout, unfiltered);
});

test('checkpoint contention excludes only publishers of the same node', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Cooperative publication');
  const first = await f.node(project.id), second = await f.node(project.id);
  await writeFile(join(f.tree.workspace(project.id, first), 'first.txt'), 'first unfinished group');
  await writeFile(join(f.tree.workspace(project.id, second), 'second.txt'), 'second unfinished group');
  const firstCapture = f.tree.checkpoint(project.id, first, f.id(), {publisher:owner});
  const secondCapture = f.tree.checkpoint(project.id, second, f.id(), {publisher:owner});
  assert.equal(f.tree.workspace(project.id, first, 'write'), f.tree.workspace(project.id, first), 'Workers can enter the workspace during capture');
  await assert.rejects(f.tree.checkpoint(project.id, first, f.id(), {publisher:owner}), fault('CHECKPOINT_BUSY'));
  const [firstSaved, secondSaved] = await Promise.all([firstCapture, secondCapture]);
  assert.deepEqual(firstSaved.files, ['first.txt']);
  assert.deepEqual(secondSaved.files, ['second.txt']);
  const next = await f.tree.checkpoint(project.id, first, f.id(), {publisher:owner});
  assert.notEqual(next.id, firstSaved.id, 'Later publications have independent identities');
});

test('a crashed capture private index lock cannot obstruct a fresh attempt for the same request', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Interrupted capture');
  const node = await f.node(project.id), work = f.tree.workspace(project.id, node), request = f.id();
  await writeFile(join(work, 'data.txt'), 'surviving unfinished work');
  // Reproduce abandoned Git scratch storage after process loss, before any
  // candidate became durable. A retry must own fresh scratch, not steal its lock.
  const abandoned = await mkdtemp(join(project.root, '.polariton', `index-${request}-`));
  const index = join(abandoned, 'index'), lock = index + '.lock';
  await execute('git', ['-C', work, 'read-tree', '--empty'], {env:{...process.env,GIT_INDEX_FILE:index}});
  const original = await readFile(index);
  await writeFile(lock, 'interrupted Git index writer');
  const checkpoint = await f.tree.checkpoint(project.id, node, request, {publisher:owner});
  assert.deepEqual(checkpoint.files, ['data.txt']);
  assert.deepEqual(await readFile(index), original);
  assert.equal(await readFile(lock, 'utf8'), 'interrupted Git index writer');
  assert.deepEqual((await readdir(join(project.root, '.polariton'))).filter(name => name.startsWith(`index-${request}-`)), [basename(abandoned)]);
  await f.reopen();
  assert.deepEqual((await readdir(join(project.root, '.polariton'))).filter(name => name.startsWith(`index-${request}-`)), []);
  assert.deepEqual(f.tree.checkpoints(project.id, node), [checkpoint], 'Ownership recovery removes only disposable capture scratch');
});

test('closing the owner cancels an unselected capture without publishing or blocking restart', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Capture cancellation');
  const node = await f.node(project.id);
  const pending = f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  const rejected = assert.rejects(pending,fault('CAPTURE_CANCELLED'));
  await f.reopen();
  await rejected;
  assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  assert.deepEqual((await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner})).files,[]);
});

test('ambient Git routing cannot redirect node creation, checkpoint publication or inherited reads', async t => {
  const f = await fixture(t), foreign = join(f.root, 'foreign-repository');
  await mkdir(foreign);
  await execute('git', ['-C', foreign, 'init', '--quiet']);
  await execute('git', ['-C', foreign, '-c', 'user.name=Foreign', '-c', 'user.email=foreign@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Unrelated history']);
  const foreignHead = (await execute('git', ['-C', foreign, 'rev-parse', 'HEAD'])).stdout;
  const routing = {GIT_DIR:join(foreign,'.git'),GIT_WORK_TREE:foreign,GIT_OBJECT_DIRECTORY:join(foreign,'.git','objects')};
  const previous = Object.fromEntries(Object.keys(routing).map(key => [key, process.env[key]]));
  Object.assign(process.env, routing);
  try {
    const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Independent routing');
    const source = await f.node(project.id);
    await writeFile(join(f.tree.workspace(project.id, source), 'evidence.txt'), 'only this node owns this evidence');
    const checkpoint = await f.tree.checkpoint(project.id, source, f.id(), {publisher:owner});
    const child = await f.node(project.id, 'Inherited through isolated Git', {nodeId:source,checkpointId:checkpoint.id});
    assert.equal((await f.tree.file(project.id, child, 'evidence.txt')).toString(), 'only this node owns this evidence');
    assert.equal((await stat(join(f.tree.workspace(project.id, child), '.git'))).isDirectory(), true);
  } finally {
    for (const key of Object.keys(routing)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
  assert.equal((await execute('git', ['-C', foreign, 'rev-parse', 'HEAD'])).stdout, foreignHead);
  assert.equal((await execute('git', ['-C', foreign, 'for-each-ref', '--format=%(refname)', 'refs/polariton'])).stdout, '');
  assert.equal((await execute('git', ['-C', foreign, 'status', '--porcelain'])).stdout, '');
});

test('an incompatible version-2 research registry is rejected without changing retained bytes', async t => {
  const root = await temporaryDirectory('test-research-v2-');
  t.after(() => rm(root, {recursive:true,force:true}));
  const database = join(root, 'research.sqlite'), previous = new DatabaseSync(database);
  previous.exec("CREATE TABLE retained_evidence(value TEXT); INSERT INTO retained_evidence VALUES ('Do not migrate or erase'); PRAGMA user_version=2;");
  previous.close();
  const original = await readFile(database), tree = new ResearchTree({...await loadConfig(),stateRoot:root});
  try { await assert.rejects(tree.initialize(), fault('STORAGE_VERSION')); }
  finally { tree.close(); }
  assert.deepEqual(await readFile(database), original);
});

test('project and file boundaries reject identity substitution, Git internals and symlink escape', async t => {
  const f = await fixture(t);
  const first = await f.tree.createProject(globalThis.crypto.randomUUID(), 'First'), second = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Second');
  const a = await f.node(first.id), b = await f.node(second.id);
  const firstRoot = f.tree.workspace(first.id, a), secondRoot = f.tree.workspace(second.id, b);
  await writeFile(join(firstRoot, 'safe.txt'), 'first');
  await writeFile(join(secondRoot, 'private.txt'), 'second');
  assert.throws(() => f.tree.workspace(first.id, b), fault('NODE_NOT_FOUND'));
  assert.throws(() => f.tree.workspace(first.id, b, 'write'), fault('NODE_NOT_FOUND'));
  await assert.rejects(f.tree.file(first.id, b, 'private.txt'), fault('NODE_NOT_FOUND'));
  await assert.rejects(f.tree.file(first.id, a, '../outside'), fault('FILE_DENIED'));
  await assert.rejects(f.tree.file(first.id, a, '.git/config'), fault('FILE_DENIED'));
  await assert.rejects(f.tree.file(first.id, a, join(secondRoot, 'private.txt')), fault('FILE_DENIED'));
  await symlink(join(secondRoot, 'private.txt'), join(firstRoot, 'escape.txt'));
  await assert.rejects(f.tree.file(first.id, a, 'escape.txt'), fault('FILE_DENIED'));
  await assert.rejects(f.tree.checkpoint(first.id, a, f.id(), {publisher:owner}), fault('UNSUPPORTED_FILE'));
  await assert.rejects(f.tree.checkpoint(first.id, a, '../../outside', {publisher:owner}));
});

test('one state directory has one owner and ownership is released on close', async t => {
  const f = await fixture(t);
  const other = new ResearchTree(f.config);
  try { await assert.rejects(other.initialize(), fault('STATE_OWNED')); }
  finally { other.close(); }
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Single owner');
  await f.node(project.id);
  const expected = f.tree.graph(project.id);
  await f.reopen();
  assert.deepEqual(f.tree.graph(project.id), expected);
});

test('an interrupted repository initialization completes before the node is published', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Interrupted provisioning');
  const existing = await f.node(project.id);
  const next = f.id();
  // Reproduce the OS-visible state left after Git initialization but before its initial commit.
  const work = join(dirname(f.tree.workspace(project.id, existing)), next);
  await mkdir(work);
  await execute('git', ['-C', work, 'init', '--quiet']);
  await writeFile(join(work, 'retained.txt'), 'user work survives recovery');
  await f.change(project.id, { kind: 'node.create', id: next, title: 'Recovered', description: '' });
  assert.equal((await execute('git', ['-C', f.tree.workspace(project.id, next), 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  assert.equal((await f.tree.file(project.id, next, 'retained.txt')).toString(), 'user work survives recovery');
  await f.reopen();
  assert.equal((await f.tree.file(project.id, next, 'retained.txt')).toString(), 'user work survives recovery');
});

test('inherited ignored files are retained in the independent initial Git checkpoint', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Ignored data inheritance');
  const a = await f.node(project.id);
  const source = f.tree.workspace(project.id, a);
  await writeFile(join(source, '.gitignore'), '*.dat\n');
  await writeFile(join(source, 'measured.dat'), 'selected scientific data');
  const checkpoint = await f.tree.checkpoint(project.id, a, f.id(), {publisher:owner});
  const b = await f.node(project.id, 'Inherited', { nodeId: a, checkpointId: checkpoint.id });
  const restored = await execute('git', ['-C', f.tree.workspace(project.id, b), 'show', 'HEAD:measured.dat']);
  assert.equal(restored.stdout, 'selected scientific data');
});

test('checkpoint publication recovers the exact candidate and publisher metadata after a Git ref-lock failure', async t => {
  let clock = 100;
  const f = await fixture(t, () => clock++);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Checkpoint retry');
  const a = await f.node(project.id);
  const work = f.tree.workspace(project.id, a);
  await writeFile(join(work, 'data.txt'), 'checkpoint candidate');
  const checkpointId = f.id();
  const lockName = (await execute('git', ['-C', work, 'rev-parse', '--git-path', `refs/polariton/checkpoints/${checkpointId}.lock`])).stdout.trim();
  const lock = join(work, lockName);
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, 'a concurrent Git operation owns this ref');
  const publisher = {kind:'worker' as const,id:f.id(),processId:f.id()};
  const publication = {publisher,note:'Unfinished analysis; tests not yet run'};
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, publication));
  assert.deepEqual(f.tree.checkpoints(project.id, a), []);
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, {...publication,note:'Changed note'}), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, {...publication,publisher:owner}), fault('OPERATION_CONFLICT'));
  await rm(lock);
  await writeFile(join(work, 'data.txt'), 'later working-file edit');
  await f.reopen();
  const saved = await f.tree.checkpoint(project.id, a, checkpointId, publication);
  assert.equal(saved.id, checkpointId);
  assert.deepEqual(saved.publisher, publisher);
  assert.equal(saved.note, publication.note);
  assert.equal(saved.createdAt, 102);
  assert.deepEqual(saved.capture, {startedAt:100,finishedAt:101,policy:'regular-files-v1',consistency:'cooperative-verified',attempts:1});
  assert.equal(clock, 103, 'Recovery must not recapture files or replace the original interval');
  assert.equal((await execute('git', ['-C', work, 'show', `${saved.commit}:data.txt`])).stdout, 'checkpoint candidate');
  await f.reopen();
  assert.deepEqual(f.tree.checkpoints(project.id, a), [saved]);
});

test('relocated project copies retain graph and file history but deny changes and execution access', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Portable historical project');
  const node = await f.node(project.id);
  await writeFile(join(f.tree.workspace(project.id, node), 'evidence.txt'), 'retained research');
  const checkpoint = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner});
  const graph = f.tree.graph(project.id);
  const relocated = await temporaryDirectory('test-relocated-');
  await f.copyTo(relocated);
  let copy = new ResearchTree({ ...f.config, stateRoot: relocated });
  try {
    await copy.initialize();
    assert.deepEqual(copy.graph(project.id), graph);
    assert.deepEqual(copy.checkpoints(project.id, node), [checkpoint]);
    assert.equal((await copy.file(project.id, node, 'evidence.txt')).toString(), 'retained research');
    assert.throws(() => copy.workspace(project.id, node, 'write'), fault('WORKSPACE_RELOCATED'));
    await assert.rejects(copy.mutate(project.id, { operationId: f.id(), revision: graph.revision,
      command: { kind: 'node.edit', id: node, title: 'Denied edit', description: '' } }), fault('WORKSPACE_RELOCATED'));
    await assert.rejects(copy.checkpoint(project.id, node, f.id(), {publisher:owner}), fault('WORKSPACE_RELOCATED'));
    assert.deepEqual(copy.graph(project.id), graph);
    assert.equal(f.tree.workspace(project.id, node, 'write'), f.tree.workspace(project.id, node));
    copy.close();
    const copiedLog = join(relocated, 'projects', project.id, '.polariton/graph.jsonl');
    await appendFile(copiedLog, '{torn historical suffix');
    const damaged = await readFile(copiedLog);
    copy = new ResearchTree({ ...f.config, stateRoot: relocated });
    await copy.initialize();
    assert.match(copy.graph(project.id).recovery!, /^Incomplete/);
    await assert.rejects(copy.repair(project.id), fault('WORKSPACE_RELOCATED'));
    assert.deepEqual(await readFile(copiedLog), damaged, 'historical-only inspection cannot repair source bytes');
  } finally { copy.close(); await rm(relocated, { recursive: true, force: true }); }
});
