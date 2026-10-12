import {testConfig} from './fixtures/config.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,writeFile,mkdir,rename,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ResearchTree} from '../src/research.ts';
import {AgentManager} from '../src/agents.ts';
import {createApp} from '../src/main.ts';
import type {Graph,ProjectView,WorkerView} from '../src/contracts.ts';

async function fixture(t:TestContext){
 const root=await mkdtemp(join(await realpath(tmpdir()),'polariton-adr007-test-'));
 const config={...await testConfig(root),stateRoot:root,verification:false};
 let tree=new ResearchTree(config);await tree.initialize();
 let starts=0;let agents=new AgentManager(config,tree,async()=>{throw new Error('Provisioning spent budget');},()=>{starts++;throw new Error('Provisioning launched harness');});
 t.after(async()=>{await agents.close();tree.close();await rm(root,{recursive:true,force:true});});
 return {root,config,get tree(){return tree;},get agents(){return agents;},get starts(){return starts;},async restart(){await agents.close();tree.close();tree=new ResearchTree(config);await tree.initialize();agents=new AgentManager(config,tree,async()=>false,()=>{starts++;throw new Error('Restart launched harness');});}};
}

test('default identities survive parallel retry, title collisions, rename, archive and restart without execution',async t=>{
 const f=await fixture(t),project=await f.tree.createProject(randomUUID(),'Research');
 const collision=randomUUID();await f.tree.mutate(project.id,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:collision,title:'main',description:''}});
 const nodes=await Promise.all(Array.from({length:4},()=>f.tree.ensureMain(project.id)));
 assert.equal(new Set(nodes).size,1);const node=nodes[0]!;assert.notEqual(node,collision);
 const existing=f.agents.create(project.id,node,randomUUID(), {title:'Worker'});
 const initial=f.agents.ensureInitialWorker(project.id,node);assert.notEqual(initial.id,existing.id);
 assert.equal('role' in initial,false);assert.equal(initial.title,'Worker');assert.equal(initial.creation.specification.systemPrompt,undefined);assert.equal(initial.state,'inactive');assert.equal(initial.harnessSessionId,null);
 f.agents.rename(project.id,node,initial.id,'Coordinator');f.agents.archive(project.id,node,initial.id,true);
 await f.tree.mutate(project.id,{operationId:randomUUID(),revision:f.tree.graph(project.id).revision,command:{kind:'node.edit',id:node,title:'Headquarters',description:'Renamed'}});
 await f.tree.mutate(project.id,{operationId:randomUUID(),revision:f.tree.graph(project.id).revision,command:{kind:'node.archive',id:node,archived:true}});
 await f.restart();assert.equal(await f.tree.ensureMain(project.id),node);
 const restored=f.agents.ensureInitialWorker(project.id,node);assert.equal(restored.id,initial.id);assert.equal(restored.title,'Coordinator');assert.equal(restored.archived,true);
 assert.equal(f.tree.graph(project.id).nodes.length,2);assert.equal(f.agents.list(project.id,node).length,2);assert.equal(f.starts,0);
 assert.equal(f.agents.archive(project.id,node,initial.id,false).id,initial.id);
});

test('main provisioning failure can retry after unrelated graph progress without changing intended identity',async t=>{
 const f=await fixture(t),project=await f.tree.createProject(randomUUID(),'Recovery');
 const nodes=join(project.root,'nodes');await rm(nodes,{recursive:true});await writeFile(nodes,'blocked');
 await assert.rejects(f.tree.ensureMain(project.id));const intended=f.tree.mainNode(project.id);assert.ok(intended);
 await rm(nodes);await mkdir(nodes);
 await f.tree.mutate(project.id,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:randomUUID(),title:'Other work',description:''}});
 assert.equal(await f.tree.ensureMain(project.id),intended);
 assert.equal(f.tree.graph(project.id).nodes.length,2);
});

test('project rename persists without moving files, changing defaults or invalidating creation retries',async t=>{
 const f=await fixture(t),id=randomUUID(),project=await f.tree.createProject(id,'Folder name');
 const node=await f.tree.ensureMain(id),initial=f.agents.ensureInitialWorker(id,node);
 const renamed=f.tree.renameProject(id,'  Research title  ');
 assert.equal(renamed.name,'Research title');assert.equal(renamed.root,project.root);
 assert.equal((await f.tree.createProject(id,'Folder name')).name,'Research title');
 assert.throws(()=>f.tree.renameProject(id,'  '));
 assert.throws(()=>f.tree.renameProject(randomUUID(),'Missing'),{code:'PROJECT_NOT_FOUND'});
 await f.restart();
 assert.equal(f.tree.projects()[0]!.name,'Research title');assert.equal(f.tree.projects()[0]!.root,project.root);
 assert.equal(await f.tree.ensureMain(id),node);assert.equal(f.agents.ensureInitialWorker(id,node).id,initial.id);assert.equal(f.starts,0);
});

test('unavailable project preserves provisioning identity and recovers original identities when directory returns',async t=>{
 const f=await fixture(t),project=await f.tree.createProject(randomUUID(),'Offline');
 const node=await f.tree.ensureMain(project.id),initial=f.agents.ensureInitialWorker(project.id,node);
 await rename(project.root,project.root+'.away');await f.restart();
 assert.equal(f.tree.projects()[0]!.availability,'unavailable');await assert.rejects(f.tree.ensureMain(project.id));assert.equal(f.tree.mainNode(project.id),node);
 await rename(project.root+'.away',project.root);assert.equal(await f.tree.ensureMain(project.id),node);assert.equal(f.agents.ensureInitialWorker(project.id,node).id,initial.id);assert.equal(f.starts,0);
});

test('HTTP project creation and retry initialize exactly one pair and reject conflicting request identity',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'polariton-adr007-http-')),config={...await testConfig(root),stateRoot:root,verification:false};
 const runtime=await createApp(config,()=>{throw new Error('Creation activated a harness');});await runtime.app.ready();
 t.after(async()=>{await runtime.app.close();await rm(root,{recursive:true,force:true});});
 const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;
 const token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
 const login=await runtime.app.inject({method:'POST',url:'/api/bootstrap',headers:{host,origin},payload:{token}});
 const cookie=String(login.headers['set-cookie']).split(';')[0]!;
 const request=(method:'GET'|'POST',url:string,payload?:unknown)=>runtime.app.inject({method,url,headers:{host,origin,cookie},...(payload===undefined?{}:{payload:payload as object})});
 const input={id:randomUUID(),name:'Retry'};
 const responses=await Promise.all(Array.from({length:3},()=>request('POST','/api/projects',input)));
 for(const response of responses)assert.equal(response.statusCode,200,response.body);
 const views=responses.map(response=>response.json<ProjectView>()),p=views[0]!;
 for(const value of views){assert.equal(value.mainNodeId,p.mainNodeId);assert.equal(value.initialWorkerId,p.initialWorkerId);assert.equal(value.initialization.state,'ready');}
 assert.equal((await request('POST','/api/projects',{...input,name:'Different'})).statusCode,409);
 assert.equal((await request('POST',`/api/projects/${p.id}/initialize`)).json<ProjectView>().initialWorkerId,p.initialWorkerId);
 assert.equal((await request('GET',`/api/projects/${p.id}/graph`)).json<Graph>().nodes.length,1);
 const workers=(await request('GET',`/api/projects/${p.id}/nodes/${p.mainNodeId}/workers`)).json<WorkerView[]>();assert.equal(workers.length,1);assert.equal(workers[0]!.state,'inactive');assert.equal(workers[0]!.id,p.initialWorkerId);assert.equal('role' in workers[0]!,false);assert.equal(workers[0]!.creation.specification.systemPrompt,undefined);
 assert.equal((await request('POST',`/api/projects/${p.id}/rename`,{name:'Renamed research'})).statusCode,200);
 assert.equal((await request('GET','/api/projects')).json<ProjectView[]>()[0]!.name,'Renamed research');
 const retried=(await request('POST','/api/projects',input)).json<ProjectView>();
 assert.equal(retried.name,'Renamed research');assert.equal(retried.mainNodeId,p.mainNodeId);assert.equal(retried.initialWorkerId,p.initialWorkerId);
 assert.equal((await request('POST',`/api/projects/${p.id}/rename`,{name:' '})).statusCode,400);
});
