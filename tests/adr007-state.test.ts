import {testConfig} from './fixtures/config.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../src/main.ts';
import {projectName,projectRequest} from '../web/src/projects.ts';
import {VerificationBudget} from '../harness/budget.mjs';

function storage():Storage {const values=new Map<string,string>();return {get length(){return values.size;},clear(){values.clear();},getItem(key){return values.get(key)??null;},key(index){return [...values.keys()][index]??null;},removeItem(key){values.delete(key);},setItem(key,value){values.set(key,value);}};}

test('creation retries reuse their persisted identity without altering other worker state',()=>{
 const saved=storage();
 for(const key of ['draft','images','pending','reading'])saved.setItem(`polariton.${key}.worker-id`,key);
 const first=projectRequest(saved,'/tmp/project');
 assert.deepEqual(projectRequest(saved,'/tmp/project'),first);
 for(const key of ['draft','images','pending','reading'])assert.equal(saved.getItem(`polariton.${key}.worker-id`),key);
 assert.notEqual(projectRequest(saved,'/tmp/other').id,first.id);
 saved.setItem('polariton.pendingProject','invalid JSON');
 assert.equal(projectRequest(saved,'/tmp/project').name,'project');
});

for(const [database,version] of [['research.sqlite',0],['research.sqlite',3],['agents.sqlite',0],['agents.sqlite',5],['agents.sqlite',6],['agents.sqlite',7],['agents.sqlite',8]] as const) {
 test(`${database} rejects incompatible format ${version} without converting or deleting it`,async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'polariton-storage-format-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,database),db=new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retained')");db.exec(`PRAGMA user_version=${version}`);db.close();
  const original=await readFile(path),config={...await testConfig(root),stateRoot:root,verification:false};
  await assert.rejects(createApp(config),{code:'STORAGE_VERSION'});
  assert.deepEqual(await readFile(path),original);
  const preserved=new DatabaseSync(path,{readOnly:true});
  try {assert.equal(preserved.prepare('SELECT value FROM unrelated').get()!.value,'retained');assert.equal(preserved.prepare('PRAGMA user_version').get()!.user_version,version);}
  finally {preserved.close();}
  // The operator can choose fresh storage without recovering the incompatible database.
  const runtime=await createApp({...config,stateRoot:join(root,'fresh')},()=>{throw new Error('Storage initialization activated execution');});
  await runtime.app.close();
 });
}

test('primary and corrective verification share durable request accounting and preserve reserved capacity',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'polariton-adr007-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'ledger.sqlite'),limits={maxRequests:4,maxLiveMs:60000,reserveRequests:2,reserveMs:30000};
 const primary=new VerificationBudget(path,limits);assert.equal(primary.reserve(),true);assert.equal(primary.reserve(),true);assert.equal(primary.reserve(),false);assert.equal(primary.close()!.requests,2);
 const rerun=new VerificationBudget(path,{...limits,reserveRequests:0,reserveMs:0});assert.equal(rerun.reserve(),true);assert.equal(rerun.reserve(),true);assert.equal(rerun.reserve(),false);assert.equal(rerun.close()!.requests,4);
});

 test('folder names become project names across host path conventions',()=>{
  assert.equal(projectName('/research/Ultrafast spectroscopy/'),'Ultrafast spectroscopy');
  assert.equal(projectName('C:\\research\\Spectroscopy'),'Spectroscopy');
  assert.equal(projectName('/'),'Research project');
 });
