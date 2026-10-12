import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './fixtures/storage.ts';
import { SnapshotCapture, type SnapshotFile, type SnapshotSource } from '../src/checkpoint-capture.ts';
import { Fault } from '../src/contracts.ts';

const execute = promisify(execFile);
const limits = { checkpointCaptureAttempts: 3, checkpointCaptureTimeoutMs: 30000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 65536, maxFileBytes: 32768, maxFrameBytes: 65536 };
const file = (bytes: string, mode: SnapshotFile['mode'] = '100644', version = 'stable'): SnapshotFile => ({bytes:Buffer.from(bytes),mode,version});
const fault = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

/** A fake filesystem changes only at explicit read boundaries; Git remains real so
 * assertions inspect the immutable result, not staging calls or helper order. */
async function fixture(t: TestContext) {
  const root = await temporaryDirectory('test-capture-');
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await execute('git', ['-C', workspace, 'init', '--quiet']);
  t.after(() => rm(root, {recursive:true,force:true}));
  let now = 1000;
  const capture = new SnapshotCapture(limits, () => now++);
  const prefix = join(root, 'snapshot');
  return {root,workspace,prefix,capture,
    async contents(tree: string, path: string) { return (await execute('git', ['-C',workspace,'show',`${tree}:${path}`])).stdout; },
    async clean() { assert.deepEqual((await readdir(root)).filter(name => name.startsWith('snapshot-')), []); },
  };
}

test('a concurrent edit retries and returns only the subsequently verified snapshot', async t => {
  const f = await fixture(t);
  let current = file('unfinished draft');
  let mutate = true;
  const source: SnapshotSource = {
    async files() { return ['paper.txt']; },
    async read() { const result = current; if (mutate) { mutate = false; current = file('concurrent revision', '100644', 'revised'); } return result; },
  };
  const saved = await f.capture.capture(f.workspace, f.prefix, source);
  assert.equal(saved.capture.attempts, 2);
  assert.deepEqual(saved.capture, {startedAt:1001,finishedAt:1002,policy:'regular-files-v1',consistency:'cooperative-verified',attempts:2});
  assert.equal(await f.contents(saved.tree, 'paper.txt'), 'concurrent revision');
  current = file('later edit');
  assert.equal(await f.contents(saved.tree, 'paper.txt'), 'concurrent revision');
  await f.clean();
});

for (const change of ['mode', 'replacement', 'addition', 'deletion', 'rename'] as const) {
  test(`capture detects ${change} during the interval`, async t => {
    const f = await fixture(t);
    const files = new Map([['run.sh', file('echo unfinished\n')]]);
    let mutate = true;
    const saved = await f.capture.capture(f.workspace, f.prefix, {
      async files() { return [...files.keys()]; },
      async read(path) {
        const value = files.get(path);
        if (!value) throw new Fault('FILE_NOT_FOUND', 'Concurrent deletion');
        if (mutate) {
          mutate = false;
          if (change === 'mode') files.set(path, {...value,mode:'100755'});
          if (change === 'replacement') files.set(path, {...value,version:'replaced'});
          if (change === 'addition') files.set('extra.txt', file('another worker'));
          if (change === 'deletion') files.delete(path);
          if (change === 'rename') { files.delete(path); files.set('renamed.sh', value); }
        }
        return value;
      },
    });
    assert.equal(saved.capture.attempts, 2);
    assert.deepEqual(saved.files, [...files.keys()].sort());
    if (change === 'mode') assert.match((await execute('git',['-C',f.workspace,'ls-tree',saved.tree,'run.sh'])).stdout, /^100755 /);
    await f.clean();
  });
}

test('continuous writes exhaust the attempt budget without returning a candidate', async t => {
  const f = await fixture(t); let revision = 0;
  await assert.rejects(f.capture.capture(f.workspace, f.prefix, {
    async files() { return ['stream.txt']; },
    async read() { return file(String(revision++)); },
  }), fault('WORKSPACE_CHANGED'));
  assert.equal(revision, limits.checkpointCaptureAttempts * 2);
  await f.clean();
  // A later useful boundary can succeed; failure did not leave a lock behind.
  const saved = await f.capture.capture(f.workspace, f.prefix, { async files() {return [];}, async read() {throw new Error('No files');} });
  assert.deepEqual(saved.files, []);
});

test('a vanished file retries, while unsupported files and budget failures fail immediately', async t => {
  const f = await fixture(t); let disappeared = true;
  const source: SnapshotSource = { async files() {return ['data'];}, async read() {
    if (disappeared) {disappeared=false;throw new Fault('FILE_NOT_FOUND','Moved by another worker');}
    return file('retained');
  }};
  assert.equal((await f.capture.capture(f.workspace,f.prefix,source)).capture.attempts,2);
  for (const code of ['UNSUPPORTED_FILE','WORKSPACE_LIMIT','FILE_LIMIT']) {
    let reads = 0;
    await assert.rejects(f.capture.capture(f.workspace,f.prefix,{async files(){return ['data'];},async read(){reads++;throw new Fault(code,'Not admitted');}}),fault(code));
    assert.equal(reads,1);
  }
  await f.clean();
});

for (const reason of ['timeout','cancel'] as const) {
  test(`capture ${reason} settles a slow source and releases temporary resources`, async t => {
    const f = await fixture(t), deadline = new AbortController(), caller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const capture = new SnapshotCapture(limits,()=>1000,ms=>{assert.equal(ms,limits.checkpointCaptureTimeoutMs);return deadline.signal;});
    const pending = capture.capture(f.workspace,f.prefix,{
      async files(){return ['slow.txt'];},
      async read(_path,signal){entered.resolve();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});throw new Error('Unreachable');},
    },caller.signal);
    const rejected = assert.rejects(pending,fault(reason==='timeout'?'CAPTURE_TIMEOUT':'CAPTURE_CANCELLED'));
    await entered.promise;
    // No blocking filesystem operation prevents another independent request.
    const other = await f.capture.capture(f.workspace,join(f.root,'independent'),{async files(){return [];},async read(){throw new Error('No files');}});
    assert.deepEqual(other.files,[]);
    (reason==='timeout'?deadline:caller).abort();
    await rejected;
    await f.clean();
  });
}

test('capture enforces independent file-count, file-byte and aggregate-byte budgets', async t => {
  const f = await fixture(t);
  const source: SnapshotSource = { async files(){return ['a','b'];}, async read(){return file('ab');} };
  for (const [budget,code] of [
    [{maxWorkspaceFiles:1},'WORKSPACE_LIMIT'],
    [{maxFileBytes:1},'FILE_LIMIT'],
    [{maxWorkspaceBytes:3},'WORKSPACE_LIMIT'],
  ] as const) {
    await assert.rejects(new SnapshotCapture({...limits,...budget}).capture(f.workspace,f.prefix,source),fault(code));
    await f.clean();
  }
  const saved = await new SnapshotCapture({...limits,maxWorkspaceBytes:4}).capture(f.workspace,f.prefix,source);
  assert.equal(await f.contents(saved.tree,'a'),'ab');
  assert.equal(await f.contents(saved.tree,'b'),'ab');
});
