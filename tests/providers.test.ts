import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import {credentialRef} from '@deepseek-ai/dsh-credentials';
import {ProviderSettings,ProviderSettingsError} from '../harness/providers.ts';
import {compose} from '../harness/composition.ts';
import {loadConfig} from '../src/config.ts';
import Llm from '@deepseek-ai/dsh-llm';
import * as Pi from '@deepseek-ai/dsh-llm-pi-ai';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';

const limits={discoveryTimeoutMs:100,lockTimeoutMs:1000};
async function fixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'polariton-provider-test-'));
  const settings=await ProviderSettings.open(directory,limits);
  t.after(async()=>{await settings.close();await rm(directory,{recursive:true,force:true});});
  return {directory,settings};
}
const hasCode=(code:string)=>(error:unknown)=>error instanceof ProviderSettingsError&&error.code===code;

test('fresh setup, replacement, removal and restart use one private store without exposing secrets',async t=>{
  const {directory,settings}=await fixture(t);
  const initial=await settings.snapshot();
  assert.equal(initial.defaultRoute,null);assert.deepEqual(initial.choices,[]);
  const first=await settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-first-key'});
  assert.equal(first.providers[0].credential.source,'file');
  assert.equal(first.providers[0].configured,true);
  const route=first.choices[0].value;
  await settings.setDefault(route);
  assert.equal(settings.currentDefault(),route);
  assert.equal(process.env.DEEPSEEK_API_KEY,undefined);
  const second=await settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-second-key'});
  const data=await readFile(join(directory,'settings.json'),'utf8');
  for(const secret of ['sentinel-first-key','sentinel-second-key']){
    assert.ok(!JSON.stringify(second).includes(secret));assert.ok(!data.includes(secret));assert.ok(!JSON.stringify(await settings.runtime()).includes(secret));
  }
  if(process.platform!=='win32'){
    assert.equal((await stat(directory)).mode&0o777,0o700);
    assert.equal((await stat(settings.credentialPath)).mode&0o777,0o600);
    assert.equal((await stat(join(directory,'settings.json'))).mode&0o777,0o600);
  }
  const resumed=await ProviderSettings.open(directory,limits);t.after(()=>resumed.close());
  assert.equal((await resumed.snapshot()).defaultRoute,route);
  assert.equal((await resumed.runtime()).deepseek,true);
  const removed=await resumed.save({id:'deepseek-official',kind:'builtin',removeKey:true});
  assert.equal(removed.providers[0].configured,false);assert.deepEqual(removed.choices,[]);
  assert.equal((await resumed.runtime()).deepseek,false);
  await resumed.remove('deepseek-official');
  assert.deepEqual((await resumed.snapshot()).providers,[]);
  assert.equal((await resumed.snapshot()).defaultRoute,null);
  assert.ok(!(await readFile(settings.credentialPath,'utf8')).includes('sentinel-second-key'));
});

test('unrelated concurrent edits survive and stale browser revisions reject',async t=>{
  const {directory,settings}=await fixture(t);
  const other=await ProviderSettings.open(directory,limits);t.after(()=>other.close());
  await Promise.all([
    settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-deepseek'}),
    other.save({id:'openai',kind:'builtin',apiKey:'sentinel-openai'}),
  ]);
  const snapshot=await settings.snapshot();
  assert.deepEqual(snapshot.providers.map(p=>p.id).sort(),['deepseek-official','openai']);
  const route=snapshot.choices[0].value;
  await other.setDefault(route);
  const observed=await settings.snapshot();
  assert.equal(settings.currentDefault(),route);
  assert.equal(settings.currentRevision,observed.revision);
  await assert.rejects(settings.save({id:'anthropic',kind:'builtin',apiKey:'sentinel-anthropic',revision:0}),hasCode('SETTINGS_CONFLICT'));
  assert.deepEqual((await settings.snapshot()).providers.map(p=>p.id).sort(),['deepseek-official','openai']);
});

test('explicit environment overrides are visible and reject ineffective edits',async t=>{
  const previous=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='sentinel-environment-key';
  t.after(()=>{if(previous===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previous;});
  const {settings}=await fixture(t);
  assert.deepEqual((await settings.snapshot()).catalog.find(p=>p.id==='anthropic')?.credential,{configured:true,source:'env',writable:false});
  const saved=await settings.save({id:'anthropic',kind:'builtin'});
  assert.deepEqual(saved.providers[0].credential,{configured:true,source:'env',writable:false});
  await assert.rejects(settings.save({id:'anthropic',kind:'builtin',apiKey:'sentinel-replacement'}),hasCode('READ_ONLY_CREDENTIAL'));
  await assert.rejects(settings.remove('anthropic'),hasCode('READ_ONLY_CREDENTIAL'));
  assert.ok(!JSON.stringify(saved).includes('sentinel-environment-key'));
});

test('worker credential snapshots remain frozen while future activations see replacement',async t=>{
  const {settings}=await fixture(t);
  await settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-before'});
  const active=new Context();t.after(()=>active.fiber.dispose());
  await settings.withRuntime(async runtime=>{await active.plugin(LocalCredentials,{path:runtime.credentialPath,watch:false});});
  await settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-after'});
  assert.equal((await active.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value,'sentinel-before');
  const next=new Context();t.after(()=>next.fiber.dispose());
  await settings.withRuntime(async runtime=>{await next.plugin(LocalCredentials,{path:runtime.credentialPath,watch:false});});
  assert.equal((await next.credentials.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value,'sentinel-after');
});

test('worker startup holds the mutation gate until credential snapshot loading completes',async t=>{
  const {settings}=await fixture(t);
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const launch=settings.withRuntime(async()=>{entered();await held;});
  await ready;
  let committed=false;
  const mutation=settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-gated'}).then(()=>{committed=true;});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(committed,false);
  release();await Promise.all([launch,mutation]);assert.equal(committed,true);
});

test('custom keyless routes have explicit authentication intent and no fabricated stored secret',async t=>{
  const {directory,settings}=await fixture(t);
  const saved=await settings.save({id:'custom-local',kind:'custom',name:'Local server',baseURL:'http://127.0.0.1:9000/v1',protocol:'openai-completions',models:[{id:'local-model'}],keyless:true});
  assert.equal(saved.providers[0].credential.source,'keyless');assert.equal(saved.providers[0].configured,true);
  const runtime=await settings.runtime();
  assert.equal(runtime.providers['custom-local'].apiKeyEnv,undefined);
  assert.equal(runtime.providers['custom-local'].headers?.Authorization,'Bearer local-keyless');
  assert.ok(!(await readFile(join(directory,'settings.json'),'utf8')).includes('Bearer'));
  await assert.rejects(settings.save({id:'custom-local',kind:'custom',baseURL:'file:///tmp/test',protocol:'openai-completions',models:[{id:'local'}],keyless:true}),hasCode('INVALID_ENDPOINT'));
  await assert.rejects(settings.save({id:'custom-local',kind:'custom',baseURL:'https://sentinel-secret@example.com/v1',protocol:'openai-completions',models:[{id:'local'}],keyless:true}),error=>!String(error).includes('sentinel-secret'));
});

test('discovery is bounded, cancellable and never reflects rejected credentials',async t=>{
  const {settings}=await fixture(t);
  t.mock.method(globalThis,'fetch',async (input:string,init:RequestInit)=>{
    if(input.endsWith('/ok/models'))return Response.json({data:[{id:'test-model'}]});
    if(input.endsWith('/reject/models'))return new Response('rejected sentinel-discovery-key',{status:401});
    return new Promise<Response>((_resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('test transport did not receive cancellation')),1000);
      const abort=()=>{clearTimeout(timer);reject(init.signal?.reason);};
      if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});
    });
  });
  const base='https://provider.invalid';
  const models=await settings.discover({baseURL:base+'/ok',protocol:'openai-completions',apiKey:'sentinel-discovery-key'});
  assert.equal(models[0].id,'test-model');assert.deepEqual((await settings.snapshot()).providers,[]);
  await assert.rejects(settings.discover({baseURL:base+'/reject',protocol:'openai-completions',apiKey:'sentinel-discovery-key'}),error=>hasCode('DISCOVERY_FAILED')(error)&&!String(error).includes('sentinel-discovery-key'));
  await assert.rejects(settings.discover({baseURL:base+'/slow',protocol:'openai-completions'}),hasCode('DISCOVERY_CANCELLED'));
  await assert.rejects(settings.discover({baseURL:base+'/slow',protocol:'openai-completions'},AbortSignal.abort()),hasCode('DISCOVERY_CANCELLED'));
});

test('invalid credential storage remains observable, never overwritten or included in errors',async t=>{
  const {settings}=await fixture(t);
  await writeFile(settings.credentialPath,'version: 1\nrefs:\n  BAD: [sentinel-corrupt-value\n',{mode:0o600});
  await assert.rejects(settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-retry'}),error=>error instanceof ProviderSettingsError&&!String(error).includes('sentinel-corrupt-value')&&!String(error).includes('sentinel-retry'));
  assert.ok((await readFile(settings.credentialPath,'utf8')).includes('sentinel-corrupt-value'));
});

test('partial credential failures disable the route durably and a retry repairs it',async t=>{
  const {directory,settings}=await fixture(t);
  await settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-original'});
  const revision=settings.currentRevision;
  const fail=t.mock.method(LocalCredentials.prototype,'set',async()=>{throw new Error('upstream failure with sentinel-replacement');});
  await assert.rejects(settings.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-replacement'}),error=>hasCode('CREDENTIAL_SAVE_FAILED')(error)&&!String(error).includes('sentinel-replacement'));
  assert.ok(settings.currentRevision>revision);
  assert.equal((await settings.snapshot()).providers[0].configured,false);
  assert.equal((await settings.runtime()).deepseek,false);
  const restarted=await ProviderSettings.open(directory,limits);t.after(()=>restarted.close());
  assert.equal((await restarted.snapshot()).providers[0].configured,false);
  await assert.rejects(restarted.save({id:'deepseek-official',kind:'builtin'}),hasCode('CREDENTIAL_UPDATE_REQUIRED'));
  fail.mock.restore();
  const repaired=await restarted.save({id:'deepseek-official',kind:'builtin',apiKey:'sentinel-replacement'});
  assert.equal(repaired.providers[0].configured,true);
});

test('worker startup errors retain their domain identity through the settings gate',async t=>{
  const {settings}=await fixture(t),failure=new Error('worker admission failed');
  await assert.rejects(settings.withRuntime(async()=>{throw failure;}),error=>error===failure);
});

test('composed adapters respect the application output budget and smaller model limits',async t=>{
  const config={...await loadConfig(),maxOutputTokens:1024};
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());
  const patches=await compose({...config,providerRuntime:{revision:1,credentialPath:'/private-fixture/.credentials.yaml',deepseek:true,deepseekConfig:{models:[{id:'deepseek-flash',maxTokens:4096},{id:'deepseek-v4-pro',maxTokens:512}]},providers:{'custom-fixture':{api:'openai-completions',baseURL:'https://provider.invalid/v1',models:[{id:'large',maxTokens:4096},{id:'small',maxTokens:512},{id:'default'}]}},defaultModel:null,choices:[]}},'/workspace');
  await ctx.plugin(Llm);
  const deepseek=patches.find(p=>'id' in p&&p.id==='llm-deepseek'),pi=patches.find(p=>'id' in p&&p.id==='llm-pi-ai');
  assert(deepseek&&'config' in deepseek);assert(pi&&'config' in pi);
  await ctx.plugin(DeepSeek,deepseek.config);
  await ctx.plugin(Pi,pi.config);
  for(const [provider,model,expected] of [['deepseek-official','deepseek-flash',1024],['deepseek-official','deepseek-v4-pro',512],['custom-fixture','large',1024],['custom-fixture','small',512],['custom-fixture','default',1024]] as const){
    assert.equal((await ctx.llm.resolveCallConfig({provider,model})).maxTokens,expected);
  }
});
