import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {temporaryDirectory} from '../tests/fixtures/storage.ts';

/** Verify only declared source and lockfile in a fresh directory, without copying credentials or runtime state.
 * npm first uses the existing local package cache; network fallback requires an explicit flag.
 * Each command gets a small environment allowlist, and evidence replaces local paths before persistence.
 */
const source = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const campaign = args.includes('--campaign') ? args[args.indexOf('--campaign') + 1] : undefined;
const allowNetworkInstall = args.includes('--allow-network-install');
const campaigns=['adr006','adr007','adr008','adr009','adr010','adr011','adr011-packages','adr011-resilience','adr012','adr014','adr015','adr016','adr017'];
assert.ok(campaign === undefined || campaigns.includes(campaign), 'Unknown verification campaign');
assert.ok(args.every((arg, index) => arg === '--allow-network-install' || arg === '--campaign' || (campaigns.includes(arg) && args[index - 1] === '--campaign')), 'Unknown portability option');
const evidence = join(source, 'docs/evidence', ...(campaign ? [campaign] : []));
await mkdir(evidence, { recursive: true });
const isolated = await temporaryDirectory('polariton-portability-');
const excluded = new Set(['.local', '.cache', 'node_modules', 'dist', '.git', '.env']);
const scrub = text => text.replaceAll(isolated, '<ISOLATED_V5>').replaceAll(source.replace(/\/$/, ''), '<V5>').replaceAll(homedir(), '<HOME>');
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.POLARITON_DATA_DIR = join(isolated, '.local/data');
env.DSH_HOME = join(isolated, '.local/harness');
env.npm_config_logs_dir = join(isolated, '.cache/npm-logs');
env.npm_config_cache = join(source, '.cache/npm');
env.npm_config_userconfig = join(isolated, '.cache/no-user-npmrc');
env.npm_config_globalconfig = join(isolated, '.cache/no-global-npmrc');
env.GIT_CONFIG_GLOBAL = '/dev/null'; env.GIT_CONFIG_SYSTEM = '/dev/null';
const result = { recordedAt: new Date().toISOString(), campaign: campaign ?? 'first-build', platform: process.platform, architecture: process.arch, node: process.version, mode: 'npm ci --offline using existing V5 .cache/npm; no provider calls', networkInstallAllowed: allowNetworkInstall, excluded: [...excluded, '.env.*', 'docs/evidence'], sourceFiles: 0, sourceSha256: '', commands: [], passed: false };
const sourceHash = createHash('sha256');
async function hashFiles(root) {
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await hashFiles(path);
    else if (entry.isFile()) { sourceHash.update(relative(isolated, path)); sourceHash.update(await readFile(path)); result.sourceFiles++; }
    else throw new Error('Portable source must contain only directories and regular files');
  }
}
async function run(label, command, args, required = true) {
  console.log(`Portability: ${label}`);
  const child = spawn(command, args, { cwd: isolated, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const log = `portability-${label}.log`;
  await writeFile(join(evidence, log), scrub(output));
  result.commands.push({ label, command: [command === process.execPath ? 'node' : command, ...args], exitCode: code, log });
  if (required) assert.equal(code, 0, `${label} failed; see ${relative(source, evidence)}/${log}`);
  return code;
}
try {
  const include = path => {
    const name = basename(path), rel = relative(source, path);
    return !excluded.has(name) && !name.startsWith('.env.') && rel !== 'docs/evidence';
  };
  for (const entry of await readdir(source)) {
    const path = join(source, entry);
    if (include(path)) await cp(path, join(isolated, entry), { recursive: true, filter: include });
  }
  await hashFiles(isolated); result.sourceSha256 = sourceHash.digest('hex');
  const installed = await run('install-offline', 'npm', ['ci', '--offline', '--no-audit', '--no-fund'], false);
  if (installed !== 0) {
    assert.ok(allowNetworkInstall, 'Offline locked install failed; inspect its log, then explicitly authorize --allow-network-install if a cache miss needs network access');
    result.mode = 'npm ci using npm registry after recorded offline attempt; no provider calls';
    await run('install-network', 'npm', ['ci', '--no-audit', '--no-fund']);
  }
  await run('build', 'npm', ['run', 'build']);
  await run('install-executable', 'npm', ['install', '--prefix', '.local/consumer', '--offline', '--no-audit', '--no-fund', isolated]);
  await run('external-executable', process.execPath, ['--input-type=module', '-e', `import {execFileSync} from 'node:child_process';import {join} from 'node:path';import assert from 'node:assert/strict';const result=JSON.parse(execFileSync(join(process.cwd(),'.local/consumer/node_modules/.bin/harnessctl'),['--version'],{cwd:'/tmp',encoding:'utf8'}));assert.deepEqual(result.contracts,[1]);console.log(JSON.stringify(result));`]);
  if(process.platform==='darwin')await run('native-picker-probe', join(isolated,'dist/native/Polariton Folder Picker.app/Contents/MacOS/picker'), ['--probe']);
  await run('tests', 'npm', ['test']);
  await mkdir(join(isolated, '.local'), { recursive: true });
  await writeFile(join(isolated, '.local/startup-smoke.mjs'), `
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../src/main.ts';
import { loadConfig } from '../src/config.ts';
const config = { ...await loadConfig(), verification: false, stateRoot: join(process.cwd(), '.local/startup-state') };
await mkdir(config.stateRoot, { recursive: true });
const runtime = await createApp(config, () => { throw new Error('Smoke must never activate a model harness'); });
try {
  await runtime.app.ready();
  const host = '127.0.0.1:' + config.port, origin = 'http://' + host;
  const read = (url, headers = {}) => runtime.app.inject({ method:'GET', url, headers:{host,...headers} });
  assert.equal((await read('/')).statusCode, 200);
  assert.equal((await read('/api/projects')).statusCode, 401);
  const token = new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
  const login = await runtime.app.inject({ method:'POST', url:'/api/bootstrap', headers:{host,origin}, payload:{token} });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const projects = await read('/api/projects', {cookie});
  assert.equal(projects.statusCode, 200); assert.deepEqual(projects.json(), []);
  console.log('Built UI 200; unauthenticated API 401; one-use bootstrap 200; authenticated projects 200; no harness activation.');
} finally { await runtime.app.close(); }
`);
  await run('startup', process.execPath, ['.local/startup-smoke.mjs']);
  result.passed = true;
} catch (error) {
  result.error = scrub(String(error)); process.exitCode = 1;
} finally {
  await writeFile(join(evidence, 'portability.json'), JSON.stringify(result, null, 2) + '\n');
  await rm(isolated, { recursive: true, force: true });
  console.log(`Portability: ${result.passed ? 'passed' : 'failed'}; scrubbed evidence in ${relative(source, evidence)}/portability.json`);
}
