import {owner} from '../src/caller.ts';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, readFile, writeFile, rm, rename, cp, symlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute = promisify(execFile);
import { temporaryDirectory } from './fixtures/storage.ts';
import { createHash } from 'node:crypto';
import { ResearchTree } from '../src/research.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { UploadPublication } from '../src/contracts.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
const absent = async (path: string) => assert.rejects(stat(path), (error: unknown) => fault('ENOENT')(error));

/** Public ResearchTree operations own state; real files model independent host writers. */
async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const root = await temporaryDirectory('test-adr006-workspaces-');
  const state = join(root, 'state'); await mkdir(state);
  const config = { ...await loadConfig(), ...overrides, stateRoot: state, verification: false };
  let tree = new ResearchTree(config); await tree.initialize();
  t.after(async () => { await tree.close(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  return {
    root, state, config, id, get tree() { return tree; },
    async reopen() { await tree.close(); tree = new ResearchTree(config); await tree.initialize(); },
    async stopped(work: () => Promise<void>) {
      await tree.close();
      try { await work(); } finally { tree = new ResearchTree(config); await tree.initialize(); }
    },
    async node(project: string) {
      const node = id();
      await tree.mutate(project, { operationId: id(), revision: tree.graph(project).revision,
        command: { kind: 'node.create', id: node, title: 'Synthetic research', description: '' } });
      return node;
    },
    upload(path: string, bytes: string | Buffer, expectedVersion?: string): { input: UploadPublication; bytes: Buffer } {
      return { input: { operationId: id(), path, digest: hash(bytes), ...(expectedVersion ? { expectedVersion } : {}) }, bytes: Buffer.from(bytes) };
    },
  };
}

test('chosen roots preserve unrelated files, bind nodes independently, and reject managed-root overlap', async t => {
  const f = await fixture(t), root = join(f.root, 'research');
  await mkdir(root); await writeFile(join(root, 'notes.txt'), 'existing unrelated material');
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'External project', root);
  assert.equal(project.root, root); assert.equal(project.availability, 'available');
  const node = await f.node(project.id);
  assert.equal(f.tree.workspace(project.id, node), join(root, 'nodes', node));
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'existing unrelated material');
  await absent(join(root, '.git'));
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Same', root), fault('PROJECT_OVERLAP'));
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Nested', join(root, 'child')), fault('PROJECT_OVERLAP'));
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Parent', f.root), fault('PROJECT_OVERLAP'));
  const graph = f.tree.graph(project.id); await f.reopen();
  assert.deepEqual(f.tree.projects(), [project]); assert.deepEqual(f.tree.graph(project.id), graph);
});

test('conflicting project-owned directories and noncanonical paths cannot claim host files', async t => {
  const f = await fixture(t);
  for (const reserved of ['nodes', '.polariton', '.labra']) {
    const root = join(f.root, `conflict-${reserved}`); await mkdir(join(root, reserved), { recursive: true });
    const sentinel = join(root, reserved, 'owned.txt'); await writeFile(sentinel, 'another owner');
    const original=await readFile(sentinel);
    await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Conflicting owner', root), fault('PROJECT_COLLISION'));
    assert.deepEqual(await readFile(sentinel), original);
    assert.deepEqual(await readdir(root), [reserved]);
    assert.deepEqual(f.tree.projects(), []);
  }
  const real = join(f.root, 'real'); await mkdir(real); const alias = join(f.root, 'alias'); await symlink(real, alias);
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Aliased root', alias), fault('PROJECT_PATH'));
  await absent(join(real, '.polariton'));
  const nestedAlias = join(f.root, 'nested-alias'); await symlink(real, nestedAlias);
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Nested aliased root', join(nestedAlias, 'new')), fault('PROJECT_PATH'));
  await absent(join(real, 'new'));
  await assert.rejects(f.tree.createProject(globalThis.crypto.randomUUID(), 'Relative', 'relative/root'), fault('PROJECT_PATH'));
});

test('concurrent registration admits one owner for the same host directory', async t => {
  const f = await fixture(t), root = join(f.root, 'contended-root');
  const outcomes = await Promise.allSettled([
    f.tree.createProject(globalThis.crypto.randomUUID(), 'First claimant', root), f.tree.createProject(globalThis.crypto.randomUUID(), 'Second claimant', root),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.tree.projects().filter(project => project.root === root).length, 1, 'rejected admission must not retain a second overlapping project');
  await f.reopen();
  assert.equal(f.tree.projects().filter(project => project.root === root && project.availability === 'available').length, 1);
});

test('a copied registry remains historical and cannot take ownership after the original owner closes', async t => {
  const f = await fixture(t); const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Shared root', join(f.root, 'external'));
  const node = await f.node(project.id); const graph = f.tree.graph(project.id);
  const otherState = join(f.root, 'other-state');
  await f.stopped(() => cp(f.state, otherState, { recursive: true }));
  const otherConfig = { ...f.config, stateRoot: otherState };
  let other: ResearchTree | null = new ResearchTree(otherConfig); await other.initialize();
  try {
    assert.equal(other.projects()[0]?.availability, 'historical'); assert.match(other.projects()[0]?.detail ?? '', /historical/i);
    await assert.rejects(other.mutate(project.id, { operationId: f.id(), revision: graph.revision,
      command: { kind: 'node.edit', id: node, title: 'Forbidden second writer', description: '' } }), fault('WORKSPACE_RELOCATED'));
    await other.close(); other = null;
    await f.stopped(async () => {
      other = new ResearchTree(otherConfig); await other.initialize();
      assert.equal(other.projects()[0]?.availability, 'historical'); assert.deepEqual(other.graph(project.id), graph);
      assert.throws(() => other!.workspace(project.id, node, 'write'), fault('WORKSPACE_RELOCATED'));
      await other.close(); other = null;
    });
  } finally { await other?.close(); }
  assert.equal(f.tree.projects()[0]?.availability, 'available');
});

test('unavailable roots remain explicit and do not prevent unrelated project creation', async t => {
  const f = await fixture(t), root = join(f.root, 'external'), moved = join(f.root, 'temporarily-away');
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Temporarily offline', root); const node = await f.node(project.id);
  await f.stopped(() => rename(root, moved));
  assert.equal(f.tree.projects().find(p => p.id === project.id)?.availability, 'unavailable');
  const independent = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Independent', join(f.root, 'independent'));
  assert.equal(independent.availability, 'available');
  await f.stopped(() => rename(moved, root));
  assert.equal(f.tree.projects().find(p => p.id === project.id)?.availability, 'available');
  assert.equal(f.tree.graph(project.id).nodes[0]?.id, node);
});

test('upload receipts survive restart, replay once, and bind digest, path, node, and project', async t => {
  const f = await fixture(t); const a = await f.tree.createProject(globalThis.crypto.randomUUID(), 'A'); const b = await f.tree.createProject(globalThis.crypto.randomUUID(), 'B');
  const node = await f.node(a.id), otherNode = await f.node(a.id), foreignNode = await f.node(b.id);
  const upload = f.upload('nested/data.txt', 'synthetic upload');
  const staged = await f.tree.stageUpload(a.id, node, upload.input, upload.bytes);
  assert.equal(staged.state, 'staged'); await absent(join(f.tree.workspace(a.id, node), upload.input.path));
  await f.reopen(); assert.deepEqual(await f.tree.stageUpload(a.id, node, upload.input, upload.bytes), staged);
  await assert.rejects(f.tree.stageUpload(a.id, otherNode, upload.input, upload.bytes), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.stageUpload(b.id, foreignNode, upload.input, upload.bytes), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.stageUpload(a.id, node, { ...upload.input, path: 'changed.txt' }, upload.bytes), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.stageUpload(a.id, node, { ...upload.input, digest: hash('changed') }, Buffer.from('changed')), fault('OPERATION_CONFLICT'));
  await assert.rejects(f.tree.publishUpload(a.id, otherNode, upload.input), fault('UPLOAD_NOT_FOUND'));
  const published = await f.tree.publishUpload(a.id, node, upload.input); assert.equal(published.state, 'published');
  assert.deepEqual(await f.tree.file(a.id, node, upload.input.path), upload.bytes);
  await f.reopen();
  assert.deepEqual(await f.tree.publishUpload(a.id, node, upload.input), published);
  assert.equal((await f.tree.stageUpload(a.id, node, upload.input, upload.bytes)).state, 'published');
  await writeFile(join(f.tree.workspace(a.id, node), upload.input.path), 'later host edit');
  assert.deepEqual(await f.tree.publishUpload(a.id, node, upload.input), published);
  assert.equal((await f.tree.file(a.id, node, upload.input.path)).toString(), 'later host edit', 'retry acknowledges prior publication without replaying its write');
});

test('uploads never overwrite implicitly and replacement requires the captured current version', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Collision handling'), node = await f.node(project.id);
  const path = join(f.tree.workspace(project.id, node), 'result.txt'); await writeFile(path, 'original');
  const implicit = f.upload('result.txt', 'implicit overwrite'); await f.tree.stageUpload(project.id, node, implicit.input, implicit.bytes);
  await assert.rejects(f.tree.publishUpload(project.id, node, implicit.input), fault('FILE_CONFLICT'));
  assert.equal(await readFile(path, 'utf8'), 'original');
  const stale = f.upload('result.txt', 'stale replacement', hash('original')); await f.tree.stageUpload(project.id, node, stale.input, stale.bytes);
  await writeFile(path, 'independent newer edit');
  await assert.rejects(f.tree.publishUpload(project.id, node, stale.input), fault('FILE_CONFLICT'));
  assert.equal(await readFile(path, 'utf8'), 'independent newer edit');
  const valid = f.upload('result.txt', 'accepted replacement', hash('independent newer edit'));
  await f.tree.stageUpload(project.id, node, valid.input, valid.bytes); await f.tree.publishUpload(project.id, node, valid.input);
  assert.equal(await readFile(path, 'utf8'), 'accepted replacement');
});

test('traversal and symlink publication reject without writing outside the admitted workspace', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Path boundary'), node = await f.node(project.id);
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(outside, join(f.tree.workspace(project.id, node), 'escape'));
  for (const path of ['../escape.txt', '/tmp/escape.txt', '.git/config', '.polariton/metadata']) {
    const upload = f.upload(path, 'unadmitted');
    await assert.rejects(f.tree.stageUpload(project.id, node, upload.input, upload.bytes), fault('FILE_DENIED'));
  }
  await assert.rejects(f.tree.readPage(project.id, node, 'escape/secret.txt'), fault('FILE_DENIED'));
  await assert.rejects(f.tree.directory(project.id, node, 'escape'), fault('FILE_DENIED'));
  const upload = f.upload('escape/new/forbidden.txt', 'must not escape');
  await f.tree.stageUpload(project.id, node, upload.input, upload.bytes);
  await assert.rejects(f.tree.publishUpload(project.id, node, upload.input), fault('FILE_DENIED'));
  await absent(join(outside, 'new'));
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside');
});

test('file browsing is lazy, directories-first and naturally ordered, with private paths excluded', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Browsing'), node = await f.node(project.id);
  const root = f.tree.workspace(project.id, node);
  await mkdir(join(root, 'dir2')); await mkdir(join(root, 'dir10')); await mkdir(join(root, '.polariton'));
  await writeFile(join(root, 'file10.txt'), 'ten'); await writeFile(join(root, 'file2.txt'), 'two');
  await writeFile(join(root, 'dir2', 'child.txt'), 'nested'); await symlink(join(root, 'dir2'), join(root, 'linked'));
  assert.deepEqual((await f.tree.directory(project.id, node)).map(e => e.name), ['dir2', 'dir10', 'file2.txt', 'file10.txt']);
  assert.deepEqual(await f.tree.directory(project.id, node, 'dir2'), [{ name: 'child.txt', path: 'dir2/child.txt', kind: 'file', bytes: 6 }]);
  await assert.rejects(f.tree.directory(project.id, node, '../'), fault('FILE_DENIED'));
});

test('paged previews reconstruct exact Unicode text and reject mixed versions or invalid offsets', async t => {
  const f = await fixture(t, { filePageBytes: 7 }); const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Preview'), node = await f.node(project.id);
  const text = 'alpha 界 🌊 omega\n'; const path = join(f.tree.workspace(project.id, node), 'unicode.txt'); await writeFile(path, text);
  let offset = 0, combined = '', pages = 0;
  do {
    const page = await f.tree.readPage(project.id, node, 'unicode.txt', offset, hash(text));
    assert.equal(page.version, hash(text)); assert.equal(page.bytes, Buffer.byteLength(text)); assert.equal(page.offset, offset);
    assert.ok(!page.text.includes('\ufffd')); combined += page.text; pages++;
    if (page.next === null) break;
    assert.ok(page.next > offset); offset = page.next;
  } while (pages < 20);
  assert.equal(combined, text);
  assert.equal((await f.tree.readPage(project.id, node, 'unicode.txt', 0, undefined, Buffer.byteLength(text))).text, text);
  for (const length of [0, -1, 0.5, f.config.maxFileBytes + 1])
    await assert.rejects(f.tree.readPage(project.id, node, 'unicode.txt', 0, undefined, length), fault('FILE_LENGTH'));
  await writeFile(path, 'new version');
  await assert.rejects(f.tree.readPage(project.id, node, 'unicode.txt', 0, hash(text)), fault('FILE_CHANGED'));
  for (const offset of [-1, 0.5, 100]) await assert.rejects(f.tree.readPage(project.id, node, 'unicode.txt', offset), fault('FILE_OFFSET'));
});

test('small configured pages cannot trap Unicode readers at a nonadvancing offset', async t => {
  const f = await fixture(t, { filePageBytes: 2 }); const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Small preview'), node = await f.node(project.id);
  await writeFile(join(f.tree.workspace(project.id, node), 'unicode.txt'), '界x');
  const page = await f.tree.readPage(project.id, node, 'unicode.txt');
  assert.ok(page.next === null || page.next > page.offset, 'a valid page must make progress even at a multibyte scalar');
  assert.ok(!page.text.includes('\ufffd'));
});

test('staging enforces content integrity, per-file limits, and aggregate admission', async t => {
  const f = await fixture(t, { maxFileBytes: 8, maxStagedBytes: 10 }); const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Upload budget'), node = await f.node(project.id);
  const bad = f.upload('bad.txt', 'right');
  await assert.rejects(f.tree.stageUpload(project.id, node, bad.input, Buffer.from('wrong')), fault('UPLOAD_DIGEST'));
  const large = f.upload('large.txt', '123456789'); await assert.rejects(f.tree.stageUpload(project.id, node, large.input, large.bytes), fault('FILE_LIMIT'));
  const first = f.upload('first.txt', '123456'); await f.tree.stageUpload(project.id, node, first.input, first.bytes);
  const second = f.upload('second.txt', '12345'); await assert.rejects(f.tree.stageUpload(project.id, node, second.input, second.bytes), fault('STAGING_LIMIT'));
  await f.tree.publishUpload(project.id, node, first.input);
  await assert.rejects(f.tree.stageUpload(project.id, node, second.input, second.bytes), fault('STAGING_LIMIT'));
  assert.equal((await f.tree.stageUpload(project.id, node, first.input, first.bytes)).state, 'published', 'a retained receipt can be retried without charging its bytes twice');
});

test('workspace aggregate limits apply before publication changes the target', async t => {
  const f = await fixture(t, { maxFileBytes: 16, maxWorkspaceBytes: 8, maxWorkspaceFiles: 1 });
  const project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Workspace budget'), node = await f.node(project.id);
  await writeFile(join(f.tree.workspace(project.id, node), 'existing.txt'), '1234');
  const extra = f.upload('extra.txt', '5678'); await f.tree.stageUpload(project.id, node, extra.input, extra.bytes);
  await assert.rejects(f.tree.publishUpload(project.id, node, extra.input), fault('WORKSPACE_LIMIT'));
  await absent(join(f.tree.workspace(project.id, node), 'extra.txt'));
  const oversized = f.upload('existing.txt', '123456789', hash('1234')); await f.tree.stageUpload(project.id, node, oversized.input, oversized.bytes);
  await assert.rejects(f.tree.publishUpload(project.id, node, oversized.input), fault('WORKSPACE_LIMIT'));
  assert.equal((await f.tree.file(project.id, node, 'existing.txt')).toString(), '1234');
});

test('checkpoint and file publication exclude each other while staging and workspace access remain independent', async t => {
  const f = await fixture(t), project = await f.tree.createProject(globalThis.crypto.randomUUID(), 'Checkpoint boundary'), node = await f.node(project.id);
  const upload = f.upload('published.txt', 'published bytes'); await f.tree.stageUpload(project.id, node, upload.input, upload.bytes);
  const checkpointPending = f.tree.checkpoint(project.id, node, f.id(), {publisher:owner});
  await assert.rejects(f.tree.publishUpload(project.id, node, upload.input), fault('CHECKPOINT_BUSY'));
  const before = await checkpointPending;
  assert.equal(execFileSync('git',['-C',f.tree.workspace(project.id,node),'ls-tree','--name-only',before.commit],{encoding:'utf8'}),'','staged upload bytes belong to no workspace checkpoint');
  const publishing = f.tree.publishUpload(project.id, node, upload.input);
  await assert.rejects(f.tree.checkpoint(project.id, node, f.id(), {publisher:owner}), fault('CHECKPOINT_BUSY'));
  await publishing;
  const checkpoint = f.tree.checkpoint(project.id, node, f.id(), {publisher:owner});
  assert.equal(f.tree.workspace(project.id, node, 'write'), f.tree.workspace(project.id, node));
  assert.equal(execFileSync('git',['-C',f.tree.workspace(project.id,node),'show',`${(await checkpoint).commit}:published.txt`],{encoding:'utf8'}),'published bytes');
});
