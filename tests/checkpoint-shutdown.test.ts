import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer, type Socket} from 'node:net';
import {chmod, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createApp} from '../src/main.ts';
import {applicationSocket} from '../src/cli/server.ts';
import {socketRequest} from '../src/environment/daemon.ts';
import type {Operation} from '../src/operations.ts';
import {temporaryDirectory} from './fixtures/storage.ts';
import {testConfig} from './fixtures/config.ts';
import {testDeadline} from './fixtures/timing.ts';

test('daemon shutdown cancels an active CLI checkpoint before draining its request and preserves recovery', {timeout:testDeadline(30000)}, async t => {
  const root = await temporaryDirectory('checkpoint-shutdown-');
  const config = {...await testConfig(root), checkpointTimeoutMs:testDeadline(60000), checkpointKillGraceMs:testDeadline(100)};
  let runtime = await createApp(config, () => { throw new Error('Checkpoint publication must not activate a worker'); });
  await runtime.app.ready();
  const entered = Promise.withResolvers<Socket>(), ended = Promise.withResolvers<void>();
  let hookSocket: Socket | undefined;
  const server = createServer(socket => {
    hookSocket = socket;
    socket.once('close', () => ended.resolve());
    socket.resume();
    entered.resolve(socket);
  });
  const hookAddress = join(root,'hook.sock');
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(hookAddress,resolve); });
  t.after(async () => {
    // If the regression fails, release the test hook so cleanup cannot wait for
    // the deliberately long production operation deadline.
    hookSocket?.end('release');
    await runtime.app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root,{recursive:true,force:true});
  });
  const project = await runtime.tree.createProject(randomUUID(),'Shutdown checkpoint');
  const node = randomUUID();
  await runtime.tree.mutate(project.id,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:node,title:'Shared workspace',description:''}});
  const workspace = runtime.tree.workspace(project.id,node), hook = join(workspace,'.git','hooks','pre-commit');
  const hookProgram = join(root,'hook.mjs');
  await writeFile(hookProgram,"import net from 'node:net'; const connection = net.createConnection(process.argv[2]); connection.on('data', () => process.exit(0));\n");
  const quote = (value:string) => `'${value.replaceAll("'","'\\''")}'`;
  await writeFile(hook,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hookProgram)} ${quote(hookAddress)}\n`);
  await chmod(hook,0o755);
  await writeFile(join(workspace,'result.txt'),'unfinished research');
  const {token} = JSON.parse(await readFile(join(root,'application-admin.json'),'utf8')) as {token:string};
  const requestId = randomUUID();
  const request = {version:1,requestId,command:{kind:'checkpoint.publish',input:{node}}};
  const publication = socketRequest<Operation>(applicationSocket(root),token,'/v1/execute',request,testDeadline(15000),config.cliMaxStreamBytes);
  await entered.promise;
  const closed = runtime.app.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([closed,ended.promise]),
      new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error('Shutdown waited for the checkpoint execution deadline instead of cancelling it')),testDeadline(10000)); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  const interrupted = await publication;
  assert.equal(interrupted.state,'failed');
  assert.equal(interrupted.error?.code,'CHECKPOINT_CANCELLED');
  await rm(hook);
  runtime = await createApp(config, () => { throw new Error('Checkpoint recovery must not activate a worker'); });
  await runtime.app.ready();
  assert.equal(runtime.tree.operation(requestId).error?.code,'CHECKPOINT_CANCELLED','Cancellation receipt is durable before storage closes');
  const completed = await socketRequest<Operation>(applicationSocket(root),token,'/v1/execute',request,testDeadline(15000),config.cliMaxStreamBytes);
  assert.equal(completed.state,'succeeded',JSON.stringify(completed.error));
  assert.equal(runtime.tree.checkpoints(project.id,node).length,1);
});
