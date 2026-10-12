import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {InjectOptions} from 'fastify';
import {loadRackConfig,createEnvironmentDaemon} from '../src/environment/daemon.ts';
import {parseJsonInput,JsonInputError} from '../src/json-input.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import {loadConfig} from '../src/config.ts';
import {createApp} from '../src/main.ts';

const raw={mcpServers:{example:{url:'http://127.0.0.1:1/mcp'}}};
const definition={kind:'http',url:'http://127.0.0.1:1/mcp',headers:{},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}};
const preview={entries:[{name:'example',definition}],errors:[],resolutions:{}};
const capability={...definition,id:'capability',name:'example',revisionId:'definition-1',baseRevisionId:null,operationId:'import',createdAt:'2026-09-24T00:00:00Z'};

/** The administrative peer records requests independently of UI and CLI implementations. */
async function peer(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'polariton-adr011-interfaces-')),socket=join(tmpdir(),`polariton-${randomUUID()}.sock`),configPath=join(root,'environment.json');
  const calls:Array<{path:string;body:unknown}>=[],responses=new Map<string,unknown>([['/v1/capabilities/preview',preview],['/v1/capabilities/capability',capability],['/v1/capabilities/capability/revisions/definition-1',capability]]);
  const server=createServer(async(request,response)=>{
    let body='';for await(const chunk of request)body+=chunk;calls.push({path:request.url!,body:body?JSON.parse(body):undefined});
    response.setHeader('content-type','application/json');
    if(request.headers.authorization!=='Bearer test-admin'){response.statusCode=401;response.end('{}');return;}
    response.end(JSON.stringify(responses.get(request.url!)??{}));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await mkdir(join(root,'rack'));await writeFile(join(root,'rack/admin.json'),JSON.stringify({token:'test-admin'}));
  await writeFile(configPath,JSON.stringify({stateRoot:'rack',socketPath:socket,credentialFile:'private/credentials.json',executablePaths:['programs'],maxBodyBytes:2048}));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  return {root,configPath,responses,calls};
}

test('Environment configuration resolves credential and executable locations relative to its own file',async t=>{
  const p=await peer(t),config=await loadRackConfig(p.configPath);
  assert.equal(config.credentialFile,join(p.root,'private/credentials.json'));
  assert.deepEqual(config.executablePaths,[join(p.root,'programs')]);
});

async function browser(t:TestContext){
  const p=await peer(t),config={...await loadConfig(),stateRoot:join(p.root,'main'),verification:false,environmentConfig:p.configPath};
  const runtime=await createApp(config);await runtime.app.ready();t.after(()=>runtime.app.close());
  const host=`127.0.0.1:${config.port}`,origin=`http://${host}`;let cookie='';
  const request=(options:InjectOptions)=>runtime.app.inject({...options,headers:{host,origin,cookie,...options.headers}});
  const token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
  const authenticated=await request({method:'POST',url:'/api/bootstrap',payload:{token}});assert.equal(authenticated.statusCode,200);cookie=(authenticated.headers['set-cookie'] as string).split(';')[0]!;
  return {...p,request};
}

test('Main preview and retained definition inspection use typed daemon operations',async t=>{
  const b=await browser(t),body={configuration:raw,resolutions:{}};
  const value=await b.request({method:'POST',url:'/api/environment/capabilities/preview',payload:body});assert.equal(value.statusCode,200,value.body);assert.deepEqual(value.json(),preview);
  const inspected=await b.request({method:'GET',url:'/api/environment/capabilities/capability/revisions/definition-1'});assert.equal(inspected.statusCode,200,inspected.body);assert.deepEqual(inspected.json(),capability);
  assert.deepEqual(b.calls,[{path:'/v1/capabilities/preview',body},{path:'/v1/capabilities/capability/revisions/definition-1',body:undefined}]);
});

test('browser preserves package intent and inert worker templates through preview and registration',async t=>{
  const b=await browser(t),definition={kind:'stdio',command:'/tools/npx',args:['-y','fixture@1.0.0','${POLARITON_WORKSPACE}'],env:{CACHE:'${POLARITON_RUNTIME}'},requirements:{files:[],identityFiles:[],execution:'foreground-host'},credentials:{},identity:{platform:'darwin',arch:'arm64',files:[{path:'/tools/npx',realpath:'/tools/npx',sha256:'a'.repeat(64)}]},package:{manager:'npm',specifier:'fixture@1.0.0',executable:'fixture'}};
  const input={configuration:{mcpServers:{fixture:{command:'npx',args:definition.args,env:definition.env}}},resolutions:{fixture:'/tools/npx'}};
  const preview={entries:[{name:'fixture',definition}],errors:[],resolutions:input.resolutions};
  b.responses.set('/v1/capabilities/preview',preview);
  const response=await b.request({method:'POST',url:'/api/environment/capabilities/preview',payload:input});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json(),preview);
  const imported={capabilities:[{...definition,id:'fixture',name:'fixture',revisionId:'r1',baseRevisionId:null,operationId:'import-package',createdAt:'2026-09-25T00:00:00Z'}]};
  b.responses.set('/v1/command',imported);
  const command={kind:'capability.import',operationId:'import-package',entries:preview.entries};
  const added=await b.request({method:'POST',url:'/api/environment/command',payload:command});assert.equal(added.statusCode,200,added.body);assert.deepEqual(added.json(),imported);
  assert(b.calls.every(value=>['/v1/capabilities/preview','/v1/command'].includes(value.path)));
});

test('Main refuses malformed credential-bearing input and daemon response fields without projecting secrets',async t=>{
  const b=await browser(t),secret='private-sentinel-browser';
  const malformed=await b.request({method:'POST',url:'/api/environment/capabilities/preview',payload:{configuration:raw,[secret]:true}});assert.equal(malformed.statusCode,400);assert(!malformed.body.includes(secret));assert.deepEqual(b.calls,[]);
  for(const [path,url,payload] of [['/v1/capabilities/preview','/api/environment/capabilities/preview',{configuration:raw}],['/v1/capabilities/capability','/api/environment/capabilities/capability',undefined]] as const){
    b.responses.set(path,{...capability,secret});const response=await b.request({method:payload?'POST':'GET',url,...(payload?{payload}:{})});assert.equal(response.statusCode,503,response.body);assert(!response.body.includes(secret));
  }
});


test('strict JSON input rejects decoded duplicate names and nested keys while preserving independent objects',()=>{
  const duplicates=[String.raw`{"mcpServers":{"same":{},"same":{}}}`,String.raw`{"mcpServers":{"same":{},"s\u0061me":{}}}`,String.raw`{"mcpServers":{"tool":{"env":{"TOKEN":"first","TOKEN":"second"}}}}`,String.raw`{"a\"b":0,"a\"b":1}`];
  for(const text of duplicates)assert.throws(()=>parseJsonInput(text),(error)=>error instanceof JsonInputError&&error.code==='DUPLICATE_KEY');
  const valid={a:{key:'one'},b:{key:'two'},array:[{key:'three'},'text: with braces {} and escaped "quotes"'],unicode:'文'};
  assert.deepEqual(parseJsonInput(JSON.stringify(valid)),valid);
  assert.throws(()=>parseJsonInput('{"secret-input":'),(error)=>error instanceof JsonInputError&&!error.message.includes('secret-input'));
});

test('Main rejects duplicate JSON keys before parsing an environment mutation',async t=>{
  const b=await browser(t),response=await b.request({method:'POST',url:'/api/environment/capabilities/preview',headers:{'content-type':'application/json'},payload:String.raw`{"configuration":{"mcpServers":{"same":{"url":"http://localhost/mcp"},"s\u0061me":{"url":"http://localhost/mcp"}}}}`});
  assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'DUPLICATE_KEY');assert.deepEqual(b.calls,[]);
});

test('daemon rejects duplicate JSON before preview and retains an empty inventory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-adr011-json-')),socketPath=join(tmpdir(),`polariton-${randomUUID()}.sock`);
  const {app,rack}=await createEnvironmentDaemon(RackConfig.parse({stateRoot:root,socketPath}));
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const {readFile}=await import('node:fs/promises'),admin=JSON.parse(await readFile(join(root,'admin.json'),'utf8'));
  const response=await app.inject({method:'POST',url:'/v1/capabilities/preview',headers:{authorization:`Bearer ${admin.token}`,'content-type':'application/json'},payload:'{"configuration":{"mcpServers":{"same":{},"same":{}}}}'});
  assert.equal(response.statusCode,400,response.body);assert.equal(response.json().error.code,'DUPLICATE_KEY');assert.deepEqual((await rack.inventory()).capabilities,[]);
});
