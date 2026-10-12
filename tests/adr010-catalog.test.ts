import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HarnessCatalog} from '../harness/catalog.ts';
import {Harness} from '../harness/client.ts';
import {loadConfig} from '../src/config.ts';

test('pinned DSH advertises models without an Agent, conversation, or provider request',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config={...await loadConfig(),stateRoot:root,verification:true,startupTimeoutMs:15000};
  let hosts=0,requests=0;
  const catalog=new HarnessCatalog(config,(settings,home,workspace,_budget,permission)=>{hosts++;return new Harness(settings,home,workspace,async()=>{requests++;return false;},permission);});
  const [one,two]=await Promise.all([catalog.choices(),catalog.choices()]);await catalog.close();
  assert.deepEqual(one,two);assert(one.some(model=>model.value===JSON.stringify([config.provider,config.model])));
  assert(one.length>=2);assert.equal(requests,0);assert.equal(hosts,1);
  assert.deepEqual(await readdir(join(root,'catalog')),[]);
});
