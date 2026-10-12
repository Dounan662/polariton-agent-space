import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createApp} from '../src/main.ts';
import {testConfig} from '../tests/fixtures/config.ts';
import {temporaryDirectory} from '../tests/fixtures/storage.ts';

// Exercise the built UI and authenticated application API using disposable state.
// Any attempt to create a model harness fails, so this check cannot spend a key.
const stateRoot = await temporaryDirectory('polariton-smoke-');
process.env.POLARITON_DATA_DIR = join(stateRoot, 'data');
process.env.DSH_HOME = join(stateRoot, 'harness');
try {
  const config = {...await testConfig(stateRoot), verification: false};
  const runtime = await createApp(config, () => { throw new Error('Smoke check must not activate a model harness'); });
  try {
    await runtime.app.ready();
    const host = `127.0.0.1:${config.port}`, origin = `http://${host}`;
    const read = (url, headers = {}) => runtime.app.inject({method: 'GET', url, headers: {host, ...headers}});
    assert.equal((await read('/')).statusCode, 200);
    assert.equal((await read('/api/projects')).statusCode, 401);
    const token = new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
    const login = await runtime.app.inject({method: 'POST', url: '/api/bootstrap', headers: {host, origin}, payload: {token}});
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    const projects = await read('/api/projects', {cookie});
    assert.equal(projects.statusCode, 200);
    assert.deepEqual(projects.json(), []);
    console.log('Built UI and authenticated API passed with fresh state; no provider activation.');
  } finally { await runtime.app.close(); }
} finally { await rm(stateRoot, {recursive: true, force: true}); }
