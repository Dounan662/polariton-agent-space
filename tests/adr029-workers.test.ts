import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentManager} from '../src/agents.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import type {ProviderSettings} from '../harness/providers.ts';

test('interrupted initial-worker creation recovers through ordinary creation and never resets later edits',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-uniform-workers-')));
  const config={...await loadConfig(),stateRoot:root,verification:false};
  const tree=new ResearchTree(config);await tree.initialize();
  let unavailable=true;
  const providers:Pick<ProviderSettings,'choices'|'currentDefault'|'currentRevision'|'withRuntime'>={
    currentRevision:0,
    currentDefault(){if(unavailable)throw new Error('Provider settings temporarily unavailable');return null;},
    async choices(){return [];},
    async withRuntime(){throw new Error('Provisioning must not activate a provider');},
  };
  const factory=()=>{throw new Error('Provisioning must not launch a harness');};
  let agents=new AgentManager(config,tree,async()=>false,factory,{providers});
  t.after(async()=>{await agents.close();await tree.close();await rm(root,{recursive:true,force:true});});
  const project=await tree.createProject(randomUUID(),'Uniform workers'),node=await tree.ensureMain(project.id);
  assert.throws(()=>agents.ensureInitialWorker(project.id,node),/Provider settings temporarily unavailable/);
  assert.equal(agents.initialWorkerId(project.id),null);
  assert.deepEqual(agents.list(project.id,node),[]);
  await agents.close();
  unavailable=false;
  agents=new AgentManager(config,tree,async()=>false,factory,{providers});await agents.initialize();
  const initial=agents.ensureInitialWorker(project.id,node);
  const peer=agents.create(project.id,node,randomUUID(),{title:'Worker'});
  assert.deepEqual(initial.creation.specification,peer.creation.specification);
  assert.equal(agents.initialWorkerId(project.id),initial.id);
  assert.equal(agents.overviewWorker(initial.id).state,'inactive');
  assert.equal(Object.hasOwn(agents.overviewWorker(initial.id),'designation'),false);
  assert.deepEqual(agents.overviewCoworkers(agents.overviewWorker(peer.id),'',10).items,[{id:initial.id,name:{text:'Worker',truncated:false},state:'inactive'}]);
  agents.rename(project.id,node,initial.id,'Research');agents.archive(project.id,node,initial.id,true);
  await agents.close();
  agents=new AgentManager(config,tree,async()=>false,factory,{providers});await agents.initialize();
  const restored=agents.ensureInitialWorker(project.id,node);
  assert.equal(restored.id,initial.id);assert.equal(restored.title,'Research');assert.equal(restored.archived,true);
  assert.equal(agents.list(project.id,node).length,2);
  assert.deepEqual(agents.overviewCoworkers(agents.overviewWorker(peer.id),'',10).items,[]);
  const other=randomUUID();
  await tree.mutate(project.id,{operationId:randomUUID(),revision:tree.graph(project.id).revision,command:{kind:'node.create',id:other,title:'Other',description:''}});
  assert.throws(()=>agents.ensureInitialWorker(project.id,other),{code:'INITIAL_WORKER_BINDING'});
  assert.equal(agents.initialWorkerId(project.id),initial.id);
  assert.deepEqual(agents.list(project.id,other),[]);
});
