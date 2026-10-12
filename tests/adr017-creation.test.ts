import {testConfig} from './fixtures/config.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AgentManager} from '../src/agents.ts';
import type {HarnessPort,HarnessFactory} from '../harness/contracts.ts';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import {owner} from '../src/caller.ts';
import type {Actor} from '../src/caller.ts';
import type {WorkerCreate,WorkerView} from '../src/contracts.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import {createApp} from '../src/main.ts';

async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr017-create-')));
 const config={...await testConfig(root),stateRoot:root,sharedSkillsDir:join(root,'skills'),verification:false};
 const tree=new ResearchTree(config);await tree.initialize();
 const project=await tree.createProject(randomUUID(),'Worker instructions'),node=await tree.ensureMain(project.id);
 let didLaunch!:()=>void;const launched=new Promise<void>(resolve=>{didLaunch=resolve;});
 const launches:{instructions:string|undefined;sharedSkillsDir:string|undefined;model:string;harness:ControlledHarness}[]=[];
 const factory:HarnessFactory=(settings,home,_cwd,_budget,permission)=>{
  const harness=new ControlledHarness(`session-${basename(home)}`,permission,(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model));
  launches.push({instructions:settings.workerInstructions,sharedSkillsDir:settings.sharedSkillsDir,model:(settings.selectedModel?JSON.parse(settings.selectedModel)[1] as string:settings.model),harness});didLaunch();return harness;
 };
 let agents=new AgentManager(config,tree,async()=>false,factory);
 t.after(async()=>{for(const launch of launches)launch.harness.complete();await agents.close();tree.close();await rm(root,{recursive:true,force:true});});
 return {root,config,tree,project:project.id,node,launches,launched,get agents(){return agents;},async restart(){await agents.close();agents=new AgentManager(config,tree,async()=>false,factory);await agents.initialize();}};
}

/** The owner contract persists one creation specification independently of later configuration. */
test('creation snapshots instructions and initial choices without launching or reading the source again',async t=>{
 const f=await fixture(t),id=randomUUID(),requestId=randomUUID(),creator:Actor={kind:'worker',id:randomUUID(),processId:randomUUID()};
 const sourcePath=join(f.root,'role.md'),text='Analyze controls. Keep {{literal}}.\n研究';await writeFile(sourcePath,text);
 const input:WorkerCreate={title:'Scientist',model:JSON.stringify(['deepseek-official','deepseek-flash']),environment:{environmentId:'tools',revisionId:'revision-a',name:'Lab tools'},systemPrompt:{sourcePath,text:await readFile(sourcePath,'utf8')}};
 const worker=f.agents.create(f.project,f.node,id,input,{requestId,creator});
 assert.equal(worker.state,'inactive');assert.equal(worker.harnessSessionId,null);assert.equal(f.launches.length,0);
 assert.deepEqual(worker.creation.specification,input);assert.deepEqual(worker.creation.creator,creator);assert.equal(worker.creation.requestId,requestId);
 assert.equal(worker.creation.instructionDigest,createHash('sha256').update(text).digest('hex'));
 assert.equal(worker.model,input.model);assert.deepEqual(worker.environment.selection,input.environment);
 f.agents.rename(f.project,f.node,id,'Renamed');
 await writeFile(sourcePath,'Changed role');await rm(sourcePath);await f.restart();
 const restored=f.agents.list(f.project,f.node).find(value=>value.id===id)!;
 assert.deepEqual(restored.creation,worker.creation);assert.equal(restored.title,'Renamed');assert.equal(f.launches.length,0);
 assert.equal(f.agents.create(f.project,f.node,id,input,{requestId,creator}).id,id);
 assert.throws(()=>f.agents.create(f.project,f.node,id,{...input,systemPrompt:{sourcePath,text:'Changed role'}},{requestId,creator}),/different creation specification/);
});

test('creation request retries retain the original result across rename and restart',async t=>{
 const f=await fixture(t),id=randomUUID(),requestId=randomUUID(),input:WorkerCreate={title:'Original',systemPrompt:{sourcePath:'/captured/role.md',text:'Immutable role'}};
 const create=()=>f.agents.editRequest(requestId,owner,'worker.create',input,()=>f.agents.create(f.project,f.node,id,input,{requestId,creator:owner}));
 const first=create();assert.equal(first.state,'succeeded');
 f.agents.rename(f.project,f.node,id,'Later title');assert.deepEqual(create(),first);
 await f.restart();assert.deepEqual(create(),first);assert.equal(f.agents.list(f.project,f.node).length,1);
 assert.throws(()=>f.agents.editRequest(requestId,owner,'worker.create',{...input,title:'Changed'},()=>{throw new Error('Must not run');}),/different input or caller/);
 assert.equal(f.launches.length,0);
});

test('every activation restores captured instructions and shared skill configuration', {timeout:10000},async t=>{
 const f=await fixture(t),id=randomUUID(),text='Initial worker {{role}}',sourcePath=join(f.root,'role.md');await writeFile(sourcePath,text);
 const created=f.agents.create(f.project,f.node,id,{title:'Restartable',systemPrompt:{sourcePath,text}});
 await f.agents.submit(f.project,f.node,id,{id:randomUUID(),text:'First task'});
 // The public harness barrier distinguishes admitted input from merely scheduled startup.
 await f.launched;
 await f.launches[0]!.harness.promptEntered.promise;f.launches[0]!.harness.complete();
 await f.agents.closeWorker(f.project,f.node,id);await rm(sourcePath);await f.restart();
 await f.agents.resume(f.project,f.node,id);
 assert.equal(f.launches.length,2);
 for(const launch of f.launches){assert.equal(launch.instructions,text);assert.equal(launch.sharedSkillsDir,f.config.sharedSkillsDir);assert.equal(launch.model,f.config.model);}
 assert.deepEqual(f.agents.list(f.project,f.node)[0]!.creation,created.creation);
});

test('owner rejects oversized, malformed Unicode and invalid model instructions before persistence',async t=>{
 const f=await fixture(t);
 for(const input of [
  {title:'Oversized',systemPrompt:{sourcePath:'/role.md',text:'λ'.repeat(f.config.maxWorkerPromptBytes)}},
  {title:'Malformed',systemPrompt:{sourcePath:'/role.md',text:'\ud800'}},
  {title:'Malformed route',model:JSON.stringify(['provider'])},
 ])assert.throws(()=>f.agents.create(f.project,f.node,randomUUID(),input));
 assert.equal(f.agents.list(f.project,f.node).length,0);assert.equal(f.launches.length,0);
});

test('title-only browser creation exposes immutable provenance and rejects caller-forged provenance',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr017-browser-'))),config={...await testConfig(root),stateRoot:root,verification:false};
 let launches=0;const runtime=await createApp(config,()=>{launches++;throw new Error('Read-only inspection launched execution');});await runtime.app.ready();
 t.after(async()=>{await runtime.app.close();await rm(root,{recursive:true,force:true});});
 const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;
 const token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
 const login=await runtime.app.inject({method:'POST',url:'/api/bootstrap',headers:{host,origin},payload:{token}}),cookie=String(login.headers['set-cookie']).split(';')[0]!;
 const request=(method:'GET'|'POST',url:string,payload?:object)=>runtime.app.inject({method,url,headers:{host,origin,cookie},...(payload?{payload}:{})});
 const project=(await request('POST','/api/projects',{id:randomUUID(),name:'Browser'})).json<{id:string;mainNodeId:string}>(),base=`/api/projects/${project.id}/nodes/${project.mainNodeId}/workers`,id=randomUUID();
 const response=await request('POST',base,{id,title:'Browser worker'});assert.equal(response.statusCode,200,response.body);
 const worker=response.json<WorkerView>();assert.equal(worker.state,'inactive');assert.deepEqual(worker.creation.creator,owner);assert.equal(worker.creation.specification.title,'Browser worker');assert.equal(worker.creation.instructionDigest,null);
 const retry=await request('POST',base,{id,title:'Browser worker'});assert.equal(retry.statusCode,200,retry.body);assert.deepEqual(retry.json<WorkerView>().creation,worker.creation);
 const inspected=(await request('GET',base)).json<WorkerView[]>().find(value=>value.id===id)!;assert.deepEqual(inspected.creation,worker.creation);
 const forged=await request('POST',base,{id:randomUUID(),title:'Forged',creator:{kind:'worker',id:randomUUID(),processId:randomUUID()}});assert.equal(forged.statusCode,400,forged.body);
 assert.equal(launches,0);
});

test('failed creation transaction leaves neither a worker nor a successful receipt',async t=>{
 const f=await fixture(t),id=randomUUID(),requestId=randomUUID(),input={title:'Atomic creation'};
 assert.throws(()=>f.agents.editRequest(requestId,owner,'worker.create',input,()=>{
  f.agents.create(f.project,f.node,id,input,{requestId,creator:owner});
  throw new Error('Controlled failure before committing the creation receipt');
 }),/Controlled failure/);
 assert.equal(f.agents.list(f.project,f.node).length,0);
 await f.restart();
 const retried=f.agents.editRequest(requestId,owner,'worker.create',input,()=>f.agents.create(f.project,f.node,id,input,{requestId,creator:owner}));
 assert.equal(retried.state,'succeeded');assert.equal(f.agents.list(f.project,f.node).length,1);assert.equal(f.launches.length,0);
});

test('shared skill paths resolve against the config file and idle policy defaults are typed',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr017-config-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const original=JSON.parse(await readFile(new URL('../config/app.json',import.meta.url),'utf8')) as Record<string,unknown>;
 delete original.sharedSkillsDir;delete original.workerIdleUnloadMs;delete original.maxWorkerPromptBytes;
 const path=join(root,'app.json'),write=async(extra:Record<string,unknown>)=>{await writeFile(path,JSON.stringify({...original,stateRoot:'state',...extra}));return loadConfig(path);};
 const defaults=await write({});assert.equal(defaults.sharedSkillsDir,join(root,'state','skills'));assert.equal(defaults.workerIdleUnloadMs,360000);assert.equal(defaults.maxWorkerPromptBytes,262144);
 const explicit=await write({sharedSkillsDir:'../common-skills',workerIdleUnloadMs:null,maxWorkerPromptBytes:128});
 assert.equal(explicit.sharedSkillsDir,join(root,'..','common-skills'));assert.equal(explicit.workerIdleUnloadMs,null);assert.equal(explicit.maxWorkerPromptBytes,128);
 for(const value of [0,-1,1.5,2147483648])await assert.rejects(write({workerIdleUnloadMs:value}));
});
