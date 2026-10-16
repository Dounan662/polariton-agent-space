import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../src/config.ts';
import {ResearchTree} from '../src/research.ts';
import {AgentManager} from '../src/agents.ts';
import {ControlledHarness} from './fixtures/harness.ts';

async function until(ready:()=>boolean){const deadline=performance.now()+10000;while(!ready()){assert(performance.now()<deadline,'lifecycle fixture timed out');await delay(10);}}
for(const lostGuardian of [false,true])test(`Main restart ${lostGuardian?'retains unavailable guardian capacity and cleanup obligation':'reconciles authenticated guardian settlement without execution'}`,async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-guardian-agents-'))),config={...await loadConfig(),stateRoot:root,maxActiveWorkers:2};
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/guardian/agents.mjs',import.meta.url)),root],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='',guardianPid:number|undefined,pids:{pid:number}[]=[];
  let closeOwners=async()=>{};
  child.stderr!.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-config.maxFrameBytes);});
  child.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'guardianPid' in message&&typeof message.guardianPid==='number')guardianPid=message.guardianPid;});
  // Register ownership immediately: readiness failure must not orphan the very
  // processes this fixture exists to test. These are fresh fixture identities.
  t.after(async()=>{
    child.kill('SIGKILL');
    try{pids=(await readFile(join(root,'pids.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{}
    for(const {pid} of pids)try{process.kill(pid,'SIGKILL');}catch{}
    if(guardianPid)try{process.kill(guardianPid,'SIGKILL');}catch{}
    await closeOwners();
    await rm(root,{recursive:true,force:true});
  });
  const identity=await new Promise<{project:string;node:string;workerId:string;guardianPid:number}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Guardian AgentManager readiness timed out: '+stderr)),config.startupTimeoutMs);
    child.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'project' in message){clearTimeout(timer);resolve(message as {project:string;node:string;workerId:string;guardianPid:number});}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);reject(new Error(`Guardian AgentManager fixture exited before ready (${signal??code}): ${stderr}`));});
  });
  const deadline=performance.now()+5000;
  while(pids.length<3){assert(performance.now()<deadline);try{pids=(await readFile(join(root,'pids.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{}await delay(10);}
  if(lostGuardian)process.kill(identity.guardianPid,'SIGKILL');
  const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
  if(!lostGuardian)await delay(config.guardian.termTimeoutMs+config.guardian.killTimeoutMs);
  const tree=new ResearchTree(config);await tree.initialize();let launches=0;const harnesses:ControlledHarness[]=[];
  const agents=new AgentManager(config,tree,async()=>false,(settings,_home,_workspace,_budget,permission)=>{launches++;const h=new ControlledHarness(randomUUID(),permission,(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));harnesses.push(h);return h;},{catalog:{async choices(){return [];}}});
  closeOwners=async()=>{for(const h of harnesses)h.complete();await agents.close().catch(()=>{});await tree.close();};
  await agents.initialize();assert.equal(launches,0);
  const view=()=>agents.list(identity.project,identity.node).find(w=>w.id===identity.workerId)!;
  assert.equal(view().cleanupPending,lostGuardian);assert.equal(view().state,lostGuardian?'uncertain':'inactive');
  assert(!JSON.stringify(view()).includes('token'));
  if(lostGuardian){
    await assert.rejects(agents.closeWorker(identity.project,identity.node,identity.workerId),{code:'PROCESS_CLOSE_FAILED'});
    const worker=agents.create(identity.project,identity.node,randomUUID(), {title:'Remaining capacity'});await agents.submit(identity.project,identity.node,worker.id,{id:randomUUID(),text:'fixture'});await until(()=>harnesses.length===1);await harnesses[0]!.promptEntered.promise;
    const blocked=agents.create(identity.project,identity.node,randomUUID(), {title:'Beyond capacity'});await agents.submit(identity.project,identity.node,blocked.id,{id:randomUUID(),text:'fixture'});
    await until(()=>agents.list(identity.project,identity.node).find(w=>w.id===blocked.id)!.submissions[0]?.state==='failed');assert.equal(launches,1);
  }
});
