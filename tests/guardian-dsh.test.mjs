import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {Harness} from '../harness/client.ts';
import {loadConfig} from '../src/config.ts';

const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};

/** A vanished DSH owner cannot attest detached execution, even when MCP stdio drains. */
test('real DSH SIGKILL drains MCP stdio but retains unconfirmed native execution',{timeout:60000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-guardian-real-dsh-'))),workspace=join(root,'workspace'),receipts=join(root,'receipts.jsonl');await mkdir(workspace);
  const config={...await loadConfig(),verification:true,startupTimeoutMs:20000,requestTimeoutMs:15000};
  let attempted=0;const harness=new Harness(config,join(root,'harness'),workspace,async()=>{attempted++;return false;});
  let guardianPid;
  t.after(async()=>{
    try{await harness.close();}catch{ /* The test deliberately destroys the only native settlement authority. */ }
    if(guardianPid&&alive(guardianPid))process.kill(guardianPid,'SIGKILL');
    await rm(harness.recoveryIdentity.socket,{force:true});
    await rm(root,{recursive:true,force:true});
  });
  await harness.start();
  const script=fileURLToPath(new URL('./fixtures/adr011/server.mjs',import.meta.url));
  const opened=await harness.activate(null,[{name:'controlled',command:await realpath(process.execPath),args:[script],env:[{name:'ADR011_RECEIPTS',value:receipts}]}]);
  const records=(await readFile(receipts,'utf8')).trim().split('\n').map(JSON.parse),launched=records.findLast(record=>record.phase==='launched'&&alive(record.pid));
  assert(launched);assert.equal(launched.cwd,workspace);assert(records.some(record=>record.method==='tools/list'||record.method==='server/discover'));assert(alive(launched.pid));
  // Only this test observes process identities. Production recovery authenticates
  // its guardian and never authorizes signalling from a persisted PID.
  const {stdout}=await promisify(execFile)('/bin/ps',['-axo','pid=,ppid=,command='],{timeout:config.requestTimeoutMs,maxBuffer:config.maxFrameBytes});
  const expected=fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js',import.meta.url));
  const owned=stdout.split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).find(match=>match&&Number(match[2])===process.pid&&match[3].includes('/harness/guardian.mjs'));
  assert(owned,'Owning guardian is a direct child of the test');guardianPid=Number(owned[1]);
  const children=stdout.split('\n').map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(match=>match&&Number(match[2])===Number(owned[1])&&match[3].includes(expected));
  assert.equal(children.length,1,'Exactly one actual DSH child belongs to this guardian');const dshPid=Number(children[0][1]);
  const unconfirmed=once(harness,'transportError');process.kill(dshPid,'SIGKILL');await unconfirmed;
  await assert.rejects(Harness.recover(harness.recoveryIdentity,config),/cleanup is pending/);
  await assert.rejects(harness.close(),/cleanup is pending/);
  await assert.rejects(readFile(join(harness.recoveryIdentity.directory,'settled.json')),{code:'ENOENT'});
  assert.equal(alive(dshPid),false);assert.equal(alive(launched.pid),false);assert.equal(attempted,0);
  t.diagnostic(JSON.stringify({gate:'real-dsh-sigkill-native-uncertainty',sessionId:opened.sessionId,providerRequests:attempted,stdioSettled:true,guardianSettlementAuthenticated:false,nativeExecutionUnconfirmed:true}));
});
