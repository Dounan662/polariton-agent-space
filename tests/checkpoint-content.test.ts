import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import {CheckpointContent} from '../src/checkpoint-content.ts';
import {temporaryDirectory} from './fixtures/storage.ts';

const execute = promisify(execFile);
const limits = {checkpointTimeoutMs: 60000, checkpointMaxProcesses: 2, checkpointOutputBytes: 65536,
  checkpointBufferBytes: 4096, checkpointKillGraceMs: 50};
const env = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
const git = async (cwd: string, args: string[]) => (await execute('git', ['-C', cwd, ...args], {env})).stdout.trim();
const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
async function fixture(t: TestContext) {
  const root = await temporaryDirectory('checkpoint-content-'), source = join(root, 'source'), target = join(root, 'child');
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(source);
  await git(source, ['init', '--quiet', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Researcher']);
  await git(source, ['config', 'user.email', 'research@example.test']);
  return {root, source, target, content: new CheckpointContent(limits), async commit(message = 'Research progress') {
    await git(source, ['add', '-A']);
    await git(source, ['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(source, ['rev-parse', 'HEAD']);
  }};
}

test('inheritance retains large bytes, executable modes and exact tree with independent history', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'run.sh'), '#!/bin/sh\necho research\n');
  await chmod(join(f.source, 'run.sh'), 0o755);
  await f.commit('Earlier work');
  const data = await open(join(f.source, 'large.png'), 'w');
  try { await data.truncate(24 * 1024 * 1024); } finally { await data.close(); }
  await writeFile(join(f.source, 'space and\nnewline.txt'), 'Retained research');
  const commit = await f.commit();
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal((await stat(join(f.target, 'large.png'))).size, 24 * 1024 * 1024);
  assert.equal((await stat(join(f.target, 'run.sh'))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(f.target, 'space and\nnewline.txt'), 'utf8'), 'Retained research');
  assert.equal(await git(f.target, ['rev-parse', 'HEAD^{tree}']), await git(f.source, ['rev-parse', `${commit}^{tree}`]));
  assert.equal(await git(f.target, ['rev-list', '--count', 'HEAD']), '1');
  assert.equal(await git(f.target, ['remote']), '');
  assert.equal(await git(f.target, ['status', '--porcelain']), '');
  const childHead = await git(f.target, ['rev-parse', 'HEAD']);
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal(await git(f.target, ['rev-parse', 'HEAD']), childHead);
  await rm(f.source, {recursive: true});
  assert.equal(await git(f.target, ['fsck', '--full']), '');
});

test('retained bytes are inherited without applying filters twice or archive export attributes', async t => {
  const f = await fixture(t);
  await git(f.source, ['config', 'filter.prefix.clean', "sed 's/^/clean:/'"]);
  await git(f.source, ['config', 'filter.prefix.smudge', "sed 's/^/smudge:/'"]);
  await writeFile(join(f.source, '.gitattributes'), '*.txt filter=prefix\n*.dat export-ignore\n');
  await writeFile(join(f.source, 'analysis.txt'), 'result\n');
  await writeFile(join(f.source, 'evidence.dat'), 'must remain retained\n');
  const commit = await f.commit();
  assert.equal(await git(f.source, ['show', `${commit}:analysis.txt`]), 'clean:result');
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal(await readFile(join(f.target, 'analysis.txt'), 'utf8'), 'clean:result\n');
  assert.equal(await readFile(join(f.target, 'evidence.dat'), 'utf8'), 'must remain retained\n');
  assert.equal(await git(f.target, ['rev-parse', 'HEAD^{tree}']), await git(f.source, ['rev-parse', `${commit}^{tree}`]));
});

test('interrupted inheritance accepts identical files and preserves conflicting user content', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'analysis.txt'), 'retained\n');
  const commit = await f.commit();
  await mkdir(f.target);
  await writeFile(join(f.target, 'analysis.txt'), 'user changes\n');
  await assert.rejects(f.content.initializeFromCheckpoint(f.source, commit, f.target), fault('PROVISION_CONFLICT'));
  assert.equal(await readFile(join(f.target, 'analysis.txt'), 'utf8'), 'user changes\n');
  await writeFile(join(f.target, 'analysis.txt'), 'retained\n');
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal(await git(f.target, ['rev-parse', 'HEAD^{tree}']), await git(f.source, ['rev-parse', `${commit}^{tree}`]));
});

test('extra ignored files prevent falsely complete initialization', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, '.gitignore'), '*.cache\n');
  const commit = await f.commit();
  await mkdir(f.target);
  await writeFile(join(f.target, 'unrelated.cache'), 'keep this\n');
  await assert.rejects(f.content.initializeFromCheckpoint(f.source, commit, f.target), fault('PROVISION_CONFLICT'));
  assert.equal(await readFile(join(f.target, 'unrelated.cache'), 'utf8'), 'keep this\n');
});

test('symlinks, gitlinks and external Git LFS payloads fail explicitly', async t => {
  for (const kind of ['symlink', 'gitlink', 'lfs'] as const) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const initial = await f.commit('Initial');
      if (kind === 'symlink') await symlink('../outside', join(f.source, 'link'));
      if (kind === 'lfs') await writeFile(join(f.source, 'data.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abcdef\nsize 123\n');
      let commit: string;
      if (kind === 'gitlink') {
        await git(f.source, ['update-index', '--add', '--cacheinfo', `160000,${initial},external`]);
        await git(f.source, ['commit', '--quiet', '-m', 'External repository']);
        commit = await git(f.source, ['rev-parse', 'HEAD']);
      } else commit = await f.commit();
      await assert.rejects(f.content.initializeFromCheckpoint(f.source, commit, f.target), fault('UNSUPPORTED_CHECKPOINT_CONTENT'));
    });
  }
});

test('existing directory symlinks cannot redirect inherited writes outside the destination', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside');
  await mkdir(join(f.source, 'nested'));
  await writeFile(join(f.source, 'nested', 'result'), 'retained');
  const commit = await f.commit();
  await mkdir(f.target); await mkdir(outside);
  await symlink(outside, join(f.target, 'nested'));
  await assert.rejects(f.content.initializeFromCheckpoint(f.source, commit, f.target), fault('PROVISION_CONFLICT'));
  await assert.rejects(stat(join(outside, 'result')), {code: 'ENOENT'});
});

test('cancellation during visible import progress releases resources and retry completes safely', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await writeFile(join(f.source, `result-${i}.txt`), `Result ${i}\n`);
  const commit = await f.commit();
  await mkdir(f.target);
  const cancellation = new AbortController();
  let settled = false;
  const importing = f.content.initializeFromCheckpoint(f.source, commit, f.target, cancellation.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(importing, /Cancelled by user/);
  while (!settled) {
    if (await stat(join(f.target, 'result-0.txt')).catch(() => null)) { cancellation.abort(new Error('Cancelled by user')); break; }
    await setTimeout(1);
  }
  await rejected;
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal(await git(f.target, ['status', '--porcelain']), '');
  assert.equal(await git(f.target, ['rev-list', '--count', 'HEAD']), '1');
});

test('expired import deadline is observable and does not prevent a subsequent import', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'result.txt'), 'result');
  const commit = await f.commit();
  const content = new CheckpointContent({...limits, checkpointTimeoutMs: 1});
  await assert.rejects(content.initializeFromCheckpoint(f.source, commit, f.target), {name: 'TimeoutError'});
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  assert.equal(await readFile(join(f.target, 'result.txt'), 'utf8'), 'result');
});

test('concurrent initialization of one destination fails promptly without corrupting its owner', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'result.txt'), 'result');
  const commit = await f.commit();
  const importing = f.content.initializeFromCheckpoint(f.source, commit, f.target);
  await assert.rejects(f.content.initializeFromCheckpoint(f.source, commit, f.target), fault('CHECKPOINT_BUSY'));
  await importing;
  assert.equal(await readFile(join(f.target, 'result.txt'), 'utf8'), 'result');
});


test('restart reclaims only orphaned inheritance scratch and preserves unrelated Git state', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'result.txt'), 'retained result');
  const commit = await f.commit();
  await mkdir(f.target);
  await git(f.target, ['init', '--quiet', '-b', 'main']);
  // Model a process death while streaming a large blob, before any child commit.
  const orphan = await mkdtemp(join(f.target, '.git', 'polariton-inherit-'));
  const partial = await open(join(orphan, 'blob'), 'w');
  try { await partial.truncate(24 * 1024 * 1024); } finally { await partial.close(); }
  const notes = join(f.target, '.git', 'polariton-inherit-user-notes');
  await mkdir(notes); await writeFile(join(notes, 'keep'), 'unrelated Git data');
  const outside = join(f.root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'keep'), 'outside data');
  const alias = join(f.target, '.git', 'polariton-inherit-ABC123');
  await symlink(outside, alias);
  await f.content.initializeFromCheckpoint(f.source, commit, f.target);
  await assert.rejects(stat(orphan), {code: 'ENOENT'});
  assert.equal(await readFile(join(notes, 'keep'), 'utf8'), 'unrelated Git data');
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside data');
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  assert.equal(await git(f.target, ['rev-parse', 'HEAD^{tree}']), await git(f.source, ['rev-parse', `${commit}^{tree}`]));
});
