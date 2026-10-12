import {testConfig} from './fixtures/config.ts';
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {InjectOptions} from 'fastify';
import {createApp} from '../src/main.ts';
import type {ProviderSnapshot} from '../harness/provider-contracts.ts';

const base='/api/settings/providers';
const secret='adr020-private-http-sentinel';
const definition={id:'http-fixture',kind:'custom',name:'Fixture',baseURL:'http://127.0.0.1:1/v1',protocol:'openai-completions',models:[{id:'fixture-model'}],keyless:false};

/** Real owner HTTP and local DSH storage, with no agent or network generation. */
async function browser(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'polariton-provider-web-'));
  const config={...await testConfig(root),stateRoot:root,verification:false};
  let runtime=await createApp(config,()=>assert.fail('Settings must not activate an agent'));
  t.after(async()=>{await runtime.app.close();await rm(root,{recursive:true,force:true});});
  await runtime.app.ready();
  const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;
  let cookie='';
  const request=(options:InjectOptions)=>runtime.app.inject({...options,headers:{host,origin,cookie,...options.headers}});
  const login=async()=>{
    const token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
    const response=await request({method:'POST',url:'/api/bootstrap',payload:{token}});
    assert.equal(response.statusCode,200);cookie=(response.headers['set-cookie'] as string).split(';')[0]!;
  };
  return {root,config,host,origin,request,login,get runtime(){return runtime;},get cookie(){return cookie;},
    async reopen(){await runtime.app.close();runtime=await createApp(config,()=>assert.fail('Settings must not activate an agent'));await runtime.app.ready();cookie='';await login();}};
}

test('provider settings require browser ownership and same-origin mutations',async t=>{
  const f=await browser(t);
  const admin=JSON.parse(await readFile(join(f.root,'application-admin.json'),'utf8')).token;
  for(const headers of [{},{authorization:`Bearer ${admin}`}]){
    assert.equal((await f.request({method:'GET',url:base,headers})).statusCode,401);
    assert.equal((await f.request({method:'POST',url:base+'/save',headers,payload:{...definition,apiKey:secret}})).statusCode,401);
  }
  await f.login();
  for(const suffix of ['/save','/remove','/default','/discover']){
    const response=await f.request({method:'POST',url:base+suffix,headers:{origin:'https://foreign.invalid'},payload:{apiKey:secret}});
    assert.equal(response.statusCode,403);assert(!response.body.includes(secret));
  }
  const missing=await f.runtime.app.inject({method:'POST',url:base+'/save',headers:{host:f.host,cookie:f.cookie},payload:{...definition,apiKey:secret}});
  assert.equal(missing.statusCode,403);
  const snapshot=await f.request({method:'GET',url:base});assert.equal(snapshot.statusCode,200);
  assert.equal(snapshot.headers['cache-control'],'no-store');assert.deepEqual(snapshot.json().providers,[]);
  const discovery=await f.request({method:'POST',url:base+'/discover',payload:{id:'deepseek-official'}});
  assert.equal(discovery.statusCode,200);assert(discovery.json().length>0);
  assert.equal((await f.request({method:'GET',url:base})).json().revision,snapshot.json().revision);
});

test('saving, replacing, removing and restarting preserve the write-only credential contract',async t=>{
  const f=await browser(t);await f.login();
  const saved=await f.request({method:'POST',url:base+'/save',payload:{...definition,apiKey:secret}});
  assert.equal(saved.statusCode,200,saved.body);assert(!saved.body.includes(secret));
  const snapshot=saved.json<ProviderSnapshot>();assert.equal(snapshot.providers[0]?.configured,true);
  const route=snapshot.choices[0]!.value;
  const selected=await f.request({method:'POST',url:base+'/default',payload:{route,revision:snapshot.revision}});
  assert.equal(selected.statusCode,200);assert.equal(selected.json().defaultRoute,route);
  const directory=join(f.root,'provider-settings');
  assert(!(await readFile(join(directory,'settings.json'),'utf8')).includes(secret));
  assert((await readFile(join(directory,'.credentials.yaml'),'utf8')).includes(secret));
  if(process.platform!=='win32'){
    assert.equal((await stat(directory)).mode&0o777,0o700);
    for(const file of ['settings.json','.credentials.yaml'])assert.equal((await stat(join(directory,file))).mode&0o777,0o600);
  }
  await f.reopen();
  const reloaded=await f.request({method:'GET',url:base});assert.equal(reloaded.statusCode,200);assert(!reloaded.body.includes(secret));assert.equal(reloaded.json().defaultRoute,route);
  const replacement=secret+'-replacement';
  const replaced=await f.request({method:'POST',url:base+'/save',payload:{...definition,apiKey:replacement,revision:reloaded.json().revision}});
  assert.equal(replaced.statusCode,200,replaced.body);assert(!replaced.body.includes(secret));
  const removedKey=await f.request({method:'POST',url:base+'/save',payload:{...definition,removeKey:true,revision:replaced.json().revision}});
  assert.equal(removedKey.statusCode,200);assert.equal(removedKey.json().providers[0].configured,false);assert.deepEqual(removedKey.json().choices,[]);
  assert(!(await readFile(join(directory,'.credentials.yaml'),'utf8')).includes(secret));
  const removed=await f.request({method:'POST',url:base+'/remove',payload:{id:definition.id,revision:removedKey.json().revision}});
  assert.equal(removed.statusCode,200);assert.deepEqual(removed.json().providers,[]);assert.equal(removed.json().defaultRoute,null);
});

test('settings diagnostics exclude submitted secrets and stale edits cannot overwrite settings',async t=>{
  const f=await browser(t);await f.login();
  const logs:unknown[]=[];
  f.runtime.app.log.warn=(...values:unknown[])=>{logs.push(values);};
  f.runtime.app.log.error=(...values:unknown[])=>{logs.push(values);};
  for(const payload of [{...definition,protocol:secret,apiKey:secret},{...definition,[secret]:true,apiKey:secret},{...definition,baseURL:`http://${secret}@127.0.0.1/v1`,apiKey:secret}]){
    const response=await f.request({method:'POST',url:base+'/save',payload});
    assert.equal(response.statusCode,400);assert(!response.body.includes(secret));
  }
  const saved=await f.request({method:'POST',url:base+'/save',payload:{...definition,apiKey:secret,revision:0}});assert.equal(saved.statusCode,200,saved.body);
  const conflict=await f.request({method:'POST',url:base+'/remove',payload:{id:definition.id,revision:0}});
  assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error.code,'SETTINGS_CONFLICT');
  assert.equal((await f.request({method:'GET',url:base})).json().providers.length,1);
  await writeFile(join(f.root,'provider-settings/settings.json'),secret);
  const unreadable=await f.request({method:'GET',url:base});assert.equal(unreadable.statusCode,503);assert(!unreadable.body.includes(secret));
  assert(!JSON.stringify(logs).includes(secret));
});

test('provider initialization failure releases application resources for retry',async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-provider-startup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config={...await testConfig(root),stateRoot:root,verification:false};
  const directory=join(root,'provider-settings');await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'settings.json'),'invalid settings');
  await assert.rejects(createApp(config),/Provider settings could not be read/);
  await rm(join(directory,'settings.json'));await chmod(directory,0o700);
  const retry=await createApp(config);await retry.app.close();
});
