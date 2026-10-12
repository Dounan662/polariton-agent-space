import {testDeadline} from './fixtures/timing.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
import {constants, openSync, closeSync} from 'node:fs';
import {createServer} from 'node:http';
import {access, appendFile, mkdir, mkdtemp, realpath, rm, writeFile, readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {createApp} from '../src/main.ts';
import {createEnvironmentDaemon} from '../src/environment/daemon.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {applicationSocket} from '../src/cli/server.ts';
import {exitCode} from '../src/cli/client.ts';
import {commands} from '../src/cli/contracts.ts';
import {socketRequest} from '../src/environment/daemon.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import {persistMedia} from './fixtures/media.mjs';
import {configureTestProviders} from './fixtures/providers.ts';

const executable = fileURLToPath(new URL('../bin/harnessctl', import.meta.url));

/** Invoke the installed executable with closed stdin and an unrelated working directory. */
async function fixture(t, {main = true, environment = false, receiptDetails = true, configOverrides = {}, harnessFactory = () => { throw new Error('Read and provisioning tests must not activate a harness'); }} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr012-cli-')));
  const rackPath = join(root, 'environment.json');
  const rackConfig = RackConfig.parse({stateRoot: join(root, 'rack'), socketPath: join(root, 'environment.sock')});
  await writeFile(rackPath, JSON.stringify(rackConfig));
  const configPath = join(root, 'application.json');
  const config = {...await loadConfig(), stateRoot: join(root, 'main'), configPath, environmentConfig: rackPath, verification: false, maxBodyBytes: 4096, ...configOverrides};
  await writeFile(configPath, JSON.stringify(config));
  if(main)await configureTestProviders(config);
  let runtime = main ? await createApp(config, harnessFactory) : null;
  const peer = environment ? await createEnvironmentDaemon(rackConfig) : null;
  t.after(async () => { await runtime?.app.close(); await peer?.app.close(); await rm(root, {recursive: true, force: true}); });
  function spawnCli(args, overrides = {}) {
    // Owner-contract cases request full evidence; presentation cases opt into the compact default.
    const command = args.slice(0, 2).join('.');
    if (receiptDetails && (commands[command]?.mutation || command === 'operation.get') && !args.includes('--help') && !args.includes('--details')) args = [...args, '--details'];
    const env = {...process.env};
    for (const name of ['HARNESSCTL_TOKEN', 'HARNESSCTL_CONFIG', 'DSH_HARNESSCTL_TOKEN', 'DSH_SHELL']) delete env[name];
    return spawn(process.execPath, [executable, '--config', configPath, ...args], {cwd: root, env: {...env, ...overrides}, stdio: ['pipe', 'pipe', 'pipe']});
  }
  async function cli(args, stdin = '', overrides = {}) {
    const child = spawnCli(args, overrides);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
    child.stdin.end(stdin);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert(stdout.trim(), `CLI exited without a structured response (code=${code}, signal=${child.signalCode}): ${stderr}`);
    const records = args.includes('--follow') ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [JSON.parse(stdout)];
    if (!args.includes('--follow')) assert.equal(records.length, 1, `Expected one machine result: ${stdout}`);
    return {code, value: records.at(-1), records, stdout, stderr};
  }
  return {root, config, configPath, cli, spawnCli, peer,
    /** Admission does not await delivery. Observe durable owner state through its
     * public change boundary before asserting asynchronous effects via the CLI. */
    workerWhen(id,ready){
      const agents=runtime.agents;
      return new Promise((resolve,reject)=>{
        const cleanup=()=>{agents.off('change',changed);t.signal.removeEventListener('abort',aborted);};
        const aborted=()=>{cleanup();reject(t.signal.reason);};
        const changed=()=>{try{const worker=agents.get(id);if(ready(worker)){cleanup();resolve(worker);}}catch(error){cleanup();reject(error);}};
        agents.on('change',changed);t.signal.addEventListener('abort',aborted,{once:true});
        if(t.signal.aborted)aborted();else changed();
      });
    },
    async reopen() { await runtime.app.close(); runtime = await createApp(config, () => { throw new Error('Recovery read activated a harness'); }); },
  };
}

test('capture contention and failure remain distinct from observer timeouts', () => {
  for (const code of ['CHECKPOINT_BUSY','WORKSPACE_CHANGED']) assert.equal(exitCode({state:'failed',error:{code}}),3);
  for (const code of ['CAPTURE_TIMEOUT','CAPTURE_CANCELLED']) assert.equal(exitCode({state:'failed',error:{code}}),6);
  assert.equal(exitCode({error:{code:'OBSERVER_TIMEOUT'}}),8);
});

test('executable discovery, grammar and authentication failures are structured and noninteractive', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t);
  const help = await f.cli(['worker', 'send', '--help', '--schema', '--json']);
  assert.equal(help.code, 0); assert(help.value.commands['worker.send'].input);
  assert(help.value.commands['worker.send'].output);
  for (const schema of ['envelope', 'receipt', 'error', 'follow']) assert(help.value.responses[schema]);
  const missing = await f.cli(['project', 'create', '--name', 'No identity', '--root', join(f.root, 'rejected')]);
  assert.equal(missing.code, 2); assert.equal(missing.value.error.code, 'INVALID_INPUT');
  const invalid = await f.cli(['project', 'list', '--unexpected', 'secret-sentinel']);
  assert.equal(invalid.code, 2); assert(!invalid.stdout.includes('secret-sentinel'));
  const denied = await f.cli(['project', 'list'], '', {HARNESSCTL_TOKEN: 'invalid-worker-token'});
  assert.equal(denied.code, 4); assert.equal(denied.value.error.code, 'AUTH_REQUIRED');
  for (const command of [['project', 'list'], ['daemon', 'status', 'main']]) {
    const missingGrant = await f.cli(command, '', {DSH_SHELL: 'bash'});
    assert.equal(missingGrant.code, 4, missingGrant.stdout); assert.equal(missingGrant.value.error.code, 'AUTH_REQUIRED');
  }
  const callerToken = JSON.parse(await readFile(join(f.config.stateRoot, 'application-admin.json'), 'utf8')).token;
  await assert.rejects(socketRequest(applicationSocket(f.config.stateRoot), callerToken, '/v1/execute', {version: 1, actor: {kind: 'owner', id: 'local-owner'}, command: {kind: 'project.list', input: {}}}, f.config.requestTimeoutMs, f.config.maxBodyBytes), {code: 'INVALID_INPUT'});
  assert.deepEqual((await f.cli(['project', 'list'])).value.data.items, []);
});

test('workspace package registration resolves paths at the CLI and retries the same source identity', async t => {
  const f = await fixture(t, {main:false, environment:true});
  const repository=join(f.root,'workspace'),directory=join(repository,'capabilities','analysis');
  await mkdir(directory,{recursive:true});execFileSync('git',['init','--quiet',repository]);
  const id=randomUUID();
  const first=await f.cli(['capability','register','--repository','workspace/capabilities/analysis','--request-id',id]);
  assert.equal(first.code,0,first.stdout);
  assert.deepEqual(first.value.data.result.source,{repository,subdirectory:'capabilities/analysis'});
  const retry=await f.cli(['capability','register','--input','-','--request-id',id],JSON.stringify({repository:directory}));
  assert.equal(retry.code,0,retry.stdout);assert.deepEqual(retry.value.data,first.value.data);
  assert.deepEqual((await f.peer.rack.inventory()).releases,[],'Registration prepares no runtime or release');
});

test('FIFO image inputs reject before worker admission and leave unrelated owner reads responsive', {timeout: testDeadline(15000), skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t, {configOverrides: {requestTimeoutMs: 1000, mcpStartupTimeoutMs: 100, mcpCleanupTimeoutMs: 100}});
  const created = await f.cli(['project', 'create', '--name', 'Regular image files', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  assert.equal(created.code, 0, created.stdout);
  const project = created.value.data.result;
  const fifo = join(f.root, 'not-an-image.png');
  execFileSync('mkfifo', [fifo]);
  const structured = await f.cli(['project', 'create', '--request-id', randomUUID(), '--input', fifo]);
  assert.equal(structured.code, 2, structured.stdout);
  assert.equal(structured.value.error.code, 'INVALID_INPUT');
  // Release a blocked pre-fix open even if an assertion fails, so the regression cannot strand the test runner.
  try {
    const results = await Promise.all(Array.from({length: 4}, () => f.cli(['worker', 'send', project.initialWorkerId, '--request-id', randomUUID(), '--input', '-'], JSON.stringify({content: [{type: 'image', path: fifo, mediaType: 'image/png'}]}))));
    for (const result of results) {
      assert.equal(result.code, 2, result.stdout);
      assert.equal(result.value.error.code, 'INVALID_IMAGE');
    }
    assert.equal((await f.cli(['project', 'list'])).value.data.items.length, 1);
    const worker = (await f.cli(['worker', 'get', project.initialWorkerId])).value.data;
    assert.equal(worker.state, 'inactive');
    assert.deepEqual(worker.submissions, []);
  } finally { closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)); }
});

test('concurrent text stdin reports preserve literal payloads and one delivery per retained identity', {timeout: testDeadline(30000)}, async t => {
  const construction = Promise.withResolvers();
  const f = await fixture(t, {harnessFactory: (config, home, _workspace, _budget, permission) => {
    const harness = new ControlledHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model); if(config.workerIdentity)construction.resolve(harness); return harness;
  }});
  const help = await f.cli(['worker', 'send', '--help', '--schema', '--json']);
  assert.match(help.value.global.textStdin, /--text-stdin/);
  const project = (await f.cli(['project', 'create', '--name', 'Independent reports', '--root', join(f.root, 'research'), '--request-id', randomUUID()])).value.data.result;
  const worker = project.initialWorkerId;
  await f.cli(['worker', 'send', worker, '--text', 'Keep the main turn active', '--request-id', randomUUID()]);
  const harness = await construction.promise;
  await harness.promptEntered.promise;
  const reports = ['Report A: "quoted" \\ path\n$(do not execute) `literal`\n', 'Report B: β results\nsecond line\n', '\uFEFFReport C: retain BOM and trailing space \n'].map(text => ({text, id: randomUUID()}));
  const send = report => f.cli(['worker', 'send', worker, '--text-stdin', '--request-id', report.id], report.text);
  const results = await Promise.all(reports.map(send));
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.data.state, 'succeeded');
    assert.equal(result.value.data.attempts.at(-1).state, 'succeeded');
    assert(['pending', 'admitted', 'applied'].includes(result.value.data.result.state));
    assert.equal(result.value.data.result.kind, 'message');
    assert.equal(result.value.data.result.text, reports[index].text);
  }
  const calls = () => harness.calls.filter(call => call.method === 'message' && reports.some(report => report.id === call.params.requestId)).map(call => call.params.content.filter(part => part.type === 'text').map(part => part.text).join(''));
  await f.workerWhen(worker,view=>reports.every(report=>view.submissions.some(value=>value.id===report.id&&value.state==='admitted')));
  assert.deepEqual(calls().sort(), reports.map(report => report.text).sort());
  assert.equal((await send(reports[0])).code, 0);
  assert.equal(calls().length, reports.length, 'Repeating an accepted identity cannot send another report');
  const conflict = await send({...reports[0], text: 'Changed report'});
  assert.equal(conflict.code, 3, conflict.stdout);
  assert.equal(calls().length, reports.length);
  for (const mode of ['auto', 'prompt', 'steer']) {
    const rejected = await f.cli(['worker', 'send', worker, '--mode', mode, '--text-stdin'], 'Unsupported routing');
    assert.equal(rejected.code, 2, rejected.stdout);
    assert.equal(rejected.value.error.code, 'INVALID_INPUT');
  }
  const rejectedJson = await f.cli(['worker', 'send', worker, '--input', '-'], JSON.stringify({mode: 'auto', text: 'Unsupported routing'}));
  assert.equal(rejectedJson.code, 2);
  assert.equal(calls().length, reports.length, 'Removed mode inputs must reject before admission');
  harness.complete();
});

test('text stdin rejects ambiguous, empty, oversized and malformed inputs before dispatch', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t);
  const project = (await f.cli(['project', 'create', '--name', 'Rejected input', '--root', join(f.root, 'research'), '--request-id', randomUUID()])).value.data.result;
  const args = ['worker', 'send', project.initialWorkerId, '--text-stdin', '--request-id', randomUUID()];
  const file = join(f.root, 'input.json');
  await writeFile(file, JSON.stringify({text: 'Already supplied'}));
  for (const [flags, stdin] of [
    [['--text', 'Duplicate'], 'ignored'], [['--input', '-'], '{}'], [['--input', file], 'ignored'],
    [[], ' \n'], [[], 'x'.repeat(f.config.maxBodyBytes + 1)], [[], Buffer.from([0xc3, 0x28])],
  ]) {
    const rejected = await f.cli([...args, ...flags], stdin);
    assert.notEqual(rejected.code, 0, rejected.stdout);
    assert.match(rejected.value.error.code, /INPUT/);
  }
  const wrongCommand = await f.cli(['worker', 'get', project.initialWorkerId, '--text-stdin'], 'ignored');
  assert.equal(wrongCommand.code, 2, wrongCommand.stdout);
  assert.deepEqual((await f.cli(['worker', 'get', project.initialWorkerId])).value.data.submissions, []);
});

test('default send identities are distinct and wait ends at command admission while the recipient remains active', {timeout: testDeadline(30000)}, async t => {
  const created = Promise.withResolvers();
  const f = await fixture(t, {harnessFactory: (config, home, _workspace, _budget, permission) => {
    const harness = new ControlledHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model);
    if(config.workerIdentity)created.resolve(harness); return harness;
  }});
  const project = (await f.cli(['project', 'create', '--name', 'Independent admission', '--root', join(f.root, 'research'), '--request-id', randomUUID()])).value.data.result;
  const worker = project.initialWorkerId;
  // Harness completion is held until the assertions finish. A successful wait
  // while that worker remains running proves admission semantics independently
  // of the host's storage latency; the test deadline bounds a stuck observer.
  const args = ['worker', 'send', worker, '--text', 'Continue independently', '--wait'];
  const first = await f.cli(args);
  assert.equal(first.code, 0, first.stdout); assert.equal(first.value.data.state, 'succeeded');
  // Admission may finish before asynchronous worker construction has begun.
  const harness = await created.promise;
  await harness.promptEntered.promise;
  const second = await f.cli(args);
  assert.equal(second.code, 0, second.stdout); assert.equal(second.value.data.state, 'succeeded');
  await f.workerWhen(worker,view=>view.submissions.some(value=>value.id===second.value.data.requestId&&value.state==='admitted'));
  assert.notEqual(first.value.data.requestId, second.value.data.requestId);
  for (const sent of [first, second]) {
    const recovery = JSON.parse(sent.stderr.split('\n').find(line => line.startsWith('{')));
    assert.equal(recovery.operation, sent.value.data.reference);
    assert.equal(recovery.requestId, sent.value.data.requestId);
    assert.equal(recovery.kind, 'recovery');
    const retained = (await f.cli(['operation', 'get', recovery.operation, '--wait'])).value.data;
    assert.equal(retained.state, 'succeeded');
    assert.deepEqual(retained.attempts, sent.value.data.attempts);
  }
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  const observer = f.spawnCli(['worker', 'get', worker, '--follow', '--timeout', '10s']); observer.stdin.end(); observer.stderr.resume();
  const observerExit = new Promise(resolve => observer.once('close', resolve));
  t.after(() => { if (observer.exitCode === null) observer.kill('SIGKILL'); });
  await new Promise(resolve => observer.stdout.once('data', resolve));
  observer.kill('SIGTERM'); await observerExit;
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  const duplicate = await f.cli([...args, '--request-id', first.value.data.requestId]);
  assert.equal(duplicate.value.data.result.id, first.value.data.requestId);
  assert.equal(harness.calls.filter(call => call.method === 'message').length, 2);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.submissions.length, 2);
  harness.complete();
  const settled = (await f.cli(['operation', 'get', first.value.data.reference])).value.data;
  assert.equal(settled.result.state, 'applied');
  assert.equal(settled.state, first.value.data.state);
  assert.deepEqual(settled.attempts, first.value.data.attempts);
});

test('generated recovery identity is observable before a lost response and accompanies uncertainty', {timeout: testDeadline(15000)}, async t => {
  const f = await fixture(t, {main: false});
  await mkdir(f.config.stateRoot, {recursive: true});
  await writeFile(join(f.config.stateRoot, 'application-admin.json'), JSON.stringify({token: 'test-owner'}));
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.resolve(JSON.parse(Buffer.concat(chunks).toString()));
    await release.promise;
    response.end('incomplete owner response');
  });
  await new Promise(resolve => server.listen(applicationSocket(f.config.stateRoot), resolve));
  t.after(async () => { release.resolve(); await new Promise(resolve => server.close(resolve)); });
  const child = f.spawnCli(['worker', 'send', randomUUID(), '--text', 'Retain this identity']); child.stdin.end();
  let stderr = '', stdout = ''; const diagnostic = Promise.withResolvers();
  child.stderr.on('data', chunk => { stderr += chunk; const record = stderr.split('\n').find(line => line.startsWith('{') && line.endsWith('}')); if (record) diagnostic.resolve(JSON.parse(record)); });
  child.stdout.on('data', chunk => stdout += chunk);
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [request, recovery] = await Promise.all([received.promise, diagnostic.promise]);
  assert.equal(stdout, '', 'Recovery identity is available while owner response is still pending');
  assert.equal(recovery.requestId, request.requestId);
  assert.equal(recovery.operation, `main:worker:${request.requestId}`);
  release.resolve();
  assert.equal(await closed, 7);
  const result = JSON.parse(stdout);
  assert.equal(result.error.code, 'EXECUTION_UNCERTAIN');
  assert.equal(result.error.operation, recovery.operation);
});

test('configured follow event bounds fail observably without cancelling the worker', {timeout: testDeadline(30000)}, async t => {
  const construction = Promise.withResolvers();
  const f = await fixture(t, {configOverrides: {maxObservationEvents: 1, cliPollMs: 20}, harnessFactory: (config, home, _workspace, _budget, permission) => {
    const harness = new ControlledHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model); if(config.workerIdentity)construction.resolve(harness); return harness;
  }});
  const project = (await f.cli(['project', 'create', '--name', 'Bounded observer', '--root', join(f.root, 'research'), '--request-id', randomUUID()])).value.data.result;
  const worker = project.initialWorkerId;
  await f.cli(['worker', 'send', worker, '--text', 'Stay active', '--request-id', randomUUID()]);
  const harness = await construction.promise;
  await harness.promptEntered.promise;
  const observed = await f.cli(['worker', 'get', worker, '--follow', '--timeout', '2s']);
  assert.equal(observed.code, 3, observed.stdout); assert.equal(observed.value.error.code, 'STREAM_LIMIT');
  assert.equal(observed.records.filter(record => record.kind === 'snapshot').length, 1);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  harness.complete();
});

test('blocked follow consumers reach their deadline while unrelated owner reads remain responsive', {timeout: testDeadline(15000)}, async t => {
  const construction = Promise.withResolvers();
  const f = await fixture(t, {configOverrides: {cliPollMs: 20, maxFrameBytes: 4 * 1024 * 1024}, harnessFactory: (config, home, _workspace, _budget, permission) => {
    const harness = new ControlledHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model); if(config.workerIdentity)construction.resolve(harness); return harness;
  }});
  const project = (await f.cli(['project', 'create', '--name', 'Slow consumer', '--root', join(f.root, 'research'), '--request-id', randomUUID()])).value.data.result;
  const worker = project.initialWorkerId;
  await f.cli(['worker', 'send', worker, '--text', 'Independent execution', '--request-id', randomUUID()]);
  const harness = await construction.promise;
  await harness.promptEntered.promise;
  harness.sourceEvents.push({type: 'qualification/evidence', seq: 0, time: 1000, data: {text: 'x'.repeat(2 * 1024 * 1024)}});
  const observer = f.spawnCli(['worker', 'get', worker, '--follow', '--timeout', '200ms']); observer.stdin.end(); observer.stderr.resume();
  const exited = new Promise(resolve => observer.once('exit', resolve));
  t.after(() => { if (observer.exitCode === null) observer.kill('SIGKILL'); observer.stdout.resume(); });
  // Do not consume stdout: the snapshot is larger than the operating system pipe buffer.
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  assert.equal(await exited, 8);
  observer.stdout.resume();
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  harness.complete();
});

test('oversized mutation responses retain uncertainty and recover the committed effect by request identity', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {configOverrides: {cliMaxStreamBytes: 128, workerOverviewMaxBytes: 128}}), id = randomUUID();
  const args = ['project', 'create', '--name', 'Bounded mutation result', '--root', join(f.root, 'research'), '--request-id', id];
  const result = await f.cli(args);
  assert.equal(result.code, 7, result.stdout); assert.equal(result.value.error.code, 'EXECUTION_UNCERTAIN');
  assert.equal(result.value.error.operation, `main:research:${id}`);
  // The caller raises its configured observation budget; this does not repeat the mutation.
  f.config.cliMaxStreamBytes = 65536;
  await writeFile(f.configPath, JSON.stringify(f.config));
  const retained = await f.cli(['operation', 'get', result.value.error.operation]);
  assert.equal(retained.code, 0, retained.stdout); assert.equal(retained.value.data.state, 'succeeded');
  const duplicate = await f.cli(args);
  assert.deepEqual(duplicate.value.data, retained.value.data);
  assert.equal((await f.cli(['project', 'list'])).value.data.items.length, 1);
});

test('repeating a safe failed send request resumes owner recovery without a duplicate logical input', {timeout: testDeadline(30000)}, async t => {
  let unavailable = true, prompts = 0;
  const harnessFactory = (config, home, _workspace, _budget, permission) => {
    class RecoverableHarness extends ControlledHarness {
      async start() { if (unavailable) throw new Error('Controlled pre-dispatch startup failure'); return super.start(); }
      async message(...args) { const result = await super.message(...args); prompts++; this.complete(); return result; }
    }
    return new RecoverableHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model);
  };
  const f = await fixture(t, {harnessFactory});
  const created = await f.cli(['project', 'create', '--name', 'Retry', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  const worker = created.value.data.result.initialWorkerId;
  const args = ['worker', 'send', worker, '--text', 'Exactly one task', '--request-id', randomUUID(), '--wait'];
  const admitted = await f.cli(args);
  assert.equal(admitted.code, 0, admitted.stdout);
  await f.workerWhen(worker,view=>view.submissions.some(value=>value.id===admitted.value.data.requestId&&value.state==='failed'));
  const failed = await f.cli(['operation', 'get', admitted.value.data.reference]);
  assert.equal(failed.value.data.state, 'succeeded');
  assert.deepEqual(failed.value.data.attempts, admitted.value.data.attempts);
  assert.equal(failed.value.data.result.state, 'failed', failed.stdout); assert.equal(failed.value.data.result.retryable, true); assert.equal(prompts, 0);
  unavailable = false;
  const recovered = await f.cli(args);
  assert.equal(recovered.code, 0, recovered.stdout);
  await f.workerWhen(worker,view=>view.submissions.some(value=>value.id===recovered.value.data.requestId&&value.state==='applied'));
  const applied = await f.cli(['operation', 'get', recovered.value.data.reference]);
  assert.equal(applied.value.data.result.state, 'applied', applied.stdout);
  assert.deepEqual(applied.value.data.attempts, admitted.value.data.attempts);
  assert.equal(prompts, 1);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.submissions.length, 1);
});

test('worker credentials bind attribution, reject sender hints and revoke on close', {timeout: testDeadline(30000)}, async t => {
  const construction = Promise.withResolvers();
  const harnessFactory = (config, home, _workspace, _budget, permission) => {
    class ImmediateHarness extends ControlledHarness {
      async message(...args) { const result = await super.message(...args); this.complete(); return result; }
    }
    const harness=new ImmediateHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model);if(config.workerIdentity)construction.resolve({harness,credential:config.workerCredential,identity:config.workerIdentity});return harness;
  };
  const f = await fixture(t, {harnessFactory, environment: true});
  const created = await f.cli(['project', 'create', '--name', 'Attribution', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  const project = created.value.data.result, worker = project.initialWorkerId;
  assert.equal((await f.cli(['worker', 'send', worker, '--text', 'Initialize credential', '--request-id', randomUUID(), '--wait'])).code, 0);
  const {harness,credential,identity} = await construction.promise;
  await harness.promptEntered.promise;
  assert(credential?.token);
  assert.deepEqual(identity, {projectId:project.id,nodeId:project.mainNodeId,workerId:worker});
  const access = {HARNESSCTL_TOKEN: credential.token, HARNESSCTL_WORKER_ID: randomUUID(), DSH_SESSION_ID: 'forged-context'};
  const selfId=randomUUID(),selfArgs=['worker','send',worker,'--text','Authenticated self report','--request-id',selfId];
  const self=await f.cli(selfArgs,'',access);assert.equal(self.code,0,self.stdout);
  await f.workerWhen(worker,view=>view.submissions.some(value=>value.id===selfId&&value.state==='applied'));
  const view=(await f.cli(['worker','get',worker])).value.data;
  assert.deepEqual(view.submissions.find(value=>value.id===selfId).sender,{id:worker,name:view.title});
  const delivered=harness.calls.find(call=>call.method==='message'&&call.params.requestId===selfId).params.content;
  assert(delivered[0].text.includes(`Worker ID: ${worker}`));assert(!delivered[0].text.includes('Role:'));
  assert.equal(delivered[1].text,'Authenticated self report');
  assert.equal((await f.cli(selfArgs,'',access)).code,0);
  assert.equal(harness.calls.filter(call=>call.method==='message'&&call.params.requestId===selfId).length,1);
  assert.equal((await f.cli(selfArgs)).value.error.code,'REQUEST_CONFLICT');
  const spoofed=await f.cli(['worker','send',worker,'--input','-'],JSON.stringify({text:'Forged sender',sender:{id:worker,name:'Human'}}),access);
  assert.equal(spoofed.code,2,spoofed.stdout);
  const sibling = await f.cli(['worker', 'create', '--node', project.mainNodeId, '--title', 'Created by worker', '--request-id', randomUUID()], '', access);
  assert.equal(sibling.code, 0, sibling.stdout); assert.equal(sibling.value.data.actor.kind, 'worker'); assert.equal(sibling.value.data.actor.id, worker);
  assert.equal(sibling.value.data.result.creation.creator.id,worker);
  const shellAccess = {DSH_SHELL: 'bash', DSH_HARNESSCTL_TOKEN: credential.token, HARNESSCTL_TOKEN: 'ambient-value-must-not-win'};
  const shellCreated = await f.cli(['worker', 'create', '--node', project.mainNodeId, '--title', 'Explicit DSH grant', '--request-id', randomUUID()], '', shellAccess);
  assert.equal(shellCreated.code, 0, shellCreated.stdout); assert.equal(shellCreated.value.data.actor.id, worker);
  const forged = await f.cli(['worker', 'create', '--node', project.mainNodeId, '--title', 'Spoofed', '--sender', randomUUID(), '--request-id', randomUUID()], '', access);
  assert.equal(forged.code, 2);
  const connection = {entries: [{name: 'Actor-bound connection', definition: {kind: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, credentials: {}, requirements: {files: [], identityFiles: [], execution: 'foreground-host'}}}]};
  const importArgs = ['capability', 'import', '--request-id', randomUUID(), '--input', '-'];
  assert.equal((await f.cli(importArgs, JSON.stringify(connection))).code, 0);
  const conflictingActor = await f.cli(importArgs, JSON.stringify(connection), access);
  assert.equal(conflictingActor.code, 3, conflictingActor.stdout); assert.equal(conflictingActor.value.error.code, 'OPERATION_CONFLICT');
  const admin = JSON.parse(await readFile(join(f.root, 'rack', 'admin.json'), 'utf8')).token;
  await assert.rejects(socketRequest(join(f.root, 'environment.sock'), admin, '/v1/cli', {request: {version: 1, command: {kind: 'capability.list', input: {}}}, actor: sibling.value.data.actor}, f.config.requestTimeoutMs, f.config.maxBodyBytes), {code: 'ACTOR_DENIED'});
  assert.equal((await f.cli(['worker', 'close', worker, '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['project', 'list'], '', access)).code, 4);
  assert.equal((await f.cli(['project', 'list'], '', shellAccess)).code, 4);
});

test('active workers publish shared checkpoints with authenticated provenance and stable retries', {timeout:testDeadline(30000)}, async t => {
  const construction = Promise.withResolvers();
  const f = await fixture(t, {harnessFactory:(config,home,_workspace,_budget,permission)=>{
    const harness=new ControlledHarness(`session-${basename(home)}`,permission,config.selectedModel?JSON.parse(config.selectedModel)[1]:config.model);
    if(config.workerIdentity)construction.resolve({harness,credential:config.workerCredential});return harness;
  }});
  const project=(await f.cli(['project','create','--name','Cooperative checkpoint','--root',join(f.root,'research'),'--request-id',randomUUID()])).value.data.result;
  const worker=project.initialWorkerId;
  const sent=await f.cli(['worker','send',worker,'--text','Work remains unfinished','--request-id',randomUUID(),'--wait']);
  assert.equal(sent.code,0,sent.stdout);
  const {harness,credential} = await construction.promise;await harness.promptEntered.promise;
  const before=(await f.cli(['worker','get',worker])).value.data;
  assert.equal(before.state,'running');
  const help=await f.cli(['checkpoint','publish','--help','--schema','--json']);
  assert(help.value.commands['checkpoint.publish'].input.properties.note);
  assert.equal(help.value.commands['checkpoint.publish'].input.properties.externalWritersQuiescent,undefined);
  const workspace=(await f.cli(['node','get',project.mainNodeId])).value.data.workspace;
  await writeFile(join(workspace,'unfinished.txt'),'unfinished work');
  const access={HARNESSCTL_TOKEN:credential.token,HARNESSCTL_WORKER_ID:randomUUID()};
  const args=['checkpoint','publish','--node',project.mainNodeId,'--note','Partial analysis; tests pending','--request-id',randomUUID()];
  const result=await f.cli(args,'',access);
  assert.equal(result.code,0,result.stdout);
  const checkpoint=result.value.data.result;
  assert.deepEqual(checkpoint.publisher,{kind:'worker',id:worker,processId:before.processId});
  assert.equal(checkpoint.note,'Partial analysis; tests pending');
  assert.deepEqual(checkpoint.files,['unfinished.txt']);
  assert.equal(checkpoint.capture.consistency,'cooperative-verified');
  assert.equal(checkpoint.capture.policy,'regular-files-v1');
  assert(checkpoint.capture.finishedAt>=checkpoint.capture.startedAt);
  assert.equal((await f.cli(['worker','get',worker])).value.data.state,'running');
  await writeFile(join(workspace,'unfinished.txt'),'later edits');
  assert.deepEqual((await f.cli(args,'',access)).value.data.result,checkpoint);
  assert.deepEqual((await f.cli(['checkpoint','get',checkpoint.id,'--node',project.mainNodeId])).value.data,checkpoint);
  const forged=await f.cli(['checkpoint','publish','--input','-'],JSON.stringify({node:project.mainNodeId,publisher:{kind:'owner',id:'local-owner'}}),access);
  assert.equal(forged.code,2,forged.stdout);
  const retired=await f.cli(['checkpoint','publish','--node',project.mainNodeId,'--external-writers-quiescent']);
  assert.equal(retired.code,2,retired.stdout);
  harness.complete();
});

test('worker settings, bounded observations and retained evidence work through the executable without cancelling work', {timeout: testDeadline(30000)}, async t => {
  const construction = Promise.withResolvers();
  const harnessFactory = (config, home, _workspace, _budget, permission) => {
    class ConfigurableHarness extends ControlledHarness {
      async models() { return [config.model, 'deepseek-v4-pro'].map(model => ({name:model,value:JSON.stringify([config.provider,model]),image:false})); }
    }
    const harness = new ConfigurableHarness(`session-${basename(home)}`, permission, config.selectedModel ? JSON.parse(config.selectedModel)[1] : config.model); if(config.workerIdentity)construction.resolve(harness); return harness;
  };
  const f = await fixture(t, {harnessFactory});
  const created = await f.cli(['project', 'create', '--name', 'Observation', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  const worker = created.value.data.result.initialWorkerId;
  const noHistory = await f.cli(['worker', 'history', worker]);
  assert.notEqual(noHistory.code, 0); assert.equal(noHistory.value.error.code, 'NO_HISTORY');
  assert.equal((await f.cli(['worker', 'update', worker, '--title', 'Observed worker', '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.title, 'Observed worker');
  const options = await f.cli(['worker', 'get', worker, '--options']);
  assert.equal(options.code, 0, options.stdout); assert.equal(options.value.data.worker.harnessSessionId, null);
  const alternate = options.value.data.options.models[0].options.find(value => JSON.parse(value.value)[1] === 'deepseek-v4-pro').value;
  assert.equal((await f.cli(['worker', 'update', worker, '--model', alternate, '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['worker', 'update', worker, '--environment', 'none', '--request-id', randomUUID()])).code, 0);
  const submitted = await f.cli(['worker', 'send', worker, '--text', 'Stay active while observed', '--request-id', randomUUID(), '--wait']);
  assert.equal(submitted.code, 0, submitted.stdout); assert.equal(submitted.value.data.state, 'succeeded');
  const harness = await construction.promise;
  await harness.promptEntered.promise;
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  const observed = await f.cli(['worker', 'get', worker, '--follow', '--timeout', '100ms']);
  assert.equal(observed.code, 0, observed.stdout); assert(observed.records.some(record => record.kind === 'snapshot'));
  assert.equal(observed.value.kind, 'end'); assert.equal(observed.value.workCancelled, false);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'running');
  const answer = harness.askPermission('cli-review-call');
  const permission = (await f.cli(['worker', 'get', worker])).value.data.permissions[0]; assert(permission);
  const respond = ['worker', 'respond', worker, '--request', permission.id, '--option', 'allow-once', '--request-id', randomUUID()];
  assert.equal((await f.cli(respond)).code, 0); assert.deepEqual(await answer, {outcome: 'selected', optionId: 'allow-once'});
  assert.equal((await f.cli(respond)).code, 0, 'An identical permission reply must recover its receipt');
  assert.equal((await f.cli([...respond.slice(0, -1), randomUUID()])).code, 3, 'A new request cannot answer an already-settled permission');
  assert.equal((await f.cli(['worker', 'interrupt', worker, '--request-id', randomUUID(), '--wait', '--timeout', '2s'])).code, 0);
  await f.workerWhen(worker,view=>view.submissions.some(value=>value.id===submitted.value.data.requestId&&value.state==='interrupted'));
  assert.equal((await f.cli(['operation', 'get', submitted.value.data.reference, '--wait', '--timeout', '2s'])).value.data.state, 'succeeded');
  assert.equal((await f.cli(['operation', 'get', submitted.value.data.reference])).value.data.result.state, 'interrupted');
  const session = (await f.cli(['worker', 'get', worker])).value.data.harnessSessionId;
  assert.equal((await f.cli(['worker', 'close', worker, '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['worker', 'resume', worker, '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.harnessSessionId, session);
  assert.equal((await f.cli(['worker', 'close', worker, '--request-id', randomUUID()])).code, 0);
  const media = await persistMedia(join(f.config.stateRoot, 'harness', worker), session, 'Independent retained evidence');
  assert.equal((await f.cli(['worker', 'update', worker, '--archived', 'true', '--request-id', randomUUID()])).code, 0);
  const history = await f.cli(['worker', 'history', worker]); assert.equal(history.code, 0, history.stdout);
  const image = history.value.data.attachments.find(value => value.mediaType === 'image/png');
  const path = join(f.root, 'downloaded.png');
  const evidence = await f.cli(['worker', 'evidence', worker, '--reference', image.reference, '--output', path]);
  assert.equal(evidence.code, 0, evidence.stdout); assert.deepEqual(await readFile(path), media.png);
  assert.equal(evidence.value.data.data, undefined, 'Binary data must be written only to the selected file');
  const collision = await f.cli(['worker', 'evidence', worker, '--reference', image.reference, '--output', path]);
  assert.notEqual(collision.code, 0); assert.deepEqual(await readFile(path), media.png);
  assert.equal((await f.cli(['worker', 'get', worker])).value.data.state, 'closed');
});

test('subprocess research path retains idempotent defaults, publications, lineage and history after restart', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t), request = randomUUID();
  const create = ['project', 'create', '--name', 'Research', '--root', join(f.root, 'research'), '--request-id', request];
  const [first, duplicate] = await Promise.all([f.cli(create), f.cli(create)]);
  assert.equal(first.code, 0, first.stdout); assert.deepEqual(duplicate.value.data, first.value.data);
  const project = first.value.data.result;
  assert.equal(project.initialization.state, 'ready'); assert(project.mainNodeId); assert(project.initialWorkerId);
  assert.equal((await f.cli(['project', 'get', project.id])).value.data.mainNodeId, project.mainNodeId);
  const conflict = await f.cli([...create.slice(0, 3), 'Changed', ...create.slice(4)]);
  assert.equal(conflict.code, 3); assert.equal(conflict.value.error.code, 'REQUEST_CONFLICT');
  const node = (await f.cli(['node', 'get', project.mainNodeId])).value.data;
  await writeFile(join(node.workspace, 'result.txt'), 'retained result\n');
  const publication = await f.cli(['checkpoint', 'publish', '--node', project.mainNodeId, '--request-id', randomUUID()]);
  assert.equal(publication.code, 0, publication.stdout);
  const checkpoint = publication.value.data.result;
  assert.equal((await f.cli(['checkpoint', 'list', '--node', project.mainNodeId])).value.data.items[0].id, checkpoint.id);
  const graph = (await f.cli(['graph', 'get', '--project', project.id])).value.data;
  const inherited = await f.cli(['node', 'create', '--project', project.id, '--title', 'Continuation', '--expect-revision', String(graph.revision), '--from-checkpoint', checkpoint.id, '--request-id', randomUUID()]);
  assert.equal(inherited.code, 0, inherited.stdout);
  const continuation = inherited.value.data.result.nodes.find(value => value.id !== project.mainNodeId);
  const location = (await f.cli(['node', 'get', continuation.id])).value.data.workspace;
  assert.equal(await readFile(join(location, 'result.txt'), 'utf8'), 'retained result\n');
  assert.equal((await f.cli(['worker', 'list', '--project', project.id])).value.data.items.length, 1);
  const relation = await f.cli(['relation', 'create', '--project', project.id, '--from', project.mainNodeId, '--to', continuation.id, '--label', 'Informs', '--expect-revision', '2', '--request-id', randomUUID()]);
  assert.equal(relation.code, 0, relation.stdout);
  const edge = relation.value.data.result.edges[0].id;
  const updated = await f.cli(['relation', 'update', edge, '--project', project.id, '--explanation', 'Revised interpretation', '--expect-revision', '3', '--request-id', randomUUID()]);
  assert.equal(updated.code, 0, updated.stdout); assert.equal(updated.value.data.result.edges[0].explanation, 'Revised interpretation');
  assert.equal(updated.value.data.result.edges[0].relation, 'Informs');
  assert.equal((await f.cli(['node', 'update', continuation.id, '--project', project.id, '--archived', 'true', '--expect-revision', '4', '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['relation', 'retract', edge, '--project', project.id, '--expect-revision', '5', '--request-id', randomUUID()])).code, 0);
  await f.reopen();
  assert.equal((await f.cli(['operation', 'get', first.value.data.reference])).value.data.result.id, project.id);
  assert.equal((await f.cli(['checkpoint', 'get', checkpoint.id, '--node', project.mainNodeId])).value.data.commit, checkpoint.commit);
  const retainedHistory = (await f.cli(['graph', 'history', '--project', project.id])).value.data;
  assert.equal(retainedHistory.entries.length, 6);
  assert.equal(retainedHistory.entries.at(-1).command.kind, 'edge.retract');
  assert.equal((await f.cli(['node', 'get', continuation.id])).value.data.node.archived, true);
});

test('stale graph edits have conflict exit semantics and expose the retained owner receipt', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t);
  const created = await f.cli(['project', 'create', '--name', 'Conflict', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  const project = created.value.data.result;
  const stale = await f.cli(['node', 'create', '--project', project.id, '--title', 'Stale', '--expect-revision', '0', '--request-id', randomUUID()]);
  assert.equal(stale.code, 3, stale.stdout);
  assert.equal(stale.value.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.cli(['operation', 'get', stale.value.data.reference])).value.data.state, 'failed');
});

test('graph repair-tail recovers a controlled incomplete append through the public CLI', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t);
  const created = await f.cli(['project', 'create', '--name', 'Tail recovery', '--root', join(f.root, 'research'), '--request-id', randomUUID()]);
  const project = created.value.data.result;
  const original = (await f.cli(['graph', 'get', '--project', project.id])).value.data;
  // Private bytes are touched only to inject a crash fault; verification and repair use public commands.
  await appendFile(join(project.root, '.polariton', 'graph.jsonl'), '{"unfinished":');
  await f.reopen();
  const interrupted = (await f.cli(['graph', 'get', '--project', project.id])).value.data;
  assert.match(interrupted.recovery, /Incomplete/); assert.deepEqual(interrupted.nodes, original.nodes);
  const args = ['graph', 'repair-tail', '--project', project.id, '--request-id', randomUUID()];
  const repaired = await f.cli(args); assert.equal(repaired.code, 0, repaired.stdout); assert.deepEqual(repaired.value.data.result, original);
  assert.deepEqual((await f.cli(args)).value.data, repaired.value.data);
  await f.reopen(); assert.deepEqual((await f.cli(['graph', 'get', '--project', project.id])).value.data, original);
});

test('real Environment daemon previews file and stdin identically and retains immutable imported definitions', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false, environment: true});
  const document = {configuration: {mcpServers: {example: {url: 'http://127.0.0.1:1/mcp'}}}, resolutions: {}};
  const path = join(f.root, 'mcp.json'); await writeFile(path, JSON.stringify(document));
  const file = await f.cli(['capability', 'preview', '--input', path]);
  const stdin = await f.cli(['capability', 'preview', '--input', '-'], JSON.stringify(document));
  assert.equal(file.code, 0, file.stdout); assert.deepEqual(file.value, stdin.value);
  assert.equal(file.value.data.entries.length, 1); assert.deepEqual((await f.cli(['capability', 'list'])).value.data.items, []);
  const requestId = randomUUID();
  const imported = await f.cli(['capability', 'import', '--request-id', requestId, '--input', '-'], JSON.stringify({entries: file.value.data.entries}));
  assert.equal(imported.code, 0, imported.stdout);
  const capability = (await f.cli(['capability', 'list'])).value.data.items[0];
  const retained = await f.cli(['capability', 'get', capability.id, '--revision', capability.revisionId]);
  assert.equal(retained.code, 0, retained.stdout); assert.equal(retained.value.data.name, 'example');
  const changed = await f.cli(['capability', 'import', '--request-id', requestId, '--input', '-'], JSON.stringify({entries: [{...file.value.data.entries[0], name: 'Conflicting definition'}]}));
  assert.equal(changed.code, 3, changed.stdout);
  assert.equal((changed.value.error ?? changed.value.data.error).code, 'OPERATION_CONFLICT');
  assert.equal((await f.cli(['capability', 'list'])).value.data.items.length, 1);
  const revised = await f.cli(['capability', 'revise', capability.id, '--expect-revision', capability.revisionId, '--request-id', randomUUID(), '--input', '-'], JSON.stringify({entry: {...file.value.data.entries[0], definition: {...file.value.data.entries[0].definition, url: 'http://127.0.0.1:2/mcp'}}}));
  assert.equal(revised.code, 0, revised.stdout);
  assert.equal((await f.cli(['capability', 'get', capability.id])).value.data.url, 'http://127.0.0.1:2/mcp');
  assert.equal((await f.cli(['capability', 'get', capability.id, '--revision', capability.revisionId])).value.data.url, 'http://127.0.0.1:1/mcp');
});

test('CLI preview and import preserve inert package intent and worker templates without launching a program', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false, environment: true}), launcher = join(f.root, 'npx'), marker = join(f.root, 'unexpected-launch');
  await writeFile(launcher, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, {mode: 0o700});
  const document = {configuration: {mcpServers: {fixture: {command: launcher, args: ['-y', 'fixture@1.0.0', '${POLARITON_WORKSPACE}'], env: {CACHE: '${POLARITON_RUNTIME}'}}}}};
  const preview = await f.cli(['capability', 'preview', '--input', '-'], JSON.stringify(document));
  assert.equal(preview.code, 0, preview.stdout);
  const definition = preview.value.data.entries[0].definition;
  assert.deepEqual(definition.package, {manager: 'npm', specifier: 'fixture@1.0.0', executable: 'fixture'});
  assert.equal(definition.args.at(-1), '${POLARITON_WORKSPACE}'); assert.equal(definition.env.CACHE, '${POLARITON_RUNTIME}');
  const imported = await f.cli(['capability', 'import', '--request-id', randomUUID(), '--input', '-'], JSON.stringify({entries: preview.value.data.entries}));
  assert.equal(imported.code, 0, imported.stdout);
  const capability = (await f.cli(['capability', 'list'])).value.data.items[0];
  assert.deepEqual(capability.package, definition.package); assert.equal(capability.args.at(-1), '${POLARITON_WORKSPACE}');
  await assert.rejects(access(marker), {code: 'ENOENT'});
});

test('executable malformed, duplicate and oversized secret-bearing JSON never reaches Environment mutation', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false, environment: true}), secret = 'private-sentinel-cli';
  for (const value of [`{"${secret}":`, JSON.stringify({[secret]: true}), '{"entries":[],"entries":[]}', JSON.stringify({[secret]: 'x'.repeat(f.config.maxBodyBytes)})]) {
    const result = await f.cli(['capability', 'import', '--request-id', randomUUID(), '--input', '-'], value);
    assert.notEqual(result.code, 0); assert(!result.stdout.includes(secret)); assert(!result.stderr.includes(secret));
    assert.match(result.value.error.code, /^(INVALID_JSON|INVALID_INPUT|INPUT_LIMIT|DUPLICATE_KEY)$/);
  }
  assert.deepEqual((await f.cli(['capability', 'list'])).value.data.items, []);
});

test('Environment preview errors and partial preparation are structured nonzero outcomes', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false, environment: true});
  const preview = await f.cli(['capability', 'preview', '--input', '-'], JSON.stringify({configuration: {mcpServers: {example: {url: 'http://127.0.0.1:1/mcp', headers: {Authorization: 'Bearer secret-preview-value'}}}}}));
  assert.notEqual(preview.code, 0, preview.stdout); assert(preview.value.data.errors.length > 0); assert(!preview.stdout.includes('secret-preview-value'));
  const entry = {name: 'Unprepared', definition: {kind: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, credentials: {}, requirements: {files: [join(f.root, 'absent-required-file')], identityFiles: [], execution: 'foreground-host'}}};
  const imported = await f.cli(['capability', 'import', '--request-id', randomUUID(), '--input', '-'], JSON.stringify({entries: [entry]}));
  assert.equal(imported.code, 0, imported.stdout);
  const capability = (await f.cli(['capability', 'list'])).value.data.items[0];
  const document = {format: 2, environmentId: 'laboratory', name: 'Laboratory', description: '', components: [{id: 'component', name: 'Unprepared', definition: {capabilityId: capability.id, revisionId: capability.revisionId}}]};
  const previewed = await f.cli(['environment', 'publish', '--preview', '--input', '-'], JSON.stringify({document, expectRevision: null}));
  assert.equal(previewed.code, 0, previewed.stdout); assert.deepEqual((await f.cli(['environment', 'list'])).value.data.items, []);
  const publication = await f.cli(['environment', 'publish', '--request-id', randomUUID(), '--input', '-'], JSON.stringify({document, expectRevision: null}));
  assert.equal(publication.code, 0, publication.stdout);
  const applied = await f.cli(['environment', 'apply', 'laboratory', '--revision', publication.value.data.result.revisionId, '--request-id', randomUUID()]);
  assert.equal(applied.code, 6, applied.stdout); assert.equal(applied.value.data.result.status, 'partial');
  const operation = await f.cli(['operation', 'get', applied.value.data.reference]);
  assert.equal(operation.value.data.result.components[0].readiness, 'unavailable');
  const revision = publication.value.data.result.revisionId;
  assert.equal((await f.cli(['environment', 'get', 'laboratory'])).value.data.revisionId, revision);
  assert.equal((await f.cli(['environment', 'remove', 'laboratory', '--expect-revision', revision, '--request-id', randomUUID()])).code, 0);
  assert.equal((await f.cli(['environment', 'get', 'laboratory', '--revision', revision])).value.data.revisionId, revision);
});

test('explicit lifecycle commands start one Environment owner and retain settled stop receipts', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false});
  try {
    assert.equal((await f.cli(['daemon', 'status', 'environment'])).value.data.environment.state, 'stopped');
    const args = ['daemon', 'start', 'environment', '--detach', '--request-id', randomUUID()];
    const started = await f.cli(args);
    assert.equal(started.code, 0, started.stdout); assert.equal(started.value.version, 1);
    assert.equal(started.value.data.state, 'succeeded');
    const pid = started.value.data.result.environment.status.pid;
    assert(pid > 0);
    assert.equal((await f.cli(args)).value.data.result.environment.status.pid, pid);
    const conflicting = await f.cli(['daemon', 'start', 'main', '--detach', '--request-id', args.at(-1)]);
    assert.equal(conflicting.code, 3); assert.equal(conflicting.value.error.code, 'REQUEST_CONFLICT');
    assert.equal((await f.cli(['daemon', 'status', 'main'])).value.data.main.state, 'stopped');
    const reused = await f.cli(['daemon', 'start', 'environment', '--detach', '--request-id', randomUUID()]);
    assert.equal(reused.value.data.result.environment.reused, true); assert.equal(reused.value.data.result.environment.status.pid, pid);
    const stopped = await f.cli(['daemon', 'stop', 'environment', '--request-id', randomUUID()]);
    assert.equal(stopped.code, 0, stopped.stdout); assert.equal(stopped.value.version, 1);
    assert.equal(stopped.value.data.state, 'succeeded'); assert.equal(stopped.value.data.result.environment.state, 'stopped');
    assert.equal((await f.cli(['operation', 'get', stopped.value.data.reference])).value.data.state, 'succeeded');
    assert.equal((await f.cli(['daemon', 'status', 'environment'])).value.data.environment.state, 'stopped');
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  } finally {
    // Only this fixture's unique socket/state can be addressed by its explicit configuration.
    await f.cli(['daemon', 'stop', 'environment', '--request-id', randomUUID()]);
  }
});

test('foreground lifecycle supervision permits an independent settled stop command', {timeout: testDeadline(30000)}, async t => {
  const f = await fixture(t, {main: false}), id = randomUUID();
  const foreground = f.spawnCli(['daemon', 'start', 'environment', '--request-id', id]); foreground.stdin.end(); foreground.stderr.resume();
  const exited = new Promise(resolve => foreground.once('close', resolve));
  let output = '';
  const ready = Promise.withResolvers();
  foreground.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) ready.resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); });
  foreground.once('error', ready.reject);
  try {
    const started = await ready.promise;
    assert.equal(started.data.state, 'succeeded');
    const duplicate = await f.cli(['daemon', 'start', 'environment', '--request-id', id]);
    assert.equal(duplicate.code, 0, duplicate.stdout);
    const stopped = await f.cli(['daemon', 'stop', 'environment', '--request-id', randomUUID()]);
    assert.equal(stopped.code, 0, stopped.stdout); assert.equal(stopped.value.data.state, 'succeeded');
    assert.equal(await exited, 0);
    assert.equal((await f.cli(['daemon', 'status', 'environment'])).value.data.environment.state, 'stopped');
  } finally {
    if (foreground.exitCode === null && foreground.signalCode === null) { foreground.kill('SIGTERM'); await exited; }
    await f.cli(['daemon', 'stop', 'environment', '--request-id', randomUUID()]);
  }
});

test('worker creation captures literal role files and immutable authenticated provenance before dispatch', {timeout:testDeadline(30000)},async t=>{
 const f=await fixture(t,{configOverrides:{maxWorkerPromptBytes:128}});
 const project=(await f.cli(['project','create','--name','Roles','--root',join(f.root,'research'),'--request-id',randomUUID()])).value.data.result;
 const file=join(f.root,'role.md'),text='# Analyst\nKeep {{literal}} and $HOME as written.\n';
 await writeFile(file,text);
 const id=randomUUID(),args=['worker','create','--node',project.mainNodeId,'--title','Analyst','--system-prompt-file','role.md','--request-id',id];
 const created=await f.cli(args);assert.equal(created.code,0,created.stdout);
 const worker=created.value.data.result;
 assert.equal(worker.state,'inactive');assert.equal(worker.creation.specification.systemPrompt.text,text);
 assert.equal(worker.creation.specification.systemPrompt.sourcePath,file);
 assert.deepEqual(worker.creation.creator,{kind:'owner',id:'local-owner'});assert.equal(worker.creation.requestId,id);
 assert.equal(worker.creation.instructionDigest.length,64);
 assert.deepEqual((await f.cli(args)).value.data,created.value.data);
 await writeFile(file,'Changed instructions');const conflict=await f.cli(args);assert.equal(conflict.code,3,conflict.stdout);assert.equal(conflict.value.error.code,'REQUEST_CONFLICT');
 await rm(file);await f.reopen();
 const restored=(await f.cli(['worker','get',worker.id])).value.data;
 assert.deepEqual(restored.creation,worker.creation);
 const recovered=await f.cli(['operation','get',created.value.data.reference]);assert.equal(recovered.value.data.result.id,worker.id);
 for(const [name,bytes] of [['oversized.md',Buffer.alloc(129,65)],['invalid.md',Buffer.from([0xc3,0x28])]]){
  await writeFile(join(f.root,name),bytes);
  const invalid=await f.cli(['worker','create','--node',project.mainNodeId,'--title','Invalid','--system-prompt-file',name,'--request-id',randomUUID()]);assert.notEqual(invalid.code,0,invalid.stdout);
 }
 const directory=await f.cli(['worker','create','--node',project.mainNodeId,'--title','Directory','--system-prompt-file',f.root,'--request-id',randomUUID()]);assert.equal(directory.code,2,directory.stdout);
 const workers=await f.cli(['worker','list','--project',project.id]);assert.equal(workers.value.data.items.length,2);
});

test('compact receipts retain actionable identities, distinguish retained snapshots and preserve explicit full evidence', {timeout:testDeadline(30000)}, async t=>{
 const construction=Promise.withResolvers();
 const f=await fixture(t,{receiptDetails:false,harnessFactory:(_config,home,_workspace,_budget,permission)=>{const harness=new ControlledHarness(`compact-${basename(home)}`,permission);if(_config.workerIdentity)construction.resolve(harness);return harness;}});
 const project=(await f.cli(['project','create','--name','Compact','--root',join(f.root,'research'),'--request-id',randomUUID(),'--json'])).value.data.result;
 assert.equal((await f.cli(['worker','overview',project.initialWorkerId,'--json'])).code,0);
 const file=join(f.root,'role.md'),instructions='Long private role instructions. '.repeat(60);await writeFile(file,instructions);
 const request=randomUUID(),args=['worker','create','--node',project.mainNodeId,'--title','Original','--system-prompt-file',file,'--request-id',request];
 const created=await f.cli(args),receipt=created.value.data;
 assert.equal(created.code,0,created.stdout);assert.equal(receipt.view,'compact');assert.equal(receipt.resultBasis,'retained-command-result');assert(receipt.result.id);assert.equal(receipt.result.model!==undefined,true);
 assert.equal(receipt.input,undefined);assert.equal(receipt.attempts,undefined);assert.equal(receipt.result.creation,undefined);assert(!created.stdout.includes(instructions));assert.match(receipt.inspect.operation,/--details$/);
 const full=await f.cli([...args,'--details']);assert.equal(full.value.data.result.creation.specification.systemPrompt.text,instructions);assert.equal(full.value.data.actor.kind,'owner');assert.equal(full.value.data.view,undefined);assert(created.stdout.length<full.stdout.length/2);
 await f.cli(['worker','update',receipt.result.id,'--title','Renamed','--request-id',randomUUID()]);
 const replay=await f.cli(args);assert.equal(replay.value.data.result.title,'Original');assert.equal(replay.value.data.resultBasis,'retained-command-result');assert.equal((await f.cli(['worker','overview',receipt.result.id])).value.data.worker.name.text,'Renamed');
 const recovered=await f.cli(['operation','get',receipt.reference,'--details']);assert.deepEqual(recovered.value.data,full.value.data);
 const graph=(await f.cli(['graph','get','--project',project.id])).value.data;
 const node=(await f.cli(['node','create','--project',project.id,'--expect-revision',String(graph.revision),'--title','Second','--request-id',randomUUID()])).value.data.result;
 assert(node.id);assert.equal(node.title,'Second');assert.equal(node.nodes,undefined);assert.equal(node.nodeCount,2);
 assert.equal((await f.cli(['node','get',node.id])).value.data.node.id,node.id);
 const sent=await f.cli(['worker','send',project.initialWorkerId,'--text','Payload must not echo. '.repeat(100),'--json']);const harness=await construction.promise;await harness.promptEntered.promise;
 assert.equal(sent.code,0,sent.stdout);assert.equal(sent.value.data.resultBasis,'delivery-observation');assert.equal(sent.value.data.result.recipientWorkerId,project.initialWorkerId);assert.equal(sent.value.data.result.text,undefined);assert.match(sent.value.data.note,/not recipient task completion/);assert.equal(sent.value.data.state,'succeeded');assert.equal((await f.cli(['worker','get',project.initialWorkerId])).value.data.state,'running');
 harness.complete();
});

test('CLI errors identify missing and invalid fields without dispatch or input disclosure', {timeout:testDeadline(30000)},async t=>{
 const f=await fixture(t,{receiptDetails:false});
 for(const [args,pattern] of [
  [['worker','list'],/Missing required option: --project/],
  [['checkpoint','get',randomUUID()],/Missing required option: --node/],
  [['worker','get'],/Missing required argument: TARGET/],
  [['worker','create','--node',randomUUID(),'--title','Valid'],/--request-id UUID/],
  [['worker','create','--node','secret-sentinel','--title','Valid','--request-id',randomUUID()],/--node: use a UUID/],
  [['worker','create','--node',randomUUID(),'--title','Valid','--environment','tools','--request-id',randomUUID()],/Environment requires an exact revision/],
 ]){
  const result=await f.cli([...args,'--json']);assert.equal(result.code,2,result.stdout);assert.match(result.value.error.message,pattern);assert.match(result.value.error.message,new RegExp(`harnessctl ${args[0]} ${args[1]} --help`));assert(!result.stdout.includes('secret-sentinel'));
 }
 const duplicate=await f.cli(['worker','create','--wait','--wait']);assert.equal(duplicate.code,2);assert.match(duplicate.value.error.message,/Duplicate flag --wait/);
 const unknown=await f.cli(['worker','list','--unknown','secret-sentinel']);assert.equal(unknown.code,2);assert.match(unknown.value.error.message,/Unsupported flag --unknown.*worker list --help/);assert(!unknown.stdout.includes('secret-sentinel'));
 assert.equal((await f.cli(['project','list'])).value.data.items.length,0);
});
