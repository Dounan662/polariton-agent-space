import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {guardianIdentity,settleGuardian} from '../harness/guardian-control.mjs';

const limits={nativeDrainTimeoutMs:150,termTimeoutMs:150,killTimeoutMs:2000,pollMs:10,requestTimeoutMs:5000,maxFrameBytes:4096};
const script=fileURLToPath(new URL('./fixtures/guardian/tree.mjs',import.meta.url));
const guardian=fileURLToPath(new URL('../harness/guardian.mjs',import.meta.url));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function waitFor(read,ready,timeout=5000){const end=performance.now()+timeout;let last;while(performance.now()<end){last=await read();if(ready(last))return last;await delay(10);}throw new Error(`Timed out waiting for fixture: ${JSON.stringify(last)}`);}
async function fixture(t,{stubborn=false,ownMain=false,native=false,drain='native'}={}){
  const root=await mkdtemp(join(tmpdir(),'polariton-guardian-test-')),identity=guardianIdentity(root),pids=join(root,'pids.jsonl');
  const child=spawn(process.execPath,[ownMain?fileURLToPath(new URL('./fixtures/guardian/main.mjs',import.meta.url)):guardian],{detached:true,stdio:['pipe','pipe','pipe','pipe','ipc']});
  let stdout='',stderr='';const messages=[];child.on('message',m=>messages.push(m));child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdio[3].resume();
  const started=new Promise((accept,reject)=>{child.on('message',message=>{if(message.type==='started')accept(message);});child.on('error',reject);child.on('exit',()=>reject(new Error('guardian exited before startup: '+stderr)));});
  child.send({identity,execution:native?'native':'group',command:process.execPath,args:[script,pids,'2',stubborn?'yes':'no',native?drain:'group'],cwd:root,env:process.env,limits});
  const ready=await started;
  const rows=await waitFor(async()=>{try{return (await readFile(pids,'utf8')).trim().split('\n').map(JSON.parse);}catch{return[];}},rows=>rows.length===3);
  t.after(async()=>{
    // The test knows these freshly spawned fixture PIDs. Production recovery never does this.
    for(const {pid} of rows)try{process.kill(pid,'SIGKILL');}catch{}
    try{process.kill(ready.guardianPid??child.pid,'SIGKILL');}catch{}
    try{child.kill('SIGKILL');}catch{}
    await rm(identity.socket,{force:true});await rm(root,{recursive:true,force:true});
  });
  return {identity,child,rows,ready,root,output:()=>stdout+stderr,messages};
}

test('guardian settles cooperative descendants and drops raw inherited stderr',async t=>{
  const f=await fixture(t);try{await settleGuardian(f.identity,limits,'group');}catch(error){throw new Error(JSON.stringify(f.messages)+' '+f.output(),{cause:error});}
  await waitFor(async()=>f.rows.every(row=>!alive(row.pid)),Boolean);
  assert(!f.output().includes('CREDENTIAL-SENTINEL'));
  await settleGuardian(f.identity,limits,'group'); // durable idempotent settlement after guardian exit
});
test('stubborn children and grandchildren holding pipes are killed without touching a concurrent worker',async t=>{
  const a=await fixture(t,{stubborn:true}),b=await fixture(t,{stubborn:true});
  await settleGuardian(a.identity,limits,'group');assert(a.rows.every(row=>!alive(row.pid)));assert(b.rows.every(row=>alive(row.pid)));
  await settleGuardian(b.identity,limits,'group');assert(b.rows.every(row=>!alive(row.pid)));
});
test('DSH SIGKILL drains remaining owned descendants and leaves a recovery receipt',async t=>{
  const f=await fixture(t,{stubborn:true});process.kill(f.rows.find(row=>row.depth===2).pid,'SIGKILL');
  await waitFor(async()=>{try{await settleGuardian(f.identity,limits,'group');return true;}catch{return false;}},Boolean);
  assert(f.rows.every(row=>!alive(row.pid)));
});
test('Main SIGKILL triggers guardian cleanup without inheriting Main liveness into children',async t=>{
  const f=await fixture(t,{stubborn:true,ownMain:true});f.child.kill('SIGKILL');
  await waitFor(async()=>{try{return JSON.parse(await readFile(join(f.identity.directory,'settled.json'),'utf8'));}catch{return null;}},Boolean);
  await settleGuardian(f.identity,limits,'group');assert(f.rows.every(row=>!alive(row.pid)));
});
test('guardian failure remains pending, ignores forged settlement, and does not signal an unrelated live process',async t=>{
  const f=await fixture(t,{stubborn:true});f.child.kill('SIGKILL');await delay(30);
  await assert.rejects(settleGuardian(f.identity,limits,'group'),/cleanup is pending/);assert(f.rows.every(row=>alive(row.pid)));
  await writeFile(join(f.identity.directory,'settled.json'),JSON.stringify({value:{id:f.identity.id,settled:true},signature:'00'}));
  await assert.rejects(settleGuardian(f.identity,limits,'group'),/cleanup is pending/);assert(f.rows.every(row=>alive(row.pid)));
});
test('wrong guardian authority cannot retire a worker',async t=>{
  const f=await fixture(t);await assert.rejects(settleGuardian({...f.identity,token:'0'.repeat(64)},limits,'group'),/cleanup is pending/);
  assert(f.rows.every(row=>alive(row.pid)));await settleGuardian(f.identity,limits,'group');
});


test('guardian identity rejects an overlong UTF-8 runtime address before execution starts',()=>{
  assert.throws(()=>guardianIdentity('/tmp/unused-home','/tmp/'+ 'é'.repeat(30)),/too long for guardian Unix sockets/);
});

test('native settlement requires the execution owner acknowledgment as well as group termination',async t=>{
  const f=await fixture(t,{native:true});await settleGuardian(f.identity,limits,'native');
  assert(f.rows.every(row=>!alive(row.pid)));
  await settleGuardian(f.identity,limits,'native');
  const group=await fixture(t);await settleGuardian(group.identity,limits,'group');
  await assert.rejects(settleGuardian(group.identity,limits,'native'),/cleanup is pending/);
});

test('abrupt execution-owner death cannot manufacture a native settlement receipt',async t=>{
  const f=await fixture(t,{native:true,stubborn:true});
  process.kill(f.rows.find(row=>row.depth===2).pid,'SIGKILL');
  await assert.rejects(settleGuardian(f.identity,limits,'native'),/cleanup is pending/);
  assert(f.rows.every(row=>!alive(row.pid)),'The foreground group still drains even when native settlement is unknown');
  await assert.rejects(readFile(join(f.identity.directory,'settled.json')),{code:'ENOENT'});
  const began=performance.now();
  await assert.rejects(settleGuardian(f.identity,limits,'native'),/cleanup is pending/);
  assert(performance.now()-began<limits.requestTimeoutMs/2,'An uncertain guardian answers retries without waiting for request expiry');
});

for(const drain of ['silent','refuse','malformed'])test(`native ${drain} drain cannot authorize settlement`,async t=>{
  const f=await fixture(t,{native:true,drain});
  await assert.rejects(settleGuardian(f.identity,limits,'native'),/cleanup is pending/);
  assert(f.rows.every(row=>!alive(row.pid)));
  await assert.rejects(readFile(join(f.identity.directory,'settled.json')),{code:'ENOENT'});
  const began=performance.now();
  await assert.rejects(settleGuardian(f.identity,limits,'native'),/cleanup is pending/);
  assert(performance.now()-began<limits.requestTimeoutMs/2,'An uncertain guardian answers retries without waiting for request expiry');
});
