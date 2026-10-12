import {testDeadline} from './fixtures/timing.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {configureTestProviders} from './fixtures/providers.ts';

/** A real owner process with a controlled neighboring harness makes the death boundary exact. */
test('Main process death preserves uncertain work and never replays it through retry or history reads', {timeout: testDeadline(30000)}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr012-crash-')));
  const environment = join(root, 'environment.json'), configPath = join(root, 'app.json');
  await writeFile(environment, JSON.stringify(RackConfig.parse({stateRoot: join(root, 'rack'), socketPath: join(root, 'environment.sock')})));
  await writeFile(configPath, JSON.stringify({...await loadConfig(), configPath, stateRoot: join(root, 'main'), environmentConfig: environment, verification: false}));
  await configureTestProviders(await loadConfig(configPath));
  const env = {...process.env};
  for (const name of ['HARNESSCTL_TOKEN', 'HARNESSCTL_CONFIG', 'DSH_HARNESSCTL_TOKEN', 'DSH_SHELL']) delete env[name];
  const executable = fileURLToPath(new URL('../bin/harnessctl', import.meta.url));
  const script = `
    import {createApp} from ${JSON.stringify(new URL('../src/main.ts', import.meta.url).href)};
    import {loadConfig} from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
    import {ControlledHarness} from ${JSON.stringify(new URL('./fixtures/harness.ts', import.meta.url).href)};
    import {basename} from 'node:path';
    const app = await createApp(await loadConfig(process.argv[1]), (config, home, workspace, budget, permission) => {
      process.stdout.write('activated\\n');
      const harness = new ControlledHarness('session-' + basename(home), permission, config.model);
      harness.promptEntered.promise.then(() => process.stdout.write('prompt\\n'));
      return harness;
    });
    process.stdout.write('ready\\n');
    process.once('SIGTERM', () => void app.app.close());
  `;
  const owners = [];
  t.after(async () => {
    for (const owner of owners) if (owner.child.exitCode === null && owner.child.signalCode === null) { owner.child.kill('SIGKILL'); await owner.closed; }
    await rm(root, {recursive: true, force: true});
  });
  async function start() {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, configPath], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const ready = Promise.withResolvers(), prompt = Promise.withResolvers();
    const owner = {child, output: '', errors: '', closed: new Promise(resolve => child.once('close', resolve)), prompt: prompt.promise};
    owners.push(owner);
    child.once('error', ready.reject); child.once('exit', () => ready.reject(new Error(owner.errors)));
    child.stderr.on('data', chunk => owner.errors += chunk);
    child.stdout.on('data', chunk => { owner.output += chunk; if (owner.output.includes('ready\n')) ready.resolve(); if (owner.output.includes('prompt\n')) prompt.resolve(); });
    await ready.promise; return owner;
  }
  async function cli(args) {
    const child = spawn(process.execPath, [executable, '--config', configPath, ...args], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return {code, ...JSON.parse(output)};
  }
  const first = await start(), createId = randomUUID();
  const createArgs = ['project', 'create', '--name', 'Crash recovery', '--root', join(root, 'research'), '--request-id', createId];
  const created = await cli(createArgs), project = created.data.result, id = randomUUID();
  const sendArgs = ['worker', 'send', project.initialWorkerId, '--details', '--text', 'Unsettled work', '--request-id', id];
  const admitted = await cli(sendArgs);
  assert.equal(admitted.code, 0); await first.prompt;
  first.child.kill('SIGKILL'); await first.closed;
  const restarted = await start();
  const state = (await cli(['worker', 'get', project.initialWorkerId])).data;
  assert.equal(state.state, 'uncertain'); assert.equal(state.submissions.length, 1); assert.equal(state.submissions[0].state, 'uncertain');
  const receipt = await cli(['operation', 'get', `main:worker:${id}`, '--details']);
  assert.equal(receipt.code, 0); assert.equal(receipt.data.state, 'succeeded');
  assert.deepEqual(receipt.data.attempts, admitted.data.attempts);
  assert.equal(receipt.data.result.state, 'uncertain');
  const repeated = await cli(sendArgs);
  assert.equal(repeated.code, 0); assert.equal(repeated.data.result.state, 'uncertain', 'Same request cannot replay an uncertain message');
  assert.notEqual((await cli(['worker', 'history', project.initialWorkerId])).code, 0, 'Absent fake harness history remains explicitly absent');
  const duplicate = await cli(createArgs);
  assert.equal(duplicate.data.result.id, project.id); assert.equal(duplicate.data.result.initialWorkerId, project.initialWorkerId);
  assert.equal((await cli(['project', 'list'])).data.items.length, 1);
  assert(!restarted.output.includes('activated'), 'Neither restart, receipt lookup, duplicate send nor history activates execution');
  restarted.child.kill('SIGTERM'); await restarted.closed;
});
