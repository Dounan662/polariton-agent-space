import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));

// Exercise the executable against disposable source trees, including metadata
// exclusions and rejected publication inputs. No user files or Git state are used.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'polariton-public-source-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'scripts'));
  await copyFile(join(source, 'scripts/check-public.mjs'), join(root, 'scripts/check-public.mjs'));
  await mkdir(join(root, 'node_modules'));
  await symlink(join(source, 'node_modules/mdast-util-from-markdown'), join(root, 'node_modules/mdast-util-from-markdown'));
  return root;
}
function inspect(root) {
  const result = spawnSync(process.execPath, ['scripts/check-public.mjs'], {cwd: root, encoding: 'utf8'});
  assert.ifError(result.error);
  return {status: result.status, output: result.stdout + result.stderr};
}

test('public check accepts Finder metadata and root Trunk state without following its cache links', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.trunk'));
  await mkdir(join(root, 'src'));
  for (const path of ['.DS_Store', 'src/.DS_Store', '.trunk/.DS_Store']) await writeFile(join(root, path), 'Finder metadata');
  await symlink(join(root, 'absent-cache'), join(root, '.trunk/tools'));
  await writeFile(join(root, '.trunk/trunk.yaml'), 'local tooling configuration');
  const result = inspect(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Public source checks passed/);
});

for (const [path, content, diagnostic] of [
  ['.env', 'PRIVATE_FIXTURE', /private or machine-local file/],
  ['src/.npmrc', 'PRIVATE_FIXTURE', /private or machine-local file/],
  ['src/ignored.txt', 'sk-' + 'x'.repeat(40), /possible credential/],
  ['src/location.txt', ['', 'Users', 'example', 'project'].join('/'), /private machine path/],
  ['src/.trunk/credential.txt', 'sk-' + 'x'.repeat(40), /possible credential/],
  ['README.md', '[Missing](missing.md)', /missing link/],
  ['README.md', '[Outside](..\/outside.md)', /link leaves repository/],
]) test(`public check rejects ${path}: ${diagnostic.source}`, async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'src/.trunk'), {recursive: true});
  await writeFile(join(root, '.gitignore'), 'src/ignored.txt\n');
  await writeFile(join(root, path), content);
  const result = inspect(root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, diagnostic);
});

for (const path of ['source-link', '.DS_Store', '.trunk']) test(`public check rejects symlinks even with excluded names: ${path}`, async t => {
  const root = await fixture(t);
  await symlink(join(root, 'absent-target'), join(root, path));
  const result = inspect(root);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /source symlink/);
});
