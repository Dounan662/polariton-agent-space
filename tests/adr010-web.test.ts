import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {InjectOptions} from 'fastify';
import {createApp} from '../src/main.ts';
import {loadConfig} from '../src/config.ts';
import {ControlledHarness} from './fixtures/harness.ts';

const observedAt='2026-09-24T00:00:00Z';
const choices=['first','second'].map(environmentId=>({environment:{environmentId,revisionId:'r1',name:environmentId},observedAt}));
const revision={format:2,environmentId:'second',name:'second',description:'',components:[],revisionId:'r1',baseRevisionId:null,createdAt:observedAt,operationId:'publication'};
const inventory=()=>({capabilities:[],releases:[],environments:[],preparations:[],mounts:[],realizations:[],activeRealizations:{},operations:[],observations:[],bindings:[]});

/** A real authenticated Main HTTP boundary with an independently controlled local daemon. */
async function browser(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'polariton-adr010-web-'))),socket=join(tmpdir(),`polariton-${randomUUID()}.sock`);
  const responses=new Map<string,unknown>([['/v1/inventory',inventory()],['/v1/access/choices',choices],['/v1/revisions/second/r1',revision]]);
  const calls:string[]=[],harnesses:ControlledHarness[]=[];
  const rack=createServer((request,response)=>{
    calls.push(request.url!);response.setHeader('content-type','application/json');
    if(request.headers.authorization!=='Bearer synthetic-admin'){response.statusCode=401;response.end('{}');return;}
    response.end(JSON.stringify(responses.get(request.url!)??{}));
  });
  await new Promise<void>((resolve,reject)=>{rack.once('error',reject);rack.listen(socket,resolve);});
  await mkdir(join(root,'rack'));await writeFile(join(root,'rack/admin.json'),JSON.stringify({token:'synthetic-admin'}));
  await writeFile(join(root,'environment.json'),JSON.stringify({stateRoot:join(root,'rack'),socketPath:socket}));
  const config={...await loadConfig(),stateRoot:join(root,'app'),verification:false,environmentConfig:join(root,'environment.json')};
  const runtime=await createApp(config,(settings,_home,_workspace,_budget,permission)=>{
    class CatalogHarness extends ControlledHarness{
      override async models(){this.calls.push({method:'models',params:{}});return [{value:JSON.stringify([settings.provider,settings.model]),name:settings.model,image:false}];}
    }
    const harness=new CatalogHarness(randomUUID(),permission,settings.model);harnesses.push(harness);return harness;
  });
  t.after(async()=>{await runtime.app.close();await new Promise<void>(resolve=>rack.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await runtime.app.ready();const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;let cookie='';
  const request=(options:InjectOptions)=>runtime.app.inject({...options,headers:{host,origin,cookie,...options.headers}});
  const token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
  const authenticated=await request({method:'POST',url:'/api/bootstrap',payload:{token}});assert.equal(authenticated.statusCode,200);
  cookie=(authenticated.headers['set-cookie'] as string).split(';')[0]!;
  return {request,responses,calls,harnesses};
}

test('browser inventory projects resource facts and excludes grant hashes, transports and access journals',async t=>{
  const b=await browser(t);
  b.responses.set('/v1/inventory',{...inventory(),access:[{secret:'private-access-journal'}],bindings:[{id:'grant',mountId:'mount',generation:'generation',principal:'worker',access:'call',released:false,hash:'private-binding-hash',headers:[{name:'Authorization',value:'Bearer private-grant'}]}],operations:[{id:'grant',command:{kind:'binding.create',operationId:'grant',mountId:'mount',principal:'worker',access:'call'},state:'succeeded',error:null,result:{url:'http://private',headers:[{name:'Authorization',value:'Bearer private-grant'}]}}]});
  const response=await b.request({method:'GET',url:'/api/environment/inventory'});assert.equal(response.statusCode,200);
  assert(!response.body.includes('private-'));assert(!Object.hasOwn(response.json(),'access'));assert.equal(response.json().operations[0].result,null);
  assert.deepEqual(response.json().bindings[0],{id:'grant',mountId:'mount',generation:'generation',principal:'worker',access:'call',released:false});
});

test('browser grant creation and release are denied before contacting EnvironmentDaemon',async t=>{
  const b=await browser(t);
  for(const command of [{kind:'binding.create',operationId:'grant',mountId:'mount',principal:'worker',access:'call'},{kind:'binding.release',operationId:'release',id:'grant'}]){
    const response=await b.request({method:'POST',url:'/api/environment/command',payload:command});assert.equal(response.statusCode,403);assert.equal(response.json().error.code,'GRANT_DENIED');
  }
  assert.deepEqual(b.calls,[]);
});

test('capability inspection forwards the selected revision and rejects untyped owner output',async t=>{
  const b=await browser(t),path='/v1/capabilities/browser/inspection?revision=browser-v1';
  const evidence={registered:true,dependencies:'ready',connection:'untested',tools:[],authentication:'not-required',checks:[],observedAt:null};
  const inspection={capabilityId:'browser',revisionId:'browser-v1',component:{id:'browser',name:'Playwright Browser',source:{kind:'npm',identifier:'@playwright/mcp',version:'0.0.83'},runtime:{kind:'local'},connection:{kind:'stdio',args:[],env:{}},requirements:{files:[],identityFiles:[],assets:[{kind:'playwright-browser',browser:'chromium'}],nativeBuild:false},authentication:{kind:'none'},checks:[],catalogId:'browser',capabilityId:'browser',capabilityRevisionId:'browser-v1',evidence,error:null},environments:[]};
  b.responses.set(path,inspection);
  const response=await b.request({method:'GET',url:'/api/environment/capabilities/browser/inspection?revision=browser-v1'});
  assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),inspection);
  assert.deepEqual(b.calls,[path]);assert.equal(b.harnesses.length,0,'Reading capability facts cannot activate a worker');
  b.responses.set(path,{...inspection,privateToken:'private-credential'});
  const malformed=await b.request({method:'GET',url:'/api/environment/capabilities/browser/inspection?revision=browser-v1'});
  assert.equal(malformed.statusCode,503);assert(!malformed.body.includes('private-credential'));
});

test('typed inventory, revision, provenance and command responses reject malformed secrets generically',async t=>{
  const b=await browser(t);
  const cases=[{path:'/v1/inventory',url:'/api/environment/inventory'},{path:'/v1/revisions/second/r1',url:'/api/environment/revisions/second/r1'},{path:'/v1/releases/release/provenance',url:'/api/environment/releases/release/provenance'},{path:'/v1/command',url:'/api/environment/command',payload:{kind:'capability.register',operationId:'register',repository:'local-source'}}];
  for(const item of cases){
    b.responses.set(item.path,{unexpected:'Bearer private-credential'});
    const response=await b.request({method:item.payload?'POST':'GET',url:item.url,...item.payload?{payload:item.payload}:{}});
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'ENVIRONMENT_UNAVAILABLE');assert(!response.body.includes('private-credential'));
  }
  const manifest=JSON.parse(await readFile(new URL('./fixtures/adr010/polariton-capability.json',import.meta.url),'utf8'));
  const provenance={source:{repository:'/fixture/repository',subdirectory:''},sourceDigest:'source',artifactDigest:'artifact',imageId:'image',image:manifest.image,commit:'a'.repeat(40),manifest,locks:{'package-lock.json':'digest'},builds:[],dependencies:{}};
  b.responses.set('/v1/releases/release/provenance',provenance);b.responses.set('/v1/revisions/second/r1',revision);
  assert.deepEqual((await b.request({method:'GET',url:'/api/environment/releases/release/provenance'})).json(),provenance);
  const download=await b.request({method:'GET',url:'/api/environment/revisions/second/r1'});assert.equal(download.statusCode,200);assert.deepEqual(download.json(),revision);
});

test('setup and selecting the second scoped r1 choice preserve the full reference without creating a session',async t=>{
  const b=await browser(t),project=randomUUID();
  const created=await b.request({method:'POST',url:'/api/projects',payload:{id:project,name:'Scoped choices'}});assert.equal(created.statusCode,200,created.body);
  const graph=(await b.request({method:'GET',url:`/api/projects/${project}/graph`})).json(),node=graph.nodes[0].id;
  const workers=`/api/projects/${project}/nodes/${node}/workers`,worker=(await b.request({method:'GET',url:workers})).json()[0];
  const setup=await b.request({method:'GET',url:`${workers}/${worker.id}/setup`});assert.equal(setup.statusCode,200);assert.deepEqual(setup.json().environments,choices);
  const selected=await b.request({method:'POST',url:`${workers}/${worker.id}/environment`,payload:{selection:choices[1]!.environment}});
  assert.equal(selected.statusCode,200);assert.deepEqual(selected.json().environment,{selection:choices[1]!.environment,locked:false});assert.equal(selected.json().harnessSessionId,null);
  assert.equal(b.harnesses.flatMap(harness=>harness.calls).filter(call=>call.method==='activate'||call.method==='message').length,0);
  assert.deepEqual((await b.request({method:'GET',url:workers})).json()[0].environment.selection,choices[1]!.environment);
});
