import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { Harness } from '../harness/client.ts';
import {GuardianSettings} from '../harness/settings.ts';
import { Config, loadConfig } from '../src/config.ts';

/** Exercise OS spawn failure without launching DSH or handing any credentials to a child. */
test('failed process spawn is observable, rejects startup, and allows repeated close', { timeout: 10000 }, async t => {
  const root = await temporaryDirectory('test-harness-');
  const failures = [], exits = [];
  const config = { ...await loadConfig(), verification: false };
  const harness = new Harness(config, join(root, 'home'), join(root, 'missing-workspace'), async () => {
    assert.fail('An unspawned process must not request a model budget');
  });
  harness.on('transportError', error => failures.push(error));
  harness.on('exit', event => exits.push(event));
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  await harness.close();
  await assert.rejects(harness.start(), {code:'HARNESS_SPAWN_FAILED'});
  assert.ok(failures.some(error => error.code === 'HARNESS_SPAWN_FAILED'));
  await harness.close(); await harness.close();
  assert.equal(exits.length, 1, 'failed spawn produces one terminal lifecycle notification');
});

test('startup filesystem failure never requests a provider and close remains safe', async t => {
  const root = await temporaryDirectory('test-harness-');
  const home = join(root, 'home-is-file');
  await writeFile(home, 'existing user data');
  const harness = new Harness({ ...await loadConfig(), verification: false }, home, root, async () => assert.fail('No provider before startup'));
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(harness.start(), error => error.code === 'EEXIST');
  await harness.close();
});

/** Invalid nested deadlines would discard the only native cleanup authority. */
test('native settlement budgets fit inside guardian and daemon shutdown',async()=>{
  const config=await loadConfig(),limits=config.guardian;
  assert.throws(()=>GuardianSettings.parse({...limits,nativeDrainTimeoutMs:limits.requestTimeoutMs}),/must fit within/);
  assert.throws(()=>Config.parse({...config,shutdownTimeoutMs:limits.requestTimeoutMs}),/must fit within/);
  assert.equal(Config.parse(config).guardian.nativeDrainTimeoutMs,limits.nativeDrainTimeoutMs);
});
