import {testConfig} from './fixtures/config.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {cp,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ResearchTree} from '../src/research.ts';
import {createApp} from '../src/main.ts';
import type {ProjectView} from '../src/contracts.ts';

async function temporaryDirectory(t:TestContext) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'polariton-adr007-recovery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}

for (const registration of ['complete','creating'] as const) {
test(`a copied ${registration} registry cannot recreate or mutate an unavailable external project`,async t=>{
  const root=await temporaryDirectory(t),stateRoot=join(root,'original-state'),copyRoot=join(root,'copied-state');
  await mkdir(stateRoot);
  const config={...await testConfig(root),stateRoot,verification:false};
  const original=new ResearchTree(config);
  let projectId:string,projectRoot:string;
  try {
    await original.initialize();
    const project=await original.createProject(randomUUID(),'External research',join(root,'external-project'));
    projectId=project.id;projectRoot=project.root;
    await original.mutate(projectId,{operationId:randomUUID(),revision:0,command:{kind:'node.create',id:randomUUID(),title:'Existing work',description:''}});
  } finally {original.close();}
  const graphPath=join(projectRoot,'.polariton/graph.jsonl'),before=await readFile(graphPath),nodes=await readdir(join(projectRoot,'nodes'));
  await cp(stateRoot,copyRoot,{recursive:true});
  if (registration === 'creating') {
    // Reproduce a durable creation intent whose filesystem publication preceded its receipt.
    const db=new DatabaseSync(join(copyRoot,'research.sqlite'));
    try {db.prepare("UPDATE projects SET registration='creating' WHERE id=?").run(projectId);}
    finally {db.close();}
  }
  await rename(projectRoot,projectRoot+'.away');
  const copy=new ResearchTree({...config,stateRoot:copyRoot});
  try {
    await copy.initialize();
    await assert.rejects(readdir(projectRoot),{code:'ENOENT'});
    assert.equal(copy.projects()[0]!.availability,'unavailable');
    await rename(projectRoot+'.away',projectRoot);
    await assert.rejects(copy.recoverProject(projectId),{code:'WORKSPACE_RELOCATED'});
    await assert.rejects(copy.ensureMain(projectId),{code:'WORKSPACE_RELOCATED'});
    assert.notEqual(copy.projects()[0]!.availability,'available');
    assert.equal(copy.mainNode(projectId),null);
    assert.deepEqual(await readFile(graphPath),before);
    assert.deepEqual(await readdir(join(projectRoot,'nodes')),nodes);
  } finally {copy.close();}
});
}

test('failed worker-storage initialization releases state and project ownership for same-process retry',async t=>{
  const root=await temporaryDirectory(t),config={...await testConfig(root),stateRoot:root,verification:false};
  const initial=await createApp(config);
  let projectId:string,mainNodeId:string,initialWorkerId:string;
  try {
    const project=await initial.tree.createProject(randomUUID(),'Recover startup');
    projectId=project.id;mainNodeId=await initial.tree.ensureMain(projectId);
    initialWorkerId=initial.agents.ensureInitialWorker(projectId,mainNodeId).id;
  } finally {await initial.app.close();}
  // A newer storage version is a supported rejection boundary; no private calls are replaced.
  const database=join(root,'agents.sqlite');
  let db=new DatabaseSync(database);const originalVersion=Number(db.prepare('PRAGMA user_version').get()!.user_version);db.exec('PRAGMA user_version=999');db.close();
  await assert.rejects(createApp(config),{code:'STORAGE_VERSION'});
  db=new DatabaseSync(database);db.exec(`PRAGMA user_version=${originalVersion}`);db.close();
  const recovered=await createApp(config);
  try {
    assert.equal(recovered.tree.projects()[0]!.availability,'available');
    assert.equal(await recovered.tree.ensureMain(projectId),mainNodeId);
    assert.equal(recovered.agents.ensureInitialWorker(projectId,mainNodeId).id,initialWorkerId);
  } finally {await recovered.app.close();}
});

for (const missing of ['node workspace','project root'] as const) {
test(`missing ${missing} blocks initialization and restores the same default identities when returned`,async t=>{
  const root=await temporaryDirectory(t),config={...await testConfig(root),stateRoot:root,verification:false};
  let starts=0;
  const harness=()=>{starts++;throw new Error('Default recovery activated execution');};
  const initial=await createApp(config,harness);
  let projectId:string,mainNodeId:string,initialWorkerId:string,workspace:string,graphPath:string,projectRoot:string;
  try {
    const project=await initial.tree.createProject(randomUUID(),'Missing default');
    projectId=project.id;mainNodeId=await initial.tree.ensureMain(projectId);
    initialWorkerId=initial.agents.ensureInitialWorker(projectId,mainNodeId).id;
    projectRoot=project.root;workspace=initial.tree.workspace(projectId,mainNodeId);graphPath=join(projectRoot,'.polariton/graph.jsonl');
  } finally {await initial.app.close();}
  const before=await readFile(graphPath);
  const displaced=missing==='project root'?projectRoot:workspace;
  await rename(displaced,displaced+'.away');
  const recovered=await createApp(config,harness);
  try {
    await recovered.app.ready();
    const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;
    const token=new URLSearchParams(new URL(recovered.launchUrl).hash.slice(1)).get('token');
    const login=await recovered.app.inject({method:'POST',url:'/api/bootstrap',headers:{host,origin},payload:{token}});
    assert.equal(login.statusCode,200);
    const cookie=String(login.headers['set-cookie']).split(';')[0]!;
    const response=await recovered.app.inject({method:'GET',url:'/api/projects',headers:{host,origin,cookie}});
    assert.equal(response.statusCode,200);
    const project=response.json<ProjectView[]>()[0]!;
    assert.equal(project.initialization.state,'blocked');
    assert.ok(project.initialization.detail);
    assert.equal(project.mainNodeId,mainNodeId);assert.equal(project.initialWorkerId,initialWorkerId);
    await assert.rejects(recovered.tree.ensureMain(projectId));
    await assert.rejects(readdir(workspace),{code:'ENOENT'});
    await rename(displaced+'.away',displaced);
    const retry=await recovered.app.inject({method:'POST',url:`/api/projects/${projectId}/initialize`,headers:{host,origin,cookie}});
    assert.equal(retry.statusCode,200);
    const restored=retry.json<ProjectView>();
    assert.equal(restored.initialization.state,'ready');
    assert.equal(restored.mainNodeId,mainNodeId);assert.equal(restored.initialWorkerId,initialWorkerId);
    assert.deepEqual(await readFile(graphPath),before);assert.equal(starts,0);
  } finally {await recovered.app.close();}
});
}
