import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import * as tar from 'tar';
import {z} from 'zod';
import {inspectRelease} from '../src/deployment.ts';

// Verify the deliverable using a fresh dependency installation outside the source
// tree. The shared deployment deadline bounds all commands; failures kill the
// owned command group before removing temporary files. No service install occurs.
const [argument, ...extra] = process.argv.slice(2);
if (!argument || extra.length) throw new Error('Usage: node scripts/verify-archive.mjs ARCHIVE.tar.gz');
const archive = resolve(argument), name = basename(archive, '.tar.gz');
if (!/^polariton-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(name)) throw new Error('Expected a versioned Polariton source archive');
const limits = z.object({installTimeoutMs: z.number().int().positive()}).parse(JSON.parse(await readFile(new URL('../config/deployment.json', import.meta.url), 'utf8')));
const deadline = Date.now() + limits.installTimeoutMs;
const invalid = [];
await tar.t({file: archive, onReadEntry(entry) {
  const path = entry.path.replace(/\/$/, '');
  if (!(path === name || path.startsWith(name + '/')) || path.split('/').includes('..') || path.includes('\\') || !['File', 'Directory', 'OldFile'].includes(entry.type)) invalid.push(entry.path);
}});
if (invalid.length) throw new Error('Archive has unsafe paths or nonregular entries');
const temporary = await mkdtemp(join(tmpdir(), 'polariton-archive-'));
try {
  await tar.x({file: archive, cwd: temporary, strict: true});
  const source = join(temporary, name);
  await inspectRelease(source);
  // Credentials and provider overrides are never inherited by verification.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.npm_config_userconfig = join(temporary, 'no-user-npmrc');
  env.npm_config_globalconfig = join(temporary, 'no-global-npmrc');
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  if (process.env.npm_config_cache) env.npm_config_cache = resolve(process.env.npm_config_cache);
  if (process.env.npm_config_offline === 'true') env.npm_config_offline = 'true';
  for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'check:public'], ['run', 'build'], ['test'], ['run', 'smoke']]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Archive verification exceeded the deployment deadline');
    console.log(`Archive verification: npm ${args.join(' ')}`);
    await new Promise((accept, reject) => {
      const child = spawn('npm', args, {cwd: source, env, detached: true, stdio: 'inherit'});
      let stopped, killError;
      const stop = reason => {
        stopped ??= reason;
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') killError = error; }
      };
      const interrupt = () => stop('interrupted');
      const terminate = () => stop('terminated');
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      const timer = setTimeout(() => stop('deadline exceeded'), remaining);
      const settled = () => {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
      };
      child.once('error', error => { settled(); reject(error); });
      child.once('close', (code, signal) => {
        settled();
        if (killError) reject(new Error('Could not terminate archive verification command group', {cause: killError}));
        else if (stopped || code !== 0) reject(new Error(`Archive verification failed: npm ${args.join(' ')} (${stopped ?? signal ?? code})`));
        else accept();
      });
    });
  }
  console.log('Independent archive installation, source checks, build, tests, and startup smoke passed.');
} finally { await rm(temporary, {recursive: true, force: true}); }
