import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer, type Socket} from 'node:net';
import {chmod, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ResearchTree} from '../src/research.ts';
import {owner} from '../src/caller.ts';
import {temporaryDirectory} from './fixtures/storage.ts';
import {testConfig} from './fixtures/config.ts';
import {testDeadline} from './fixtures/timing.ts';

const execute = promisify(execFile);
const busy = (error:unknown) => error instanceof Error && 'code' in error && error.code === 'CHECKPOINT_BUSY';

test('checkpoint capacity bounds independent nodes without holding a project lock and releases for identical retries', {timeout:testDeadline(20000)}, async t => {
  const root = await temporaryDirectory('checkpoint-capacity-');
  const config = {...await testConfig(root),checkpointMaxProcesses:2};
  const tree = new ResearchTree(config);
  await tree.initialize();
  const barriers = new Map<string,ReturnType<typeof Promise.withResolvers<Socket>>>();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let identity = '';
    socket.on('data', bytes => {
      identity += bytes.toString();
      if (identity.includes('\n')) barriers.get(identity.trim())!.resolve(socket);
    });
    socket.on('close',()=>sockets.delete(socket));
  });
  const address = join(root,'barrier.sock');
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
  t.after(async () => {
    for (const socket of sockets) socket.end('release');
    await tree.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  });
  const project = await tree.createProject(randomUUID(),'Publication capacity');
  const nodes:string[] = [];
  for (const title of ['Blocked first','Independent second','Capacity retry']) {
    const id = randomUUID();
    await tree.mutate(project.id,{operationId:randomUUID(),revision:tree.graph(project.id).revision,command:{kind:'node.create',id,title,description:''}});
    nodes.push(id);
    await writeFile(join(tree.workspace(project.id,id),'result.txt'),title);
  }
  const [first,second,third] = nodes as [string,string,string];
  const program = join(root,'hook.mjs');
  await writeFile(program,"import net from 'node:net'; const socket = net.createConnection(process.argv[2], () => socket.write(process.argv[3]+'\\n')); socket.on('data', () => process.exit(0));\n");
  const quote = (value:string)=>`'${value.replaceAll("'","'\\''")}'`;
  const block = async (node:string) => {
    const ready = Promise.withResolvers<Socket>(); barriers.set(node,ready);
    const hook = join(tree.workspace(project.id,node),'.git','hooks','pre-commit');
    await writeFile(hook,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} ${quote(address)} ${quote(node)}\n`);
    await chmod(hook,0o755);
    return ready;
  };
  const firstReady = await block(first);
  const firstPublication = tree.checkpoint(project.id,first,randomUUID(),{publisher:owner});
  const firstHook = await firstReady.promise;
  await assert.rejects(tree.checkpoint(project.id,first,randomUUID(),{publisher:owner}),busy);
  const independent = await tree.checkpoint(project.id,second,randomUUID(),{publisher:owner});
  assert.equal(independent.nodeId,second,'Another node publishes while the first hook remains blocked');

  const secondReady = await block(second);
  await writeFile(join(tree.workspace(project.id,second),'result.txt'),'Second revision');
  const secondPublication = tree.checkpoint(project.id,second,randomUUID(),{publisher:owner});
  const secondHook = await secondReady.promise;
  const retryId = randomUUID();
  await assert.rejects(tree.checkpoint(project.id,third,retryId,{publisher:owner}),busy);
  assert.deepEqual(tree.checkpoints(project.id,third),[]);
  assert.equal((await execute('git',['-C',tree.workspace(project.id,third),'diff','--cached','--name-only'])).stdout,'','Capacity rejection does not stage user files');
  await tree.mutate(project.id,{operationId:randomUUID(),revision:tree.graph(project.id).revision,command:{kind:'node.edit',id:third,title:'Still editable',description:'Graph work remains independent'}});
  assert.equal(tree.graph(project.id).nodes.find(node=>node.id===third)!.title,'Still editable');

  firstHook.end('release');
  await firstPublication;
  const retried = await tree.checkpoint(project.id,third,retryId,{publisher:owner});
  assert.equal(retried.id,retryId,'The identical rejected request acquires released capacity without a new identity');
  secondHook.end('release');
  await secondPublication;
  assert.equal(tree.checkpoints(project.id,first).length,1);
  assert.equal(tree.checkpoints(project.id,second).length,2);
  assert.equal(tree.checkpoints(project.id,third).length,1);
});
