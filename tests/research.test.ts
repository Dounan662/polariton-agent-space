import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, readFile, writeFile, appendFile, readdir, rm, stat, chmod, symlink, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { testDeadline } from './fixtures/timing.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { owner } from '../src/caller.ts';
import { ResearchTree } from '../src/research.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { Mutation } from '../src/contracts.ts';

const execute = promisify(execFile);
const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

/** Each test owns a real isolated store; identities encode fixture order, never wall-clock time. */
async function fixture(t: TestContext, clock: () => number = Date.now, overrides: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-research-');
  const config = { ...await loadConfig(), ...overrides, stateRoot: root };
  let tree = new ResearchTree(config, clock);
  await tree.initialize();
  t.after(async () => { await tree.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  return {
    root, config, id, get tree() { return tree; },
    async reopen() { await tree.close(); tree = new ResearchTree(config, clock); await tree.initialize(); },
    async copyTo(destination: string) {
      await tree.close();
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

test('archival and retraction retain workspaces and permit shared-history checkpoints', async t => {
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

test('checkpoint stages all shared changes onto ordinary history and follows Git inclusion and attributes', async t => {
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
  const head = (await git('rev-parse', 'HEAD')).stdout.trim();
  const checkpoint = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner,note:'Work in progress'});
  assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), checkpoint.commit);
  assert.equal((await git('rev-parse', 'HEAD^')).stdout.trim(), head);
  assert.equal((await git('show', ':draft.txt')).stdout, 'unfinished working version\nsecond line\n');
  assert.equal((await git('diff', '--cached', '--name-only')).stdout, '');
  const captured = await execute('git', ['-C', work, 'show', `${checkpoint.commit}:draft.txt`], {encoding:'buffer'});
  assert.deepEqual(captured.stdout, Buffer.from('unfinished working version\nsecond line\n'), 'Git attributes govern retained bytes');
  assert.equal((await git('ls-tree', checkpoint.commit, '--', 'ignored.dat')).stdout, '');
  assert.equal((await git('show', `${checkpoint.commit}:untracked.txt`)).stdout, 'new incomplete work\n');
  assert.match((await git('ls-tree', checkpoint.commit, '--', 'run.sh')).stdout, /^100755 /);
  assert.equal((await git('ls-tree', checkpoint.commit, '--', 'removed.txt')).stdout, '');
  assert.deepEqual(await readFile(join(work, 'draft.txt')), raw);
});

test('configured Git clean filters govern checkpoint contents', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Git filter capture');
  const node = await f.node(project.id), work = f.tree.workspace(project.id, node);
  const git = (...args: string[]) => execute('git', ['-C', work, ...args]);
  await writeFile(join(work, '.gitattributes'), '*.txt filter=uppercase\n');
  await git('config', 'filter.uppercase.clean', 'tr a-z A-Z');
  await writeFile(join(work, 'result.txt'), 'raw scientific observation\n');
  const filtered = (await git('hash-object', '--path=result.txt', 'result.txt')).stdout;
  const unfiltered = (await git('hash-object', '--no-filters', 'result.txt')).stdout;
  assert.notEqual(filtered, unfiltered, 'The fixture must exercise an effective clean filter');
  const checkpoint = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner});
  assert.equal((await git('show', `${checkpoint.commit}:result.txt`)).stdout, 'RAW SCIENTIFIC OBSERVATION\n');
  assert.equal((await git('rev-parse', `${checkpoint.commit}:result.txt`)).stdout, filtered);
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
  assert.equal((await execute('git', ['-C', f.tree.workspace(project.id, first), 'show', `${firstSaved.commit}:first.txt`])).stdout, 'first unfinished group');
  assert.equal((await execute('git', ['-C', f.tree.workspace(project.id, second), 'show', `${secondSaved.commit}:second.txt`])).stdout, 'second unfinished group');
  const next = await f.tree.checkpoint(project.id, first, f.id(), {publisher:owner});
  assert.notEqual(next.id, firstSaved.id, 'Later publications have independent identities');
});

test('closing the owner cancels an unselected publication without publishing or blocking restart', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Capture cancellation');
  const node = await f.node(project.id);
  const pending = f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  const rejected = assert.rejects(pending,fault('CHECKPOINT_CANCELLED'));
  await f.reopen();
  await rejected;
  assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  const saved = await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  assert.equal((await execute('git', ['-C', f.tree.workspace(project.id,node), 'rev-parse', 'HEAD'])).stdout.trim(), saved.commit);
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

test('an incompatible version-4 research registry is rejected without changing retained bytes', async t => {
  const root = await temporaryDirectory('test-research-v4-');
  t.after(() => rm(root, {recursive:true,force:true}));
  const database = join(root, 'research.sqlite'), previous = new DatabaseSync(database);
  previous.exec("CREATE TABLE retained_evidence(value TEXT); INSERT INTO retained_evidence VALUES ('Do not migrate or erase'); PRAGMA user_version=4;");
  previous.close();
  const original = await readFile(database), tree = new ResearchTree({...await loadConfig(),stateRoot:root});
  try { await assert.rejects(tree.initialize(), fault('STORAGE_VERSION')); }
  finally { await tree.close(); }
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
  const saved = await f.tree.checkpoint(first.id, a, f.id(), {publisher:owner});
  assert.equal((await execute('git', ['-C', firstRoot, 'show', `${saved.commit}:escape.txt`])).stdout, join(secondRoot, 'private.txt'), 'Git retains the symlink itself, never its target contents');
  await assert.rejects(f.tree.checkpoint(first.id, a, '../../outside', {publisher:owner}));
});

test('one state directory has one owner and ownership is released on close', async t => {
  const f = await fixture(t);
  const other = new ResearchTree(f.config);
  try { await assert.rejects(other.initialize(), fault('STATE_OWNED')); }
  finally { await other.close(); }
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

test('inherited tracked files matching ignore rules are retained in the independent initial Git checkpoint', async t => {
  const f = await fixture(t);
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Ignored data inheritance');
  const a = await f.node(project.id);
  const source = f.tree.workspace(project.id, a);
  await writeFile(join(source, '.gitignore'), '*.dat\n');
  await writeFile(join(source, 'measured.dat'), 'selected scientific data');
  await execute('git', ['-C', source, 'add', '-f', 'measured.dat']);
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
  const resumed = {...publication,publisher:{...publisher,processId:f.id()}};
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, publication));
  assert.deepEqual(f.tree.checkpoints(project.id, a), []);
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, {...publication,note:'Changed note'}), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, {...publication,publisher:owner}), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.checkpoint(project.id, a, checkpointId, {...publication,publisher:{...publisher,id:f.id()}}), fault('OPERATION_CONFLICT'));
  await f.reopen();
  assert.deepEqual(f.tree.checkpoints(project.id, a), [], 'the Git reference lock keeps publication pending across restart');
  await rm(lock);
  const candidate = (await execute('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(work, 'data.txt'), 'later working-file edit');
  await execute('git', ['-C', work, 'add', '-A']);
  await execute('git', ['-C', work, '-c', 'user.name=Researcher', '-c', 'user.email=researcher@localhost', 'commit', '--quiet', '-m', 'Later manual work']);
  const later = (await execute('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  const saved = await f.tree.checkpoint(project.id, a, checkpointId, resumed);
  assert.equal(saved.id, checkpointId);
  assert.equal(saved.commit, candidate);
  assert.equal((await execute('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim(), later, 'recovering a milestone does not rewrite newer ordinary history');
  assert.deepEqual(saved.publisher, publisher, 'a restarted worker keeps its original publication attribution');
  assert.equal(saved.note, publication.note);
  assert.equal(typeof saved.createdAt, 'number');
  assert.equal('capture' in saved, false);
  assert.equal('files' in saved, false);
  assert.equal((await execute('git', ['-C', work, 'show', `${saved.commit}:data.txt`])).stdout, 'checkpoint candidate');
  await f.reopen();
  assert.deepEqual(f.tree.checkpoints(project.id, a), [saved]);
  assert.deepEqual(await f.tree.checkpoint(project.id, a, checkpointId, {...publication,publisher:{...publisher,processId:f.id()}}), saved, 'completed retries use stable worker identity and preserve the original process metadata');
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
    await copy.close();
    const copiedLog = join(relocated, 'projects', project.id, '.polariton/graph.jsonl');
    await appendFile(copiedLog, '{torn historical suffix');
    const damaged = await readFile(copiedLog);
    copy = new ResearchTree({ ...f.config, stateRoot: relocated });
    await copy.initialize();
    assert.match(copy.graph(project.id).recovery!, /^Incomplete/);
    await assert.rejects(copy.repair(project.id), fault('WORKSPACE_RELOCATED'));
    assert.deepEqual(await readFile(copiedLog), damaged, 'historical-only inspection cannot repair source bytes');
  } finally { await copy.close(); await rm(relocated, { recursive: true, force: true }); }
});

test('manual commits and worker milestones share history; unchanged publications retain HEAD without empty commits', async t => {
  const f = await fixture(t, () => 1234), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Shared Git history');
  const node = await f.node(project.id), work = f.tree.workspace(project.id, node);
  const git = (...args: string[]) => execute('git', ['-C', work, ...args]);
  await writeFile(join(work, 'plot.png'), Buffer.from([137,80,78,71,0,255]));
  const worker = {kind:'worker' as const,id:f.id(),processId:f.id()};
  const first = await f.tree.checkpoint(project.id, node, f.id(), {publisher:worker,note:'First result'});
  const blob = (await git('rev-parse', `${first.commit}:plot.png`)).stdout;
  const unchanged = await f.tree.checkpoint(project.id, node, f.id(), {publisher:owner,note:'Reviewed result'});
  assert.notEqual(unchanged.id, first.id);
  assert.equal(unchanged.commit, first.commit);
  assert.deepEqual(unchanged.publisher, owner);
  assert.deepEqual(first.publisher, worker);
  assert.equal((await git('rev-list', '--count', 'HEAD')).stdout.trim(), '2');
  await writeFile(join(work, 'analysis.py'), 'print("corrected units")\n');
  await git('add', '-A');
  await git('-c','user.name=Researcher','-c','user.email=researcher@localhost','commit','--quiet','-m','Manual correction');
  const manual = (await git('rev-parse', 'HEAD')).stdout.trim();
  assert.equal(f.tree.checkpoints(project.id,node).length, 2, 'manual Git commits do not create Polariton records');
  const registered = await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  assert.equal(registered.commit, manual);
  assert.equal((await git('rev-parse', `${manual}^`)).stdout.trim(), first.commit);
  assert.equal((await git('rev-parse', `${manual}:plot.png`)).stdout, blob, 'unchanged binary bytes reuse their Git object');
  await writeFile(join(work, 'analysis.py'), 'print("second result")\n');
  const next = await f.tree.checkpoint(project.id,node,f.id(),{publisher:worker});
  assert.equal((await git('rev-parse', `${next.commit}^`)).stdout.trim(), manual);
  await git('reset', '--hard', first.commit);
  await git('reflog', 'expire', '--expire=now', '--all');
  await git('gc', '--prune=now');
  assert.equal((await git('rev-parse', `refs/polariton/checkpoints/${next.id}`)).stdout.trim(), next.commit);
  assert.equal((await git('show', `${next.commit}:analysis.py`)).stdout, 'print("second result")\n');
  assert.deepEqual(await f.tree.checkpoint(project.id,node,next.id,{publisher:worker}), next, 'a retry keeps its original commit after branch changes');
});

test('checkpoint and inheritance do not inherit upload size and workspace admission limits', async t => {
  const f = await fixture(t, () => 100, {maxFileBytes:8,maxWorkspaceBytes:16,maxWorkspaceFiles:1});
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Independent checkpoint resources');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node);
  const large = Buffer.alloc(1024 * 1024, 173);
  await writeFile(join(work,'result.bin'),large);
  await writeFile(join(work,'analysis.py'),'print("research")\n');
  const first = await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  const second = await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  assert.equal(second.commit,first.commit);
  const child = await f.node(project.id,'Inherited large result',{nodeId:node,checkpointId:first.id});
  assert.deepEqual(await readFile(join(f.tree.workspace(project.id,child),'result.bin')),large);
  assert.equal(await readFile(join(f.tree.workspace(project.id,child),'analysis.py'),'utf8'),'print("research")\n');
});

test('configured commit hooks run and a rejected hook preserves staging without publishing a checkpoint', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Git repository policy');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
  const git = (...args: string[]) => execute('git', ['-C',work,...args]);
  const initial = (await git('rev-parse','HEAD')).stdout;
  const hook = join(work,'.git','hooks','pre-commit');
  await writeFile(hook,'#!/bin/sh\necho "Research checks failed" >&2\nexit 1\n'); await chmod(hook,0o755);
  await writeFile(join(work,'data.txt'),'unfinished result');
  await assert.rejects(f.tree.checkpoint(project.id,node,request,{publisher:owner}), error => {
    assert.ok(fault('CHECKPOINT_GIT')(error)); assert.match((error as Error).message,/Research checks failed/); return true;
  });
  assert.equal((await git('rev-parse','HEAD')).stdout,initial);
  assert.equal((await git('show',':data.txt')).stdout,'unfinished result', 'failure must not reset the shared staging area');
  assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  await writeFile(hook,'#!/bin/sh\necho checked > .git/research-hook-ran\n');
  const saved = await f.tree.checkpoint(project.id,node,request,{publisher:owner});
  assert.equal(await readFile(join(work,'.git','research-hook-ran'),'utf8'),'checked\n');
  assert.equal((await git('rev-parse','HEAD')).stdout.trim(),saved.commit);
});

for (const state of ['detached','merge','rebase','cherry-pick','revert','unborn'] as const) {
  test(`checkpoint refuses ${state} Git state without staging or repairing the repository`, async t => {
    const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Unsupported Git state');
    const node = await f.node(project.id), work = f.tree.workspace(project.id,node);
    const git = (...args: string[]) => execute('git',['-C',work,...args]);
    const head = (await git('rev-parse','HEAD')).stdout.trim();
    if(state==='detached') await git('checkout','--detach','--quiet');
    else if(state==='unborn') await git('symbolic-ref','HEAD','refs/heads/unborn');
    else if(state==='rebase') await mkdir(join(work,'.git','rebase-merge'));
    else await writeFile(join(work,'.git',state==='merge'?'MERGE_HEAD':state==='cherry-pick'?'CHERRY_PICK_HEAD':'REVERT_HEAD'),head+'\n');
    await writeFile(join(work,'draft.txt'),'uncommitted research');
    await assert.rejects(f.tree.checkpoint(project.id,node,f.id(),{publisher:owner}),fault('CHECKPOINT_STATE'));
    assert.equal((await git('ls-files','--','draft.txt')).stdout,'');
    assert.equal(await readFile(join(work,'draft.txt'),'utf8'),'uncommitted research');
    assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  });
}

/** Expire the platform deadline only after the real Git hook reaches its barrier.
 * Filesystem/process startup remains unconstrained by the simulated clock; failure
 * to reach the hook is independently bounded and reported as a fixture failure. */
async function expireAtHook(t: TestContext, workspace: string, publish: () => Promise<unknown>) {
  const deadline = new AbortController(), observation = new AbortController();
  const startup = AbortSignal.timeout(testDeadline(10000));
  const marker = (async () => {
    while (!observation.signal.aborted) {
      if (startup.aborted) throw new Error('Git hook did not reach its startup barrier within the test budget');
      try { await stat(join(workspace,'.git','blocked-hook')); return; }
      catch (error) { if (!fault('ENOENT')(error)) throw error; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Hook observation ended before startup');
  })();
  const timeout = t.mock.method(AbortSignal,'timeout', () => deadline.signal);
  let publication: Promise<unknown> | undefined;
  try {
    publication = publish();
    await Promise.race([marker, publication.then(() => { throw new Error('Publication completed before the blocked hook deadline'); })]);
    deadline.abort(new DOMException('Injected checkpoint deadline','TimeoutError'));
    await assert.rejects(publication,fault('CHECKPOINT_TIMEOUT'));
  } finally {
    timeout.mock.restore();
    deadline.abort(); observation.abort();
    await Promise.allSettled([marker, ...(publication ? [publication] : [])]);
  }
}

test('a timed out commit hook leaves no running mutation and the same publication can retry', {timeout:testDeadline(15000)}, async t => {
  const f = await fixture(t, () => 100, {checkpointKillGraceMs:testDeadline(100)});
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Checkpoint timeout');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
  const hook = join(work,'.git','hooks','pre-commit');
  await writeFile(hook,'#!/bin/sh\necho "hook reached" > .git/blocked-hook.pending\nmv .git/blocked-hook.pending .git/blocked-hook\nwhile :; do sleep 60; done\n'); await chmod(hook,0o755);
  await writeFile(join(work,'data.txt'),'retained after retry');
  await expireAtHook(t,work,() => f.tree.checkpoint(project.id,node,request,{publisher:owner}));
  assert.equal(await readFile(join(work,'.git','blocked-hook'),'utf8'),'hook reached\n');
  assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  await rm(hook);
  const saved = await f.tree.checkpoint(project.id,node,request,{publisher:owner});
  assert.equal((await execute('git',['-C',work,'show',`${saved.commit}:data.txt`])).stdout,'retained after retry');
  assert.equal((await execute('git',['-C',work,'rev-list','--count','HEAD'])).stdout.trim(),'2');
});

test('a commit completed before hook timeout is recovered exactly after restart and later manual work', {timeout:testDeadline(15000)}, async t => {
  const f = await fixture(t, () => 100, {checkpointKillGraceMs:testDeadline(100)});
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Uncertain commit recovery');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
  const git = (...args: string[]) => execute('git',['-C',work,...args]);
  const hook = join(work,'.git','hooks','post-commit');
  await writeFile(hook,'#!/bin/sh\necho "committed" > .git/blocked-hook.pending\nmv .git/blocked-hook.pending .git/blocked-hook\nwhile :; do sleep 60; done\n'); await chmod(hook,0o755);
  await writeFile(join(work,'data.txt'),'exact publication candidate');
  await expireAtHook(t,work,() => f.tree.checkpoint(project.id,node,request,{publisher:owner}));
  assert.equal(await readFile(join(work,'.git','blocked-hook'),'utf8'),'committed\n');
  const candidate = (await git('rev-parse','HEAD')).stdout.trim();
  await rm(hook);
  await writeFile(join(work,'data.txt'),'later manual revision');
  await git('add','-A');
  await git('-c','user.name=Researcher','-c','user.email=researcher@localhost','commit','--quiet','-m','Later manual commit');
  const later = (await git('rev-parse','HEAD')).stdout.trim();
  await f.reopen();
  const saved = await f.tree.checkpoint(project.id,node,request,{publisher:owner});
  assert.equal(saved.commit,candidate);
  assert.equal((await git('show',`${saved.commit}:data.txt`)).stdout,'exact publication candidate');
  assert.equal((await git('rev-parse','HEAD')).stdout.trim(),later);
  assert.equal((await git('rev-list','--count','HEAD')).stdout.trim(),'3', 'recovery creates no duplicate commit');
  assert.deepEqual(await f.tree.checkpoint(project.id,node,request,{publisher:owner}),saved);
});

test('a hook that removes publication identity produces an explicit recovery conflict', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Altered recovery marker');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
  const git = (...args: string[]) => execute('git',['-C',work,...args]);
  const hook = join(work,'.git','hooks','commit-msg');
  await writeFile(hook,'#!/bin/sh\nprintf "Rewritten message without publication identity\\n" > "$1"\n'); await chmod(hook,0o755);
  await writeFile(join(work,'data.txt'),'committed despite altered marker');
  await assert.rejects(f.tree.checkpoint(project.id,node,request,{publisher:owner}),fault('CHECKPOINT_RECOVERY_CONFLICT'));
  assert.equal((await git('rev-list','--count','HEAD')).stdout.trim(),'2', 'the commit is retained as actual shared Git state');
  assert.deepEqual(f.tree.checkpoints(project.id,node),[]);
  await rm(hook);
  await f.reopen();
  await assert.rejects(f.tree.checkpoint(project.id,node,request,{publisher:owner}),fault('CHECKPOINT_RECOVERY_CONFLICT'));
  assert.equal((await git('rev-list','--count','HEAD')).stdout.trim(),'2', 'ambiguous recovery must not create a duplicate commit');
  await git('reset','--hard','HEAD^');
  await git('reflog','expire','--expire=now','--all');
  await git('gc','--prune=now');
  await f.reopen();
  await assert.rejects(f.tree.checkpoint(project.id,node,request,{publisher:owner}),fault('CHECKPOINT_RECOVERY_CONFLICT'));
  assert.equal((await git('rev-list','--count','HEAD')).stdout.trim(),'1', 'erasing commit evidence does not authorize repeating an uncertain commit');
});

test('a selected checkpoint awaiting its final reference survives branch rewrite and Git cleanup', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Pending candidate retention');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
  const git = (...args: string[]) => execute('git',['-C',work,...args]);
  const initial = (await git('rev-parse','HEAD')).stdout.trim();
  await writeFile(join(work,'data.txt'),'candidate must survive cleanup');
  const lock = join(work,'.git','refs','polariton','checkpoints',request+'.lock');
  await mkdir(dirname(lock),{recursive:true}); await writeFile(lock,'locked final reference');
  await assert.rejects(f.tree.checkpoint(project.id,node,request,{publisher:owner}));
  const candidate = (await git('rev-parse','HEAD')).stdout.trim();
  await git('reset','--hard',initial);
  await git('reflog','expire','--expire=now','--all');
  await git('gc','--prune=now');
  await rm(lock);
  await f.reopen();
  const saved = await f.tree.checkpoint(project.id,node,request,{publisher:owner});
  assert.equal(saved.commit,candidate);
  assert.equal((await git('show',`${saved.commit}:data.txt`)).stdout,'candidate must survive cleanup');
  assert.equal((await git('rev-parse','HEAD')).stdout.trim(),initial);
});

test('successful publication terminates background hook children before releasing its workspace', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Hook child ownership');
  const node = await f.node(project.id), work = f.tree.workspace(project.id,node);
  const hook = join(work,'.git','hooks','post-commit');
  await writeFile(hook, '#!/bin/sh\n(while [ ! -f .git/release-background ]; do sleep 0.01; done; echo escaped > .git/background-write) >/dev/null 2>&1 &\n');
  await chmod(hook,0o755); await writeFile(join(work,'data.txt'),'shared progress');
  await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
  await writeFile(join(work,'.git','release-background'),'publication returned');
  await new Promise(resolve => setTimeout(resolve,testDeadline(200)));
  await assert.rejects(readFile(join(work,'.git','background-write')),fault('ENOENT'));
});

for (const changed of [false, true]) {
  test(`a process crash after retaining a ${changed ? 'changed' : 'no-change'} candidate recovers the exact checkpoint before newer manual work`, {timeout:testDeadline(15000)}, async t => {
    const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Publication process crash');
    const node = await f.node(project.id), work = f.tree.workspace(project.id,node), request = f.id();
    const git = (...args: string[]) => execute('git',['-C',work,...args]);
    await writeFile(join(work,'data.txt'),'original retained evidence');
    const baseline = await f.tree.checkpoint(project.id,node,f.id(),{publisher:owner});
    if (changed) await writeFile(join(work,'data.txt'),'new publication candidate');
    const hook = join(work,'.git','hooks','reference-transaction');
    await writeFile(hook, `#!/bin/sh
[ "$1" = committed ] || exit 0
while read old new ref; do
  if [ "$ref" = "refs/polariton/publications/${request}" ]; then
    kill -KILL "$POLARITON_TEST_PUBLICATION_PID"
  fi
done
`);
    await chmod(hook,0o755);
    await f.tree.close();
    // A real Git hook interrupts the publication process after reference durability
    // and before its command returns. No test edits the publication journal.
    const program = `
import {ResearchTree} from ${JSON.stringify(new URL('../src/research.ts',import.meta.url).href)};
import {loadConfig} from ${JSON.stringify(new URL('../src/config.ts',import.meta.url).href)};
process.env.POLARITON_TEST_PUBLICATION_PID=String(process.pid);
const tree=new ResearchTree({...await loadConfig(),stateRoot:process.env.POLARITON_TEST_STATE});
await tree.initialize();
try { await tree.checkpoint(${JSON.stringify(project.id)},${JSON.stringify(node)},${JSON.stringify(request)},{publisher:{kind:'owner',id:'local-owner'},note:'Crash interval'}); }
finally { await tree.close(); }
`;
    await assert.rejects(execute(process.execPath,['--input-type=module','-e',program],{
      env:{...process.env,POLARITON_TEST_STATE:f.root},timeout:testDeadline(10000),
    }), error => error instanceof Error && 'signal' in error && error.signal === 'SIGKILL');
    await rm(hook);
    const candidate = (await git('rev-parse','HEAD')).stdout.trim();
    if (!changed) assert.equal(candidate,baseline.commit);
    else assert.notEqual(candidate,baseline.commit);
    await writeFile(join(work,'data.txt'),'later manual revision');
    await git('add','-A');
    await git('-c','user.name=Researcher','-c','user.email=researcher@localhost','commit','--quiet','-m','Manual work after process loss');
    const later = (await git('rev-parse','HEAD')).stdout.trim();
    await writeFile(join(work,'draft.txt'),'newer uncommitted work');
    await f.reopen();
    const saved = f.tree.checkpoints(project.id,node).find(checkpoint => checkpoint.id===request);
    assert.ok(saved,'startup completes the retained candidate without requiring another publication');
    assert.equal(saved.commit,candidate);
    assert.equal(saved.note,'Crash interval');
    assert.equal((await git('show',`${saved.commit}:data.txt`)).stdout,changed ? 'new publication candidate' : 'original retained evidence');
    assert.equal((await git('rev-parse','HEAD')).stdout.trim(),later);
    assert.equal((await git('ls-files','--','draft.txt')).stdout,'','recovery never stages newer working files');
    assert.deepEqual(await f.tree.checkpoint(project.id,node,request,{publisher:owner,note:'Crash interval'}),saved);
  });
}
