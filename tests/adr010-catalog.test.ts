import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HarnessCatalog} from '../harness/catalog.ts';
import {Harness} from '../harness/client.ts';
import {loadConfig} from '../src/config.ts';
import {ProviderSettings} from '../harness/providers.ts';

for(const configured of [false,true])test(`pinned DSH ${configured?'advertises configured':'hides unconfigured'} models without an Agent, conversation, or provider request`,{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const providers=await ProviderSettings.open(join(root,'providers'),{discoveryTimeoutMs:1000,lockTimeoutMs:1000});t.after(()=>providers.close());
  if(configured)await providers.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-catalog-no-inference'});
  const config={...await loadConfig(),stateRoot:root,verification:true,startupTimeoutMs:15000,providerRuntime:await providers.runtime()};
  let hosts=0,requests=0;
  const catalog=new HarnessCatalog(config,(settings,home,workspace,_budget,permission)=>{hosts++;return new Harness(settings,home,workspace,async()=>{requests++;return false;},permission);});
  const [one,two]=await Promise.all([catalog.choices(),catalog.choices()]);await catalog.close();
  assert.deepEqual(one,two);
  if(configured)assert(one.some(model=>model.value===JSON.stringify([config.provider,config.model])),JSON.stringify(one));
  else assert.deepEqual(one,[]);
  assert.equal(requests,0);assert.equal(hosts,1);
  assert.deepEqual(await readdir(join(root,'catalog')),[]);
});
