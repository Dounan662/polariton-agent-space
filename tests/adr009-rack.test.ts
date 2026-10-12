import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, chmod, cp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {temporaryDirectory} from './fixtures/storage.ts';
import { EnvironmentRack } from '../src/environment/rack.ts';
import { EnvironmentClient,loadRackConfig } from '../src/environment/daemon.ts';
import { RackConfig, type Component, type Connection, type Release, type Revision, type Realization, type Mount } from '../src/environment/contracts.ts';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const enabled = process.env.POLARITON_RACK_TESTS === '1';
const image = 'node@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152';

/** These tests exercise public rack operations against real containers only with explicit opt-in. */
test('ADR-009 public rack lifecycle on the explicitly selected container backend', { skip: !enabled, timeout: 360000 }, async t => {
  const directory = await temporaryDirectory('polariton-rack-'), source = join(directory, 'capability');
  await mkdir(join(source, 'environment'), { recursive: true });
  const fixture = join(root, 'tests', 'fixtures', 'adr009');
  for (const name of ['capability.mjs', 'exhaust.mjs', 'package.json', 'package-lock.json']) await copyFile(join(fixture, name), join(source, name));
  await writeFile(join(source, 'server.mjs'), (await readFile(join(fixture, 'server.mjs'), 'utf8')).replace("'../../../environment/server.mjs'", "'./environment/server.mjs'"));
  await copyFile(join(root, 'environment', 'server.mjs'), join(source, 'environment', 'server.mjs'));
  const manifest = { format: 1, name: 'Controlled statistics', description: 'Independent ADR-009 contract fixture', image, build: [['npm', 'ci', '--ignore-scripts', '--omit=dev', '--cache', '/tmp/npm']], entrypoint: ['env', 'POLARITON_FIXTURE_DESTRUCTIVE=1', 'node', 'server.mjs'], lockfiles: ['package-lock.json'], configSchema: { type: 'object', additionalProperties: false }, mcpPath: '/mcp', port: 8080, state: 'scratch' };
  await writeFile(join(source, 'polariton-capability.json'), JSON.stringify(manifest));
  const git = async (...args: string[]) => (await exec('git', ['-C', source, ...args], { timeout: 15000 })).stdout.trim();
  await git('init', '--quiet'); await git('add', '.');
  await git('-c', 'user.name=Polariton verifier', '-c', 'user.email=verifier@polariton.invalid', 'commit', '--quiet', '-m', 'Statistics fixture release 1');
  const commit1 = await git('rev-parse', 'HEAD'); await git('tag', 'fixture-current');
  const configured=await loadRackConfig(process.env.POLARITON_RACK_CONFIG);
  const config = RackConfig.parse({ ...configured,stateRoot: join(directory, 'state'), socketPath: join(directory, 'rack.sock'), startupTimeoutMs: 45000, operationTimeoutMs: 120000, monitorMs: 250, observationTimeoutMs: 3000, observationFreshMs: 100, restartAttempts: 1 });
  let rack = await new EnvironmentRack(config).open();
  await t.test('package registration resolves source identity and converges across retries', async () => {
    const input = {kind:'capability.register', operationId:randomUUID(), id:'statistics', repository:source};
    const registered = await rack.execute(input) as {id:string;source:{repository:string;subdirectory:string}};
    assert.deepEqual(registered.source,{repository:source,subdirectory:''});
    assert.deepEqual(await rack.execute(input),registered);
    assert.deepEqual(await rack.execute({...input,operationId:randomUUID()}),registered);
    await assert.rejects(rack.execute({...input,operationId:randomUUID(),repository:join(source,'environment')}), /different source directory/);
    const nongit=await mkdtemp('/tmp/polariton-nongit-');
    try {await assert.rejects(rack.execute({...input,operationId:randomUUID(),repository:nongit}), /not a git repository/);}
    finally {await rm(nongit,{recursive:true,force:true});}
  });
  let rackOpen = true, blocked = false;
  const clients: Client[] = [], checks: Array<{name: string; status: string}> = [];
  t.after(async () => {
    if (rackOpen) for (const mount of (await rack.inventory()).mounts) if (mount.containerId) {
      try { const logs = await exec('docker', ['--config', config.dockerConfig!, '--context', config.dockerContext, 'logs', '--tail', '80', mount.containerId], { timeout: 10000 }); await writeFile(join(directory, `${mount.id}.log`), logs.stdout + logs.stderr); if (blocked) console.error(logs.stderr); }
      catch (error) { console.error(`Could not retain fixture logs: ${String(error)}`); }
    }
    for (const client of clients) await client.close(); if (rackOpen) await rack.close(); t.diagnostic(JSON.stringify({image,commit1,checks}));await rm(directory,{recursive:true,force:true});
  });
  const check = async (name: string, run: () => Promise<void>) => {
    if (blocked) { checks.push({ name, status: 'not-run' }); await t.test(name, { skip: 'A required preceding lifecycle stage failed' }, () => {}); return; }
    await t.test(name, async () => { try { await run(); checks.push({ name, status: 'pass' }); } catch (error) { blocked = true; checks.push({ name, status: 'fail' }); throw error; } });
  };
  const connect = async (connection: Connection) => {
    const client = new Client({ name: 'rack-contract-verifier', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: Object.fromEntries(connection.headers.map(({name, value}) => [name, value])) } }));
    return client;
  };
  let r1: Release, r2: Release, e1: Revision, shared: Mount, connection: Connection, live: Client;
  const component = (releaseId: string): Component => ({ id: 'statistics', name: 'Measurement statistics', releaseId, configuration: {} });

  await check('one owner, immutable R1 installation, idempotency and source/tag independence', async () => {
    await assert.rejects(new EnvironmentRack(config).open(), /owns this state/);
    await rack.execute({ kind: 'capability.register', operationId: 'register-statistics', id: 'statistics', repository: source });
    const install = { kind: 'release.install', operationId: 'release-one', packageId: 'statistics', commit: commit1 };
    r1 = await rack.execute(install) as Release;
    assert.equal(r1.commit, commit1); assert.match(r1.artifactDigest, /^[a-f0-9]{64}$/); assert.match(r1.imageId, /^sha256:/); assert.ok(r1.locks['package-lock.json']);
    const provenance = await rack.provenance(r1.id);
    const retainedSource = await readFile(join(config.stateRoot, 'releases', r1.id, 'source.tar'));
    assert.equal(provenance.sourceDigest, createHash('sha256').update(retainedSource).digest('hex'));
    assert.equal(provenance.commit, commit1); assert.equal(provenance.artifactDigest, r1.artifactDigest); assert.equal(provenance.imageId, r1.imageId); assert.equal(provenance.image, image);
    assert.deepEqual(provenance.manifest, r1.manifest); assert.deepEqual(provenance.locks, r1.locks);
    assert.deepEqual(provenance.builds.map(value => value.argv), manifest.build); assert.ok(provenance.builds.every(value => value.output.length > 0));
    const dependencies = provenance.dependencies as {packages: Record<string, {version: string}>};
    assert.equal(dependencies.packages['node_modules/@modelcontextprotocol/server'].version, '2.2.0');
    assert.equal(dependencies.packages['node_modules/zod'].version, '4.6.5');
    assert.deepEqual(await rack.execute(install), r1);
    await assert.rejects(rack.execute({ ...install, commit: '0'.repeat(40) }), /already used/);
    await writeFile(join(source, 'server.mjs'), (await readFile(join(source, 'server.mjs'), 'utf8')).replace("?? '1'", "?? '2'"));
    await git('add', '.'); await git('-c', 'user.name=Polariton verifier', '-c', 'user.email=verifier@polariton.invalid', 'commit', '--quiet', '-m', 'Statistics fixture release 2');
    await git('tag', '--force', 'fixture-current');
    assert.equal((await rack.inventory()).releases.find(value => value.id === r1.id)?.commit, commit1);
    assert.ok((await readFile(join(config.stateRoot, 'releases', r1.id, 'artifact', 'server.mjs'), 'utf8')).includes("?? '1'"));
  });
  await check('publish validates configuration and stale edits without activating infrastructure', async () => {
    const document = { format:2, environmentId: 'environment-one', name: 'First environment', description: '', components: [component(r1.id)] };
    e1 = await rack.execute({ kind: 'environment.publish', operationId: 'revision-one', expectedBase: null, document }) as Revision;
    assert.equal((await rack.inventory()).mounts.length, 0);
    await assert.rejects(rack.execute({ kind: 'environment.publish', operationId: 'stale-revision', expectedBase: null, document }), /changed/);
    await assert.rejects(rack.execute({ kind: 'environment.publish', operationId: 'invalid-revision', expectedBase: e1.revisionId, document: { ...document, components: [{ ...component(r1.id), configuration: { unsupported: true } }] } }), /additional properties/);
    assert.equal((await rack.inventory()).environments[0].head.revisionId, e1.revisionId);
    assert.deepEqual(await rack.revision(e1.environmentId, e1.revisionId), e1);
  });
  await check('failure after immutable revision publication preserves a valid head and same-operation recovery', async () => {
    const document = { format:2, environmentId: 'publication-recovery', name: 'Before interruption', description: '', components: [] };
    const base = await rack.execute({ kind: 'environment.publish', operationId: 'publication-base', expectedBase: null, document }) as Revision;
    const update = { kind: 'environment.publish', operationId: 'publication-interrupted', expectedBase: base.revisionId, document: { ...document, name: 'After recovery' } };
    const envDirectory = join(config.stateRoot, 'environments', document.environmentId);
    let retained: Revision;
    // Inject a filesystem failure at the actual publication boundary: the revision
    // child remains writable while replacing its parent's head becomes impossible.
    await chmod(envDirectory, 0o500);
    try {
      await assert.rejects(rack.execute(update), /EACCES|permission denied/i);
      assert.equal((await rack.inventory()).environments.find(value => value.id === document.environmentId)?.head.revisionId, base.revisionId);
      retained = await rack.revision(document.environmentId, update.operationId);
      assert.equal(retained.name, 'After recovery');
    } finally { await chmod(envDirectory, 0o700); }
    await rack.close(); rackOpen = false; rack = await new EnvironmentRack(config).open(); rackOpen = true;
    assert.equal((await rack.inventory()).environments.find(value => value.id === document.environmentId)?.head.revisionId, base.revisionId);
    assert.deepEqual(await rack.execute(update), retained);
    assert.equal((await rack.inventory()).environments.find(value => value.id === document.environmentId)?.head.revisionId, retained.revisionId);
  });
  await check('explicit realization, direct MCP invocation, discovery and shared membership', async () => {
    const realized = await rack.execute({ kind: 'environment.apply', operationId: 'apply-one', environmentId: e1.environmentId, revisionId: e1.revisionId }) as Realization;
    assert.equal(realized.status, 'ready', JSON.stringify(realized));
    shared = (await rack.inventory()).mounts.find(value => value.id === realized.components[0].mountId)!;
    assert.equal(shared.state, 'running');
    await assert.rejects(rack.execute({ kind: 'binding.create', operationId: 'spoof-internal-principal', mountId: shared.id, principal: 'rack-observer', access: 'call' }), /reserved/);
    connection = await rack.execute({ kind: 'binding.create', operationId: 'consumer-one', mountId: shared.id, principal: 'consumer', access: 'call' }) as Connection;
    live = await connect(connection);
    assert.deepEqual((await live.callTool({ name: 'statistics', arguments: { values: [2, 4, 4, 4, 5, 5, 7, 9] } })).structuredContent, { count: 8, mean: 5, standardDeviation: 2 });
    const probe = (await live.callTool({ name: 'isolation_probe', arguments: {} })).structuredContent as Record<string, unknown>;
    assert.equal(probe['/state'], true); for (const path of ['/app', '/source', '/run/polariton']) assert.notEqual(probe[path], true, `${path} must not be writable`);
    for (let attempt = 0; attempt <= config.maxObservations; attempt++) await assert.rejects(rack.observe('missing-mount'), /does not exist/);
    const observation = await rack.observe(shared.id, 'stats://capability');
    assert.equal(observation.available, true, observation.error ?? 'Missing observation'); assert.equal(observation.releaseId, r1.id);
    assert.ok(observation.tools.some(value => (value as {name: string}).name === 'statistics'));
    const other = await rack.execute({ kind: 'environment.publish', operationId: 'shared-revision', expectedBase: null, document: { format:2, environmentId: 'environment-two', name: 'Second environment', description: '', components: [{ ...component(r1.id), sharedMountId: shared.id }] } }) as Revision;
    const sharedUse = await rack.execute({ kind: 'environment.apply', operationId: 'apply-shared', environmentId: other.environmentId, revisionId: other.revisionId }) as Realization;
    assert.equal(sharedUse.components[0].mountId, shared.id); assert.equal((await rack.inventory()).mounts.length, 1);
    await rack.execute({ kind: 'environment.publish', operationId: 'removed-membership', expectedBase: e1.revisionId, document: { format:2, environmentId: e1.environmentId, name: e1.name, description: '', components: [] } });
    assert.equal((await rack.inventory()).mounts[0].containerId, shared.containerId, 'Saving must not restart infrastructure');
    await rack.execute({ kind: 'environment.apply', operationId: 'apply-empty', environmentId: e1.environmentId, revisionId: 'removed-membership' });
    assert.equal((await rack.inventory()).mounts[0].state, 'running');
    assert.deepEqual((await live.callTool({ name: 'echo', arguments: { identity: 'shared-survives' } })).structuredContent, { identity: 'shared-survives', version: 1 });
  });
  await check('environment removal hides membership, retains history and never stops shared clients', async () => {
    const document={format:2,environmentId:'removable',name:'Remove this environment',description:'',components:[{...component(r1.id),sharedMountId:shared.id}]};
    const revision=await rack.execute({kind:'environment.publish',operationId:'removable-revision',expectedBase:null,document}) as Revision;
    await rack.execute({kind:'environment.apply',operationId:'removable-apply',environmentId:document.environmentId,revisionId:revision.revisionId});
    const command={kind:'environment.remove',operationId:'remove-environment',environmentId:document.environmentId,expectedBase:revision.revisionId};
    await assert.rejects(rack.execute({...command,operationId:'remove-stale',expectedBase:'not-current'}),/changed/);
    const before=(await rack.inventory()).mounts.find(value=>value.id===shared.id)!;
    const removed=await rack.execute(command);
    assert.deepEqual(await rack.execute(command),removed);
    assert.deepEqual(await rack.execute({...command,operationId:'remove-again'}),removed);
    const inventory=await rack.inventory();
    assert.equal(inventory.environments.some(value=>value.id===document.environmentId),false);
    assert.equal(inventory.activeRealizations[document.environmentId],undefined);
    assert.ok(inventory.realizations.some(value=>value.environmentId===document.environmentId));
    assert.deepEqual(inventory.mounts.find(value=>value.id===shared.id),before);
    assert.deepEqual(await rack.revision(document.environmentId,revision.revisionId),revision);
    // Model loss of the operational receipt after the JSON publication committed.
    // The current head is already removed; recovering the old receipt must not resurrect it.
    const receiptDb=new DatabaseSync(join(config.stateRoot,'operations.sqlite'));
    receiptDb.prepare("DELETE FROM records WHERE kind='operation' AND id=?").run('removable-revision');receiptDb.close();
    assert.deepEqual(await rack.execute({kind:'environment.publish',operationId:'removable-revision',expectedBase:null,document}),revision);
    assert.equal((await rack.inventory()).environments.some(value=>value.id===document.environmentId),false);

    await assert.rejects(rack.execute({kind:'environment.publish',operationId:'removed-edit',expectedBase:revision.revisionId,document}),/removed/);
    await assert.rejects(rack.execute({kind:'environment.apply',operationId:'removed-apply',environmentId:document.environmentId,revisionId:revision.revisionId}),/removed/);
    assert.deepEqual((await live.callTool({name:'echo',arguments:{identity:'survives-removal'}})).structuredContent,{identity:'survives-removal',version:1});

    const concurrent={...document,environmentId:'remove-race',components:[]};
    await rack.execute({kind:'environment.publish',operationId:'remove-race-base',expectedBase:null,document:concurrent});
    const race=await Promise.allSettled([
      rack.execute({kind:'environment.publish',operationId:'remove-race-edit',expectedBase:'remove-race-base',document:{...concurrent,name:'Edited'}}),
      rack.execute({kind:'environment.remove',operationId:'remove-race-delete',environmentId:concurrent.environmentId,expectedBase:'remove-race-base'}),
    ]);
    assert.equal(race.filter(value=>value.status==='fulfilled').length,1,'A stale removal or edit cannot overwrite the winning operation');
  });
  await check('bounded rack observations preserve truthful cached source identity through malformed, oversized, missing and slow replies', async () => {
    const baseline = await rack.observe(shared.id, 'stats://capability'); assert.equal(baseline.available, true);
    const missing = await rack.observe(shared.id, 'stats://missing'); assert.equal(missing.available, false); assert.equal(missing.stale, true); assert.ok(missing.error);
    const calls = async () => JSON.parse(((await live.readResource({ uri: 'fixture://receipts' })).contents[0] as {text: string}).text).calls as Array<{name: string}>;
    for (const control of [{ mode: 'error' }, { mode: 'malformed-envelope' }, { mode: 'oversized', bytes: config.maxObservationBytes + 1 }, { mode: 'normal', delayMs: config.observationTimeoutMs * 2 }]) {
      await live.callTool({ name: 'fixture_observation', arguments: control });
      const before = await calls();
      const failed = await rack.observe(shared.id, 'stats://capability');
      assert.equal(failed.available, false, `Fault ${control.mode} must not appear live`); assert.equal(failed.stale, true); assert.ok(failed.error);
      assert.equal(failed.observedAt, baseline.observedAt); assert.equal(failed.releaseId, baseline.releaseId); assert.equal(failed.generation, baseline.generation); assert.deepEqual(failed.value, baseline.value);
      assert.deepEqual(await calls(), before, 'Observation must never execute action tools');
    }
    await live.callTool({ name: 'fixture_observation', arguments: { mode: 'normal' } });
    const recovered = await rack.observe(shared.id, 'stats://capability'); assert.equal(recovered.available, true); assert.equal(recovered.stale, false);
  });
  await check('install R2 preserves active R1 and defective candidate fails observably', async () => {
    r2 = await rack.execute({ kind: 'release.install', operationId: 'release-two', packageId: 'statistics', commit: await git('rev-parse', 'HEAD') }) as Release;
    assert.notEqual(r2.commit, r1.commit); assert.notEqual(r2.artifactDigest, r1.artifactDigest);
    assert.equal((await rack.inventory()).mounts[0].component.releaseId, r1.id);
    assert.equal(JSON.parse(((await live.readResource({ uri: 'stats://capability' })).contents[0] as {text: string}).text).version, 1);
    await writeFile(join(source, 'polariton-capability.json'), JSON.stringify({ ...manifest, build: [['node', '-e', 'process.exit(37)']] }));
    await git('add', '.'); await git('-c', 'user.name=Polariton verifier', '-c', 'user.email=verifier@polariton.invalid', 'commit', '--quiet', '-m', 'Deliberately defective candidate');
    await assert.rejects(rack.execute({ kind: 'release.install', operationId: 'release-defective', packageId: 'statistics', commit: await git('rev-parse', 'HEAD') }), /failed/);
    const inventory = await rack.inventory(); assert.equal(inventory.releases.length, 2);
    assert.equal(inventory.operations.find(value => value.id === 'release-defective')?.state, 'failed');
    assert.deepEqual((await live.callTool({ name: 'echo', arguments: { identity: 'failed-install-isolated' } })).structuredContent, { identity: 'failed-install-isolated', version: 1 });
  });
  await check('normal stop drains, explicit release revokes authority, replacement requires new binding', async () => {
    const draining = await rack.execute({ kind: 'mount.stop', operationId: 'stop-draining', id: shared.id }) as Mount;
    assert.equal(draining.state, 'draining');
    await assert.rejects(rack.execute({ kind: 'binding.create', operationId: 'late-binding', mountId: shared.id, principal: 'late', access: 'call' }), /not accepting bindings/);
    await rack.execute({ kind: 'binding.release', operationId: 'release-consumer', id: connection.bindingId });
    assert.equal((await rack.inventory()).mounts[0].state, 'stopped');
    await assert.rejects(live.callTool({ name: 'echo', arguments: { identity: 'revoked' } }));
    const reactivated = await rack.execute({ kind: 'mount.create', operationId: 'reactivate-one', id: shared.id, component: component(r1.id) }) as Mount;
    assert.equal(reactivated.state, 'running'); assert.equal(reactivated.desired, 'running');
    const replaced = await rack.execute({ kind: 'mount.replace', operationId: 'replace-two', id: shared.id, releaseId: r2.id }) as Mount;
    assert.equal(replaced.state, 'running'); assert.equal(replaced.component.releaseId, r2.id);
    const next = await rack.execute({ kind: 'binding.create', operationId: 'consumer-two', mountId: shared.id, principal: 'consumer', access: 'call' }) as Connection;
    assert.notEqual(next.generation, connection.generation); live = await connect(next);
    assert.deepEqual((await live.callTool({ name: 'weighted_statistics', arguments: { values: [1, 3], weights: [1, 3] } })).structuredContent, { count: 2, mean: 2.5, standardDeviation: Math.sqrt(0.75) });
  });
  await check('restart preserves revisions and release identity, reconciles one mount, and never replays tool actions', async () => {
    const before = await rack.inventory();
    for (const client of clients) await client.close();
    await rack.close(); rackOpen = false; rack = await new EnvironmentRack(config).open();
    assert.equal((await rack.inventory()).environments.some(value=>value.id==='removable'),false);
    assert.equal((await rack.revision('removable','removable-revision')).name,'Remove this environment'); rackOpen = true;
    const after = await rack.inventory();
    assert.equal(after.mounts.filter(value => value.state === 'running').length, 1);
    assert.equal(after.mounts[0].component.releaseId, r2.id); assert.notEqual(after.mounts[0].containerId, before.mounts[0].containerId);
    assert.deepEqual(await rack.revision(e1.environmentId, e1.revisionId), e1);
    assert.equal(after.releases.find(value => value.id === r1.id)?.artifactDigest, r1.artifactDigest);
    const resumed = await rack.execute({ kind: 'binding.create', operationId: 'consumer-after-restart', mountId: shared.id, principal: 'resumed', access: 'call' }) as Connection;
    const current = await connect(resumed);
    assert.deepEqual(JSON.parse(((await current.readResource({ uri: 'fixture://receipts' })).contents[0] as {text: string}).text).calls, [], 'Restart must never replay action calls');
    assert.equal(JSON.parse(((await current.readResource({ uri: 'stats://capability' })).contents[0] as {text: string}).text).version, 2);
    const restored = await rack.execute({ kind: 'environment.apply', operationId: 'reproduce-one', environmentId: e1.environmentId, revisionId: e1.revisionId }) as Realization;
    assert.equal(restored.status, 'ready');
    const oldMount = (await rack.inventory()).mounts.find(value => value.id === restored.components[0].mountId)!;
    assert.equal(oldMount.component.releaseId, r1.id);
  });
  await check('partial realization stays visible and the same operation recovers after missing infrastructure is supplied', async () => {
    const revision = await rack.execute({ kind: 'environment.publish', operationId: 'partial-revision', expectedBase: null, document: { format:2, environmentId: 'partial-environment', name: 'Partial environment', description: '', components: [{ ...component(r2.id), id: 'available', sharedMountId: shared.id }, { ...component(r1.id), id: 'missing', sharedMountId: 'supplied-later' }] } }) as Revision;
    const apply = { kind: 'environment.apply', operationId: 'partial-apply', environmentId: revision.environmentId, revisionId: revision.revisionId };
    const partial = await rack.execute(apply) as Realization;
    assert.equal(partial.status, 'partial'); assert.equal(partial.components.filter(value => value.error).length, 1);
    assert.notEqual((await rack.inventory()).operations.find(value => value.id === apply.operationId)?.state, 'succeeded');
    await rack.execute({ kind: 'mount.create', operationId: 'supply-missing', id: 'supplied-later', component: component(r1.id) });
    const recovered = await rack.execute(apply) as Realization;
    assert.equal(recovered.status, 'ready'); assert.ok(recovered.components.every(value => value.error === null));
    await rack.execute({ kind: 'mount.stop', operationId: 'stop-supplied', id: 'supplied-later', force: true });
  });
  await check('draining release replacement survives shutdown and completes its original operation after explicit release', async () => {
    const mount = await rack.execute({ kind: 'mount.create', operationId: 'create-deferred', id: 'deferred-upgrade', component: component(r1.id) }) as Mount;
    const oldGrant = await rack.execute({ kind: 'binding.create', operationId: 'bind-deferred', mountId: mount.id, principal: 'consumer', access: 'call' }) as Connection;
    const oldClient = await connect(oldGrant);
    const upgrade = { kind: 'mount.replace', operationId: 'deferred-replace', id: mount.id, releaseId: r2.id };
    const waiting = await rack.execute(upgrade) as Mount;
    assert.equal(waiting.state, 'draining'); assert.equal(waiting.component.releaseId, r1.id);
    assert.equal((await rack.inventory()).operations.find(value => value.id === upgrade.operationId)?.state, 'waiting');
    assert.equal(JSON.parse(((await oldClient.readResource({ uri: 'stats://capability' })).contents[0] as {text: string}).text).version, 1);
    await rack.close(); rackOpen = false; rack = await new EnvironmentRack(config).open(); rackOpen = true;
    const retained = (await rack.inventory()).mounts.find(value => value.id === mount.id)!;
    assert.equal(retained.state, 'draining'); assert.equal(retained.component.releaseId, r1.id); assert.equal(retained.pendingReleaseId, r2.id);
    await rack.execute({ kind: 'binding.release', operationId: 'allow-deferred-upgrade', id: oldGrant.bindingId });
    const completed = await rack.execute(upgrade) as Mount;
    assert.equal(completed.state, 'running'); assert.equal(completed.component.releaseId, r2.id);
    assert.notEqual(completed.generation, mount.generation);
    const newGrant = await rack.execute({ kind: 'binding.create', operationId: 'bind-upgraded', mountId: mount.id, principal: 'consumer', access: 'call' }) as Connection;
    const upgraded = await connect(newGrant);
    assert.deepEqual((await upgraded.callTool({ name: 'weighted_statistics', arguments: { values: [1, 3], weights: [1, 3] } })).structuredContent, { count: 2, mean: 2.5, standardDeviation: Math.sqrt(0.75) });
    await rack.execute({ kind: 'mount.stop', operationId: 'stop-upgraded', id: mount.id, force: true });
  });
  await check('forced stop escalates normal draining and cancels a pending replacement visibly', async () => {
    const id = 'force-escalation';
    await rack.execute({ kind: 'mount.create', operationId: 'escalation-create', id, component: component(r1.id) });
    const grant = await rack.execute({ kind: 'binding.create', operationId: 'escalation-bind', mountId: id, principal: 'consumer', access: 'call' }) as Connection;
    const direct = await connect(grant);
    const normal = { kind: 'mount.stop', operationId: 'escalation-normal', id };
    assert.equal((await rack.execute(normal) as Mount).state, 'draining');
    const forced = await rack.execute({ ...normal, operationId: 'escalation-force', force: true }) as Mount;
    assert.equal(forced.state, 'stopped'); assert.equal(forced.interrupted, true); assert.equal(forced.containerId, null);
    assert.equal((await rack.execute(normal) as Mount).state, 'stopped');
    await assert.rejects(direct.callTool({ name: 'echo', arguments: { identity: 'forced-revocation' } }));

    await rack.execute({ kind: 'mount.create', operationId: 'cancel-upgrade-create', id, component: component(r1.id) });
    await rack.execute({ kind: 'binding.create', operationId: 'cancel-upgrade-bind', mountId: id, principal: 'consumer', access: 'call' });
    const replace = { kind: 'mount.replace', operationId: 'cancel-upgrade-replace', id, releaseId: r2.id };
    assert.equal((await rack.execute(replace) as Mount).pendingReleaseId, r2.id);
    const cancelled = await rack.execute({ kind: 'mount.stop', operationId: 'cancel-upgrade-force', id, force: true }) as Mount;
    assert.equal(cancelled.state, 'stopped'); assert.equal(cancelled.desired, 'stopped'); assert.equal(cancelled.containerId, null);
    assert.equal(cancelled.pendingReleaseId, undefined); assert.equal(cancelled.component.releaseId, r1.id);
    const receipt = (await rack.inventory()).operations.find(value => value.id === replace.operationId)!;
    assert.equal(receipt.state, 'failed'); assert.match(receipt.error ?? '', /cancel|force/i);
  });
  await check('exclusive resource admission prevents a competing controller in either direction', async () => {
    const resource = 'fixture:exclusive-device';
    const admitted = await Promise.allSettled([true, false].map(exclusive => rack.execute({ kind: 'mount.create', operationId: `exclusive-admission-${exclusive}`, id: `exclusive-${exclusive}`, component: { ...component(r1.id), resource: { identity: resource, exclusive } } })));
    assert.equal(admitted.filter(value => value.status === 'fulfilled').length, 1);
    const rejected = admitted.find(value => value.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'RESOURCE_BUSY');
    const winner = (admitted.find(value => value.status === 'fulfilled') as PromiseFulfilledResult<Mount>).value;
    await rack.execute({ kind: 'mount.stop', operationId: 'stop-exclusive-winner', id: winner.id, force: true });
  });
  for (const mode of ['memory', 'disk', 'helpers', 'cpu', 'output'] as const) await check(`container bounds ${mode} across helper processes and preserves unrelated calls`, async () => {
    const mount = await rack.execute({ kind: 'mount.create', operationId: `create-stress-${mode}`, id: `stress-${mode}`, component: component(r1.id) }) as Mount;
    const grant = await rack.execute({ kind: 'binding.create', operationId: `bind-stress-${mode}`, mountId: mount.id, principal: 'verifier', access: 'call' }) as Connection;
    const stressed = await connect(grant);
    const goodGrant = await rack.execute({ kind: 'binding.create', operationId: `healthy-${mode}`, mountId: shared.id, principal: 'verifier', access: 'call' }) as Connection;
    const healthy = await connect(goodGrant);
    const resource = async (uri: string): Promise<Record<string, unknown>> => JSON.parse(((await stressed.readResource({ uri }, { timeout: 3000 })).contents[0] as {text: string}).text);
    const limits = await resource('fixture://limits');
    assert.equal(limits['memory.max'], String(config.limits.memoryMb * 1024 * 1024));
    assert.equal(limits['pids.max'], String(config.limits.pids));
    const [quota, period] = String(limits['cpu.max']).split(' ').map(Number); assert.equal(quota / period, config.limits.cpus);
    await stressed.callTool({ name: 'fixture_fault', arguments: { mode } });
    const deadline = Date.now() + 20000;
    let settled = false, observed: Record<string, unknown> = {}, receipts: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      observed = await resource('fixture://limits'); receipts = await resource('fixture://receipts');
      const children = receipts.children as Array<{mode: string; state: string; code: number | null; signal: string | null; outputBytes: number}>;
      const child = children.find(value => value.mode === mode)!;
      const metric = (field: string, name: string) => Number(String(observed[field]).split('\n').find(line => line.startsWith(`${name} `))?.split(' ')[1] ?? 0);
      settled = mode === 'memory' ? metric('memory.events', 'oom_kill') > 0 : mode === 'disk' ? child.state === 'exited' && child.code !== 0 : mode === 'helpers' ? metric('pids.events', 'max') > 0 : mode === 'cpu' ? metric('cpu.stat', 'nr_throttled') > 0 : child.outputBytes >= config.limits.outputBytes * 8;
      if (settled) break;
      await new Promise(resolve => setTimeout(resolve, config.monitorMs));
    }
    assert.ok(settled, `${mode} did not reach its independent containment oracle`);
    assert.deepEqual((await healthy.callTool({ name: 'echo', arguments: { identity: `healthy-during-${mode}` } }, { timeout: 3000 })).structuredContent, { identity: `healthy-during-${mode}`, version: 2 });
    let storedOutputBytes: number | undefined;
    if (mode === 'output') {
      const inspected = JSON.parse((await exec('docker', ['--config', config.dockerConfig!, '--context', config.dockerContext, 'inspect', mount.containerId!], { timeout: 10000 })).stdout)[0];
      assert.equal(inspected.HostConfig.LogConfig.Config['max-file'], '1');
      const dockerRoot = (await exec('docker', ['--config', config.dockerConfig!, '--context', config.dockerContext, 'info', '--format', '{{.DockerRootDir}}'], { timeout: 10000 })).stdout.trim();
      // The local driver deliberately leaves LogPath empty; bound the whole container
      // metadata directory, which includes its actual retained local log files.
      assert.equal(inspected.Id,mount.containerId);assert.match(inspected.Id,/^[a-f0-9]{64}$/);
      assert.equal(inspected.Config.Labels['polariton.mount'],mount.id);
      assert.ok(dockerRoot.startsWith('/')&&!dockerRoot.includes(','),'Docker root must be an absolute local bind path');
      const metadata=join(dockerRoot,'containers',inspected.Id);
      if(config.runtime.kind==='colima'){
        storedOutputBytes=Number((await exec('colima',['ssh','--profile',config.runtime.profile,'--','sudo','du','-sb',metadata],{timeout:config.observationTimeoutMs})).stdout.trim().split(/\s+/)[0]);
      }else{
        // Reuse the explicitly selected Docker authority without exposing its
        // socket or unrelated host data, and remove our helper even on timeout.
        assert.equal(process.platform,'linux','External Docker storage qualification requires the local Linux engine');
        const helper=`polariton-output-oracle-${randomUUID()}`,docker=['--config',config.dockerConfig!,'--context',config.dockerContext];
        try{
          const result=await exec('docker',[...docker,'run','--rm','--name',helper,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory',`${config.limits.memoryMb}m`,'--memory-swap',`${config.limits.memoryMb}m`,'--cpus',String(config.limits.cpus),'--pids-limit',String(config.limits.pids),'--user','0:0','--mount',`type=bind,src=${metadata},dst=/evidence,readonly`,'--entrypoint','du',image,'-sb','/evidence'],{timeout:config.startupTimeoutMs,maxBuffer:config.maxBodyBytes});
          assert.match(result.stdout.trim(),/^\d+\s+\/evidence$/);storedOutputBytes=Number(result.stdout.trim().split(/\s+/)[0]);
        }finally{
          try{await exec('docker',[...docker,'rm','--force',helper],{timeout:config.shutdownTimeoutMs,maxBuffer:config.maxBodyBytes});}
          catch(error){if(!/no such container/i.test(String((error as {stderr?:string}).stderr??error)))throw error;}
        }
      }
      // Docker log framing and the final in-flight record need a bounded allowance beyond payload bytes.
      assert.ok(storedOutputBytes > 0 && storedOutputBytes <= config.limits.outputBytes * 2, `Stored output was ${storedOutputBytes} bytes`);
    }
    await writeFile(join(directory, `containment-${mode}.json`), JSON.stringify({ limits: observed, receipts, storedOutputBytes }, null, 2));
    const stopped = await rack.execute({ kind: 'mount.stop', operationId: `stop-stress-${mode}`, id: mount.id, force: true }) as Mount;
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.interrupted, true);
    await assert.rejects(exec('docker', ['--config', config.dockerConfig!, '--context', config.dockerContext, 'inspect', mount.containerId!], { timeout: 10000 }), /no such/i);
    await rack.execute({ kind: 'binding.release', operationId: `release-healthy-${mode}`, id: goodGrant.bindingId });
  });
  await check('standalone daemon crash preserves direct MCP service and restart adopts one existing container without replay', async () => {
    await rack.close(); rackOpen = false;
    const daemonConfig = { ...config, socketPath: `/tmp/polariton-adr009-${randomUUID()}.sock` };
    const configFile = join(directory, 'daemon-config.json'); await writeFile(configFile, JSON.stringify(daemonConfig));
    const admin = new EnvironmentClient(daemonConfig);
    let processHandle: ChildProcess | undefined;
    const start = async (attempt: number, wrapperDirectory?: string) => {
      const child = spawn(process.execPath, [join(root, 'src/environment/daemon.ts'), configFile], { cwd: root, env: { PATH: wrapperDirectory ? `${wrapperDirectory}:${process.env.PATH}` : process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
      processHandle = child; let output = '', errors = '';
      child.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-16384); });
      await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Daemon startup timed out: ${errors}`)), config.startupTimeoutMs);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Daemon exited before readiness: ${errors}`)); });
        child.stdout!.on('data', chunk => { output += chunk; if (output.includes('"ready":true')) { clearTimeout(timeout); resolveReady(); } });
      });
      await writeFile(join(directory, `daemon-start-${attempt}.log`), output + errors);
      assert.equal((await admin.call<{ready: boolean}>('/v1/health')).ready, true);
    };
    try {
      await start(1);
      const mount = await admin.call<Mount>('/v1/command', { kind: 'mount.create', operationId: 'daemon-create', id: 'daemon-crash-probe', component: component(r1.id) });
      const grant = await admin.call<Connection>('/v1/command', { kind: 'binding.create', operationId: 'daemon-binding', mountId: mount.id, principal: 'independent-client', access: 'call' });
      const direct = await connect(grant);
      await direct.callTool({ name: 'echo', arguments: { identity: 'before-crash' } });
      const exited = once(processHandle!, 'exit'); processHandle!.kill('SIGKILL'); await exited;
      assert.deepEqual((await direct.callTool({ name: 'echo', arguments: { identity: 'without-supervisor' } })).structuredContent, { identity: 'without-supervisor', version: 1 });
      await start(2);
      const inventory = await admin.call<{mounts: Mount[]}>('/v1/inventory');
      const retained = inventory.mounts.filter(value => value.id === mount.id);
      assert.equal(retained.length, 1); assert.equal(retained[0].containerId, mount.containerId); assert.equal(retained[0].generation, mount.generation);
      const receipts = JSON.parse(((await direct.readResource({ uri: 'fixture://receipts' })).contents[0] as {text: string}).text);
      assert.deepEqual(receipts.calls.map((value: {args: {identity: string}}) => value.args.identity), ['before-crash', 'without-supervisor']);
      await writeFile(join(directory, 'daemon-crash-recovery.json'), JSON.stringify({ mountId: mount.id, containerBefore: mount.containerId, containerAfter: retained[0].containerId, receipts }, null, 2));
      const stopped = once(processHandle!, 'exit'); processHandle!.kill('SIGTERM'); await stopped;

      // Hold the real Docker inspect result after startup, before the daemon can
      // persist its container receipt. This exercises adoption by durable labels.
      const wrapperDirectory = join(directory, 'docker-barrier'); await mkdir(wrapperDirectory);
      const barrierConfig = join(wrapperDirectory, 'config.json'), reached = join(wrapperDirectory, 'reached.json'), releaseBarrier = join(wrapperDirectory, 'release');
      const orphanId = `orphan-${randomUUID()}`;
      await writeFile(barrierConfig, JSON.stringify({ executable: (await exec('which', ['docker'])).stdout.trim(), mountId: orphanId, reached, release: releaseBarrier, pollMs: config.monitorMs, waitMs: config.operationTimeoutMs, maxBytes: config.maxBodyBytes }));
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(join(wrapperDirectory, 'docker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(fixture, 'docker-barrier.mjs'))} ${quote(barrierConfig)} "$@"\n`, { mode: 0o700 });
      try {
        await start(3, wrapperDirectory);
        const command = { kind: 'mount.create', operationId: 'orphan-create', id: orphanId, component: component(r1.id) };
        const creating = admin.call<Mount>('/v1/command', command); void creating.catch(() => {});
        let marker: {containerId: string; generation: string; mountId: string} | undefined;
        const deadline = Date.now() + config.startupTimeoutMs;
        while (!marker && Date.now() < deadline) {
          try { marker = JSON.parse(await readFile(reached, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (!marker) await new Promise(resolveWait => setTimeout(resolveWait, config.monitorMs));
        }
        assert.ok(marker, 'A real running container must reach the held inspect response');
        const pending = (await admin.call<{mounts: Mount[]}>('/v1/inventory')).mounts.find(value => value.id === orphanId)!;
        assert.equal(pending.containerId, null, 'Crash must precede the container receipt'); assert.equal(pending.generation, marker.generation);
        const killed = once(processHandle!, 'exit'); processHandle!.kill('SIGKILL'); await killed; await assert.rejects(creating);
        await writeFile(releaseBarrier, 'released');
        await start(4);
        const adopted = (await admin.call<{mounts: Mount[]}>('/v1/inventory')).mounts.find(value => value.id === orphanId)!;
        assert.equal(adopted.containerId, marker.containerId); assert.equal(adopted.generation, marker.generation);
        const dockerIds = (await exec('docker', ['--config', config.dockerConfig!, '--context', config.dockerContext, 'ps', '-aq', '--no-trunc', '--filter', `label=polariton.mount=${orphanId}`])).stdout.trim().split(/\s+/);
        assert.deepEqual(dockerIds, [marker.containerId]);
        assert.equal((await admin.call<Mount>('/v1/command', command)).containerId, marker.containerId);
        const orphanGrant = await admin.call<Connection>('/v1/command', { kind: 'binding.create', operationId: 'orphan-binding', mountId: orphanId, principal: 'orphan-verifier', access: 'call' });
        const orphanClient = await connect(orphanGrant);
        const orphanReceipts = JSON.parse(((await orphanClient.readResource({ uri: 'fixture://receipts' })).contents[0] as {text: string}).text);
        assert.deepEqual(orphanReceipts.calls, [], 'Recovery must not replay capability actions');
        await writeFile(join(directory, 'daemon-orphan-adoption.json'), JSON.stringify({ beforeReceipt: pending, runtime: marker, adopted, dockerIds, receipts: orphanReceipts }, null, 2));
      } finally { await writeFile(releaseBarrier, 'released'); }
    } finally {
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        const exited = once(processHandle, 'exit'); processHandle.kill('SIGTERM'); await exited;
      }
    }
  });
  await check('reactivation and revision application cannot bypass the configured mount admission limit', async () => {
    const capacityConfig = { ...config, stateRoot: join(directory, 'capacity-state'), socketPath: join(directory, 'capacity.sock'), maxMounts: 1 };
    const limited = await new EnvironmentRack(capacityConfig).open();
    try {
      await limited.execute({ kind: 'capability.register', operationId: 'capacity-register', id: 'statistics', repository: source });
      const release = await limited.execute({ kind: 'release.install', operationId: 'capacity-release', packageId: 'statistics', commit: commit1 }) as Release;
      const revision = await limited.execute({ kind: 'environment.publish', operationId: 'capacity-revision', expectedBase: null, document: { format:2, environmentId: 'limited', name: 'Limited environment', description: '', components: [component(release.id)] } }) as Revision;
      const initial = await limited.execute({ kind: 'environment.apply', operationId: 'capacity-initial', environmentId: revision.environmentId, revisionId: revision.revisionId }) as Realization;
      assert.equal(initial.status, 'ready');
      const previousMount = initial.components[0].mountId!;
      await limited.execute({ kind: 'mount.stop', operationId: 'capacity-stop', id: previousMount });
      await limited.execute({ kind: 'mount.create', operationId: 'capacity-fill', id: 'occupied', component: component(release.id) });
      await assert.rejects(limited.execute({ kind: 'mount.create', operationId: 'capacity-reactivate', id: previousMount, component: component(release.id) }), /capacity/i);
      const deferred = await limited.execute({ kind: 'environment.apply', operationId: 'capacity-reapply', environmentId: revision.environmentId, revisionId: revision.revisionId }) as Realization;
      assert.equal(deferred.status, 'partial'); assert.match(deferred.components[0].error ?? '', /capacity/i);
      assert.equal((await limited.inventory()).mounts.filter(value => value.desired === 'running').length, 1);
      await limited.execute({ kind: 'mount.stop', operationId: 'capacity-free', id: 'occupied' });
      const recovered = await limited.execute({ kind: 'environment.apply', operationId: 'capacity-reapply', environmentId: revision.environmentId, revisionId: revision.revisionId }) as Realization;
      assert.equal(recovered.status, 'ready');
      await limited.execute({ kind: 'mount.stop', operationId: 'capacity-stop-again', id: previousMount });
      const other = await limited.execute({ kind: 'environment.publish', operationId: 'capacity-other', expectedBase: null, document: { format:2, environmentId: 'limited-other', name: 'Other limited environment', description: '', components: [component(release.id)] } }) as Revision;
      const otherInitial = await limited.execute({ kind: 'environment.apply', operationId: 'capacity-other-initial', environmentId: other.environmentId, revisionId: other.revisionId }) as Realization;
      assert.equal(otherInitial.status, 'ready');
      await limited.execute({ kind: 'mount.stop', operationId: 'capacity-stop-other', id: otherInitial.components[0].mountId });
      const competing = await Promise.all([revision, other].map((value, index) => limited.execute({ kind: 'environment.apply', operationId: `competing-reactivation-${index}`, environmentId: value.environmentId, revisionId: value.revisionId }) as Promise<Realization>));
      assert.equal(competing.filter(value => value.status === 'ready').length, 1);
      assert.equal(competing.filter(value => value.status === 'partial').length, 1);
      assert.equal((await limited.inventory()).mounts.filter(value => value.desired === 'running').length, 1);
    } finally { await limited.close(); }
  });
  await check('retention limits preserve publication recovery and bounded cleanup capacity', async () => {
    const privateDockerConfig = join(directory, 'cleanup-docker'); await cp(config.dockerConfig!, privateDockerConfig, { recursive: true });
    const boundedConfig = { ...config, stateRoot: join(directory, 'bounded-state'), socketPath: join(directory, 'bounded.sock'), dockerConfig: privateDockerConfig, maxRecords: 40, maxRevisions: 2, maxEnvironments: 1 };
    let bounded = await new EnvironmentRack(boundedConfig).open(), boundedOpen = true;
    try {
      const document = { format:2, environmentId: 'bounded', name: 'Bounded publication', description: '', components: [] };
      const publishFirst = { kind: 'environment.publish', operationId: 'bounded-first', expectedBase: null, document };
      const first = await bounded.execute(publishFirst) as Revision;
      const publishSecond = { kind: 'environment.publish', operationId: 'bounded-second', expectedBase: first.revisionId, document: { ...document, name: 'Retained orphan at capacity' } };
      const envDirectory = join(boundedConfig.stateRoot, 'environments', document.environmentId);
      await chmod(envDirectory, 0o500);
      try { await assert.rejects(bounded.execute(publishSecond), /EACCES|permission denied/i); }
      finally { await chmod(envDirectory, 0o700); }
      const orphan = await bounded.revision(document.environmentId, publishSecond.operationId);
      assert.deepEqual(await bounded.execute(publishSecond), orphan, 'Retained orphan recovery must not consume a new revision slot');
      await assert.rejects(bounded.execute({ ...publishSecond, operationId: 'bounded-third', expectedBase: orphan.revisionId }), (error: unknown) => (error as {code: string}).code === 'REVISION_CAPACITY');
      await bounded.close(); boundedOpen = false;
      // A process can die after authoritative JSON commits but before its completion
      // receipt. Inject only that interrupted receipt, leaving both revisions intact.
      const database = new DatabaseSync(join(boundedConfig.stateRoot, 'operations.sqlite'));
      try { assert.equal(database.prepare("UPDATE records SET body=json_set(body,'$.state','running','$.result',NULL,'$.error',NULL) WHERE kind='operation' AND id=?").run(publishFirst.operationId).changes, 1); }
      finally { database.close(); }
      bounded = await new EnvironmentRack(boundedConfig).open(); boundedOpen = true;
      assert.deepEqual(await bounded.execute(publishFirst), first, 'Committed ancestor recovery precedes retention admission');
      assert.equal((await bounded.inventory()).environments[0].head.revisionId, orphan.revisionId, 'Receipt recovery must not roll back the head');
      await bounded.execute({ kind: 'capability.register', operationId: 'bounded-package', id: 'statistics', repository: source });
      const release = await bounded.execute({ kind: 'release.install', operationId: 'bounded-release', packageId: 'statistics', commit: commit1 }) as Release;
      const mount = await bounded.execute({ kind: 'mount.create', operationId: 'bounded-mount', id: 'cleanup-obligation', component: component(release.id) }) as Mount;
      const grant = await bounded.execute({ kind: 'binding.create', operationId: 'bounded-binding', mountId: mount.id, principal: 'consumer', access: 'call' }) as Connection;
      const forceMount = await bounded.execute({ kind: 'mount.create', operationId: 'bounded-force-mount', id: 'force-obligation', component: component(release.id) }) as Mount;
      await bounded.execute({ kind: 'binding.create', operationId: 'bounded-force-binding', mountId: forceMount.id, principal: 'consumer', access: 'call' });
      let full = false;
      for (let index = 0; index < boundedConfig.maxRecords * 2; index++) {
        try { await bounded.execute({ kind: 'capability.register', operationId: `fill-retention-${index}`, id: 'statistics', repository: source }); }
        catch (error) { assert.equal((error as {code: string}).code, 'STATE_CAPACITY'); full = true; break; }
      }
      assert.equal(full, true);
      const beforeForce = (await bounded.inventory()).operations.length;
      const normalForce = { kind: 'mount.stop', operationId: 'bounded-normal-stop', id: forceMount.id };
      assert.equal((await bounded.execute(normalForce) as Mount).state, 'draining');
      const forceStop = { ...normalForce, operationId: 'bounded-force-stop', force: true };
      await chmod(privateDockerConfig, 0o000);
      try {
        await assert.rejects(bounded.execute(forceStop));
        for (let index = 0; index < 3; index++) await assert.rejects(bounded.execute({ ...forceStop, operationId: `wrong-force-retry-${index}` }), (error: unknown) => (error as {code: string}).code === 'CLEANUP_PENDING');
        assert.equal((await bounded.inventory()).operations.length, beforeForce + 2, 'Force escalation has only one additional cleanup receipt');
      } finally { await chmod(privateDockerConfig, 0o700); }
      assert.equal((await bounded.execute(forceStop) as Mount).state, 'stopped');
      assert.equal((await bounded.execute(normalForce) as Mount).state, 'stopped');
      const beforeCleanup = (await bounded.inventory()).operations.length;
      const stop = { kind: 'mount.stop', operationId: 'cleanup-stop', id: mount.id };
      assert.equal((await bounded.execute(stop) as Mount).state, 'draining');
      const releaseBinding = { kind: 'binding.release', operationId: 'cleanup-release', id: grant.bindingId };
      await chmod(privateDockerConfig, 0o000);
      try { await assert.rejects(bounded.execute(releaseBinding)); }
      finally { await chmod(privateDockerConfig, 0o700); }
      const afterFailedCleanup = (await bounded.inventory()).operations.length;
      assert.equal(afterFailedCleanup, beforeCleanup + 2, 'Each live obligation receives one bounded cleanup receipt');
      for (let index = 0; index < 3; index++) await assert.rejects(bounded.execute({ ...releaseBinding, operationId: `wrong-cleanup-retry-${index}` }), (error: unknown) => (error as {code: string}).code === 'CLEANUP_PENDING');
      assert.equal((await bounded.inventory()).operations.length, afterFailedCleanup);
      assert.deepEqual(await bounded.execute(releaseBinding), { released: true });
      assert.equal((await bounded.execute(stop) as Mount).state, 'stopped');
      for (let index = 0; index < 3; index++) {
        await assert.rejects(bounded.execute({ ...releaseBinding, operationId: `noop-release-${index}` }), { code: 'STATE_CAPACITY' });
        await assert.rejects(bounded.execute({ ...stop, operationId: `noop-stop-${index}` }), { code: 'STATE_CAPACITY' });
        assert.deepEqual(await bounded.execute(releaseBinding), { released: true });
        assert.equal((await bounded.execute(stop) as Mount).state, 'stopped');
      }
      assert.equal((await bounded.inventory()).operations.length, afterFailedCleanup, 'New request IDs require receipt capacity; retained cleanup receipts remain retryable without consuming reserve');
      await writeFile(join(directory, 'bounded-recovery.json'), JSON.stringify({ firstRevision: first.revisionId, retainedHead: orphan.revisionId, beforeCleanup, afterFailedCleanup, finalOperations: (await bounded.inventory()).operations.length }, null, 2));
    } finally { await chmod(privateDockerConfig, 0o700); if (boundedOpen) await bounded.close(); }
  });

});
