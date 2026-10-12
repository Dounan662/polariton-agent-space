import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import {ExecutionOwner} from '../harness/execution.mjs';

function processHandle(){
 const exited=Promise.withResolvers(),empty=Promise.withResolvers();let stops=0;
 return {done:exited.promise,terminate(){stops++;},waitForExit:()=>empty.promise,exited:exited.resolve,empty:empty.resolve,get stops(){return stops;}};
}
function terminalHandle(){
 const ended=Promise.withResolvers(),empty=Promise.withResolvers();let stops=0;
 return {pid:123,done:ended.promise,output:{},terminate(){stops++;return empty.promise;},write:async()=>{},resize:async()=>{},inspectForeground:async()=>undefined,inspectActivity:async()=>({state:'idle',revision:0}),signalForeground:async()=>123,empty:empty.resolve,get stops(){return stops;}};
}
const terminalSpec={shellActivity:true};

test('drain fences every native allocation and waits for managed range quiescence, not command exit',async()=>{
 const handle=processHandle(),errors=[],owner=new ExecutionOwner({spawn:()=>handle,spawnTerminal:async()=>terminalHandle(),onFailure:error=>errors.push(error)});
 assert.equal(owner.spawn({}),handle);handle.exited({exitCode:0,signal:null});await nextTurn();
 let finished=false;const first=owner.drain(),drain=first.then(()=>{finished=true;});
 assert.equal(owner.drain(),first);
 assert.throws(()=>owner.spawn({}),{code:'EXECUTION_CLOSING'});
 assert.throws(()=>owner.spawnTerminal(terminalSpec),{code:'EXECUTION_CLOSING'});
 await nextTurn();assert.equal(handle.stops,1);assert.equal(finished,false);
 handle.empty(true);await drain;assert.equal(finished,true);assert.deepEqual(errors,[]);
});

test('terminal allocation accepted before drain is owned even when its handle arrives afterward',async()=>{
 const allocation=Promise.withResolvers(),handle=terminalHandle(),ordinary=processHandle(),owner=new ExecutionOwner({spawn:()=>ordinary,spawnTerminal:()=>allocation.promise,onFailure:()=>{}});
 owner.spawn({});ordinary.empty(true);
 const pending=owner.spawnTerminal(terminalSpec);let drained=false;
 const drain=owner.drain().then(()=>{drained=true;});await nextTurn();assert.equal(drained,false);assert.equal(ordinary.stops,1,'A pending allocation cannot hold up other range termination');
 allocation.resolve(handle);const returned=await pending;await nextTurn();assert.equal(handle.stops,1);assert.equal(drained,false);
 const consumer=returned.terminate();assert.equal(handle.stops,1,'Drain and terminal consumer share one native quiescence operation');
 handle.empty();await Promise.all([consumer,drain]);assert.equal(drained,true);
});

test('a failed allocation or unproven range cannot become a successful drain',async()=>{
 const errors=[],allocation=Promise.withResolvers(),owner=new ExecutionOwner({spawn:()=>processHandle(),spawnTerminal:()=>allocation.promise,onFailure:error=>errors.push(error)});
 const launch=owner.spawnTerminal(terminalSpec),rejected=assert.rejects(launch,/allocation failed/);
 const drain=owner.drain(),failedDrain=assert.rejects(drain,/settlement could not be proven/);
 allocation.reject(new Error('allocation failed'));await Promise.all([rejected,failedDrain]);assert.equal(errors.length,1);
 assert.equal(owner.drain(),drain,'A failed drain cannot reset the admission fence');
 const handle=processHandle(),other=new ExecutionOwner({spawn:()=>handle,spawnTerminal:async()=>terminalHandle(),onFailure:()=>{}});
 other.spawn({});handle.empty(false);await assert.rejects(other.drain(),/settlement could not be proven/);
});

test('drain attempts all owners even when one native termination fails',async()=>{
 const bad=processHandle(),good=processHandle();bad.terminate=()=>{throw new Error('signal failed');};let launch=0;
 const owner=new ExecutionOwner({spawn:()=>launch++?good:bad,spawnTerminal:async()=>terminalHandle(),onFailure:()=>{}});
 owner.spawn({});owner.spawn({});good.empty(true);
 await assert.rejects(owner.drain(),/settlement could not be proven/);assert.equal(good.stops,1);
});

test('normal terminal disposal releases ownership without replacing native I/O behavior',async()=>{
 const handle=terminalHandle();let input;handle.write=async value=>{input=value;};
 const owner=new ExecutionOwner({spawn:()=>processHandle(),spawnTerminal:async()=>handle,onFailure:()=>{}});
 const terminal=await owner.spawnTerminal(terminalSpec);assert.equal(terminal.output,handle.output);assert.equal(terminal.done,handle.done);
 await terminal.write('native input');assert.equal(input,'native input');
 handle.empty();await terminal.terminate();await owner.drain();assert.equal(handle.stops,1);
});

test('real native subprocess ranges drain through their public handles without model execution',{timeout:15000},async t=>{
 const ctx=new Context();await ctx.plugin(LocalSubprocessRuntime,{});
 const errors=[],owner=new ExecutionOwner({spawn:spec=>ctx.subprocess.spawn(spec),spawnTerminal:spec=>ctx.subprocess.spawnTerminal(spec),onFailure:error=>errors.push(error)});
 t.after(async()=>{await owner.drain();await ctx.fiber.dispose();});
 const handle=owner.spawn({argv:[process.execPath,'-e','setInterval(()=>{},1000)'],cwd:process.cwd(),graceMs:100,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}});
 await owner.drain();assert.equal(await handle.waitForExit(),true);assert.equal((await handle.done).signal!==null,true);assert.deepEqual(errors,[]);
});

test('real native terminal sessions drain through the same public ownership boundary',{timeout:15000},async t=>{
 const ctx=new Context();await ctx.plugin(LocalSubprocessRuntime,{});
 const errors=[],owner=new ExecutionOwner({spawn:spec=>ctx.subprocess.spawn(spec),spawnTerminal:spec=>ctx.subprocess.spawnTerminal(spec),onFailure:error=>errors.push(error)});
 let terminal,exited=false;
 t.after(async()=>{
  // Test-only cleanup owns the freshly returned terminal identity. A failed
  // provider drain must not strand this synthetic process or hide the assertion.
  if(terminal&&!exited){try{process.kill(-terminal.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}await terminal.done;}
  await ctx.fiber.dispose();
 });
 terminal=await owner.spawnTerminal({argv:[process.execPath,'-e','setInterval(()=>{},1000)'],cwd:process.cwd(),graceMs:100,rows:24,cols:80,terminalType:'xterm',shellActivity:true});
 void terminal.done.then(()=>{exited=true;},()=>{exited=true;});
 await owner.drain();await terminal.done;await terminal.terminate();assert.deepEqual(errors,[]);
});

test('native terminal cleanup rejection prevents settlement and keeps allocation closed',async()=>{
 const handle=terminalHandle();handle.terminate=async()=>{throw new Error('terminal cleanup failed; surviving child');};
 const owner=new ExecutionOwner({spawn:()=>processHandle(),spawnTerminal:async()=>handle,onFailure:()=>{}});
 await owner.spawnTerminal(terminalSpec);
 await assert.rejects(owner.drain(),/settlement could not be proven/);
 assert.throws(()=>owner.spawn({}),{code:'EXECUTION_CLOSING'});
});

test('pre-aborted requests never allocate or poison later settlement',async()=>{
 let attempts=0;const owner=new ExecutionOwner({spawn:()=>{attempts++;return processHandle();},spawnTerminal:async()=>{attempts++;return terminalHandle();},onFailure:()=>{}});
 const controller=new AbortController();controller.abort(new Error('Cancelled before admission'));
 assert.throws(()=>owner.spawn({signal:controller.signal}),/Cancelled before admission/);
 assert.throws(()=>owner.spawnTerminal({signal:controller.signal}),/Cancelled before admission/);
 await owner.drain();assert.equal(attempts,0);
});

test('guardian waits beyond foreground TERM grace for native KILL escalation and authenticates settlement',{timeout:15000},async t=>{
 const [{spawn},{mkdtemp,readFile,writeFile,rm},{tmpdir},{join},{fileURLToPath},{guardianIdentity,settleGuardian},{GuardianSettings},{setTimeout:delay}]=await Promise.all([
  import('node:child_process'),import('node:fs/promises'),import('node:os'),import('node:path'),import('node:url'),import('../harness/guardian-control.mjs'),import('../harness/settings.ts'),import('node:timers/promises'),
 ]);
 const root=await mkdtemp(join(tmpdir(),'polariton-native-guardian-')),identity=guardianIdentity(root);
 const limits={...GuardianSettings.parse({nativeDrainTimeoutMs:3000,termTimeoutMs:50,killTimeoutMs:1000,requestTimeoutMs:5000,pollMs:10}),maxFrameBytes:4096},nativeGraceMs=250;
 const readyPath=join(root,'ready.json'),outcomePath=join(root,'outcome.json'),hostPath=join(root,'host.json'),fixturePath=join(root,'native-owner.mjs');
 const target=`import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
 await writeFile(fixturePath,`
 import {Context} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/cordis'))};
 import OwnedSubprocessRuntime from ${JSON.stringify(new URL('../harness/execution.mjs',import.meta.url).href)};
 import {writeFileSync} from 'node:fs';
 const ctx=new Context();await ctx.plugin(OwnedSubprocessRuntime,{});
 writeFileSync(${JSON.stringify(hostPath)},JSON.stringify({pid:process.pid}));
 const handle=ctx.subprocess.spawn({argv:[process.execPath,'--input-type=module','--eval',${JSON.stringify(target)},${JSON.stringify(readyPath)}],cwd:process.cwd(),graceMs:${nativeGraceMs},stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}});
 void handle.done.then(outcome=>writeFileSync(${JSON.stringify(outcomePath)},JSON.stringify(outcome)));
 `);
 const child=spawn(process.execPath,[fileURLToPath(new URL('../harness/guardian.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();child.stdio[3].resume();
 let targetPid,hostPid,confirmed=false;
 t.after(async()=>{
  // Only these fresh synthetic identities authorize fallback test cleanup.
  // Production recovery uses the authenticated guardian receipt instead.
  if(!confirmed){
   if(targetPid)try{process.kill(targetPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
   if(hostPid)try{process.kill(-hostPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
   child.kill('SIGKILL');
  }
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.stdio[3].destroy();
  await rm(identity.socket,{force:true});await rm(root,{recursive:true,force:true});
 });
 const started=new Promise((resolve,reject)=>{child.on('message',message=>{if(message.type==='started')resolve(message);});child.once('error',reject);child.once('exit',()=>reject(new Error('Guardian ended before native fixture startup')));});
 child.send({identity,execution:'native',command:process.execPath,args:[fixturePath],cwd:root,env:{...process.env,POLARITON_MAX_FRAME_BYTES:String(limits.maxFrameBytes)},limits});
 await started;
 const deadline=performance.now()+limits.requestTimeoutMs;
 while(!targetPid){
  try{hostPid=JSON.parse(await readFile(hostPath,'utf8')).pid;targetPid=JSON.parse(await readFile(readyPath,'utf8')).pid;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(targetPid)break;
  if(performance.now()>=deadline)throw new Error('Native TERM-ignoring fixture did not start');
  await delay(limits.pollMs);
 }
 const before=performance.now();await settleGuardian(identity,limits,'native');confirmed=true;
 assert(performance.now()-before>limits.termTimeoutMs,'Native quiescence needs its own budget beyond foreground group TERM grace');
 const outcome=JSON.parse(await readFile(outcomePath,'utf8'));assert.equal(outcome.signal,'SIGKILL');
 assert.throws(()=>process.kill(targetPid,0),{code:'ESRCH'});
 await settleGuardian(identity,limits,'native');
 const receipt=JSON.parse(await readFile(join(identity.directory,'settled.json'),'utf8'));assert.equal(receipt.value.execution,'native');
});
