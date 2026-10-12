import {owner} from '../src/caller.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setImmediate as settle} from 'node:timers/promises';
import {AgentManager} from '../src/agents.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import type {HarnessPort} from '../harness/contracts.ts';

test('work waking during retained activation remains running while allowing checkpoint capture',{timeout:10000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-activation-work-'))),config={...await loadConfig(),stateRoot:root,workerIdleUnloadMs:null};
 const tree=new ResearchTree(config);await tree.initialize();
 const project=await tree.createProject(randomUUID(),'Scheduled activation'),node=await tree.ensureMain(project.id);
 class Awakening extends ControlledHarness{
  override async activate(sessionId:string|null,servers:Parameters<HarnessPort['activate']>[1]){
   const result=await super.activate(sessionId,servers);
   if(sessionId){this.status='running';this.emit('status',{sessionId,status:'running'});}
   return result;
  }
 }
 const harnesses:Awakening[]=[];
 const agents=new AgentManager(config,tree,async()=>false,(settings,home,_workspace,_budget,permission)=>{const h=new Awakening(`session-${basename(home)}`,permission,settings.model);harnesses.push(h);return h;});
 t.after(async()=>{harnesses.forEach(h=>h.complete());await agents.close();tree.close();await rm(root,{recursive:true,force:true});});
 const worker=agents.create(project.id,node,randomUUID(),{title:'Retained work'});
 await agents.submit(project.id,node,worker.id,{id:randomUUID(),text:'Initial task'});
 while(agents.get(worker.id).state!=='running')await settle();harnesses[0]!.complete();
 await agents.closeWorker(project.id,node,worker.id);
 const session=agents.get(worker.id).harnessSessionId;
 await agents.resume(project.id,node,worker.id);
 assert.equal(agents.get(worker.id).harnessSessionId,session);
 assert.equal(agents.get(worker.id).state,'running');
 await tree.checkpoint(project.id,node,randomUUID(), {publisher:owner});
 harnesses[1]!.complete();
 assert.equal(agents.get(worker.id).state,'idle');
 await tree.checkpoint(project.id,node,randomUUID(), {publisher:owner});
});
