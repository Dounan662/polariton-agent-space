import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {once} from 'node:events';
import sharp from 'sharp';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {InjectOptions} from 'fastify';
import {createApp} from '../src/main.ts';
import {loadConfig,type Config} from '../src/config.ts';
import {applicationSocket} from '../src/cli/server.ts';
import {socketRequest} from '../src/environment/daemon.ts';
import {RackConfig} from '../src/environment/contracts.ts';
import type {CanvasNotice,CanvasRequest,CanvasState,CanvasSnapshotFile} from '../src/canvas-contracts.ts';
import type {Request} from '../src/cli/contracts.ts';
import type {ProjectView} from '../src/contracts.ts';
import {ControlledHarness} from './fixtures/harness.ts';
import {configureTestProviders} from './fixtures/providers.ts';
import {activateWorker} from './fixtures/activation.ts';

/** Real authenticated browser and CLI transports, with a deterministic execution neighbor. */
async function fixture(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'canvas-http-'))),environmentConfig=join(root,'environment.json');
 await writeFile(environmentConfig,JSON.stringify(RackConfig.parse({stateRoot:join(root,'rack'),socketPath:join(root,'environment.sock')})));
 const config:Config={...await loadConfig(),stateRoot:join(root,'main'),configPath:join(root,'application.json'),environmentConfig,verification:false};
 await writeFile(config.configPath!,JSON.stringify(config));await configureTestProviders(config);
 let sequence=1;const id=()=>`28000000-0000-4000-8000-${String(sequence++).padStart(12,'0')}`;
 const credentials:string[]=[],harnesses:ControlledHarness[]=[],sockets:Array<{terminate:()=>void}>=[];
 const runtime=await createApp(config,(settings,_home,_workspace,_budget,permission)=>{credentials.push(settings.workerCredential!.token);const h=new ControlledHarness(id(),permission);harnesses.push(h);return h;});
 await runtime.app.ready();
 t.after(async()=>{for(const socket of sockets)socket.terminate();for(const h of harnesses)h.complete();await runtime.app.close();await rm(root,{recursive:true,force:true});});
 const host=`127.0.0.1:${config.port}`,origin=`http://${host}`,token=new URLSearchParams(new URL(runtime.launchUrl).hash.slice(1)).get('token');
 const login=await runtime.app.inject({method:'POST',url:'/api/bootstrap',headers:{host,origin},payload:{token}});assert.equal(login.statusCode,200);
 const cookie=String(login.headers['set-cookie']).split(';')[0];
 const request=(options:InjectOptions)=>runtime.app.inject({...options,headers:{host,origin,cookie,...options.headers}});
 const ownerToken=JSON.parse(await readFile(join(config.stateRoot,'application-admin.json'),'utf8')).token as string;
 const cli=<T=unknown>(command:Request['command'],requestId?:string,credential=ownerToken)=>socketRequest<T>(applicationSocket(config.stateRoot),credential,'/v1/execute',{version:1,command,...(requestId?{requestId}:{})},config.requestTimeoutMs,config.cliMaxStreamBytes);
 async function project(){const response=await request({method:'POST',url:'/api/projects',payload:{id:id(),name:'Canvas research'}});assert.equal(response.statusCode,200,response.body);return response.json<ProjectView>();}
 async function browser(){
  const notices:CanvasNotice[]=[],waiters:Array<(notice:CanvasNotice)=>void>=[];
  const ws=await runtime.app.injectWS('/api/canvas',{headers:{host,origin,cookie}},{onInit:socket=>socket.on('message',(raw:Buffer)=>{const notice=JSON.parse(String(raw)) as CanvasNotice;const waiter=waiters.shift();if(waiter)waiter(notice);else notices.push(notice);})});
  sockets.push(ws);
  const next=()=>notices.length?Promise.resolve(notices.shift()!):new Promise<CanvasNotice>(resolve=>waiters.push(resolve));
  const ready=await next();assert.equal(ready.kind,'canvas-ready');if(ready.kind!=='canvas-ready')throw new Error('Canvas handshake missing');
  async function command(){const notice=await next();assert.equal(notice.kind,'canvas-request');return notice as CanvasRequest;}
  return {ws,id:ready.canvas,command};
 }
 return {runtime,config,host,origin,cookie,request,cli,id,project,browser,credentials,harnesses};
}
function state(request:CanvasRequest,canvas:string):CanvasState{return {canvas,project:request.command.input.project,revision:'layout-1',graphRevision:request.graph.revision,nodes:request.graph.nodes.map(n=>({id:n.id,title:n.title,archived:n.archived,x:20,y:30,width:250,height:100})),edges:[]};}

test('canvas browser channel and results require authenticated same-origin access',async t=>{
 const f=await fixture(t);
 const unauthenticated=await f.runtime.app.inject({method:'GET',url:'/api/canvas',headers:{host:f.host,origin:f.origin}});assert.equal(unauthenticated.statusCode,401);
 const crossOrigin=await f.runtime.app.inject({method:'GET',url:'/api/canvas',headers:{host:f.host,origin:'http://other.invalid',cookie:f.cookie}});assert.equal(crossOrigin.statusCode,403);
 const route=`/api/canvas/${f.id()}/results`;
 const noCookie=await f.runtime.app.inject({method:'POST',url:route,headers:{host:f.host,origin:f.origin},payload:{}});assert.equal(noCookie.statusCode,401);
 const noOrigin=await f.runtime.app.inject({method:'POST',url:route,headers:{host:f.host,cookie:f.cookie},payload:{}});assert.equal(noOrigin.statusCode,403);
 const malformed=await f.request({method:'POST',url:route,payload:{}});assert.equal(malformed.statusCode,400);
});

test('CLI reads route through the selected connected browser without writing graph records',async t=>{
 const f=await fixture(t),project=await f.project();
 await assert.rejects(f.cli({kind:'canvas.get',input:{project:project.id}}),{code:'CANVAS_UNAVAILABLE'});
 const before=f.runtime.tree.graph(project.id),browser=await f.browser();
 const result=f.cli<CanvasState>({kind:'canvas.get',input:{project:project.id}}),request=await browser.command();
 const response=await f.request({method:'POST',url:`/api/canvas/${browser.id}/results`,payload:{id:request.id,result:state(request,browser.id)}});assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(await result,state(request,browser.id));assert.deepEqual(f.runtime.tree.graph(project.id),before);assert.equal(f.harnesses.length,0);
});

test('authenticated worker canvas access stays in its project without activating another worker',async t=>{
 const f=await fixture(t),own=await f.project(),other=await f.project();
 await activateWorker(f.runtime.agents,own.id,own.mainNodeId!,own.initialWorkerId!);assert.equal(f.credentials.length,1);
 const credential=f.credentials[0],browser=await f.browser();
 await assert.rejects(f.cli({kind:'canvas.get',input:{project:other.id,canvas:browser.id}},undefined,credential),{code:'GRANT_DENIED'});
 const result=f.cli<CanvasState>({kind:'canvas.get',input:{project:own.id,canvas:browser.id}},undefined,credential),request=await browser.command();assert.equal(request.actor,`worker:${own.initialWorkerId}`);
 const response=await f.request({method:'POST',url:`/api/canvas/${browser.id}/results`,payload:{id:request.id,result:state(request,browser.id)}});assert.equal(response.statusCode,200,response.body);await result;assert.equal(f.harnesses.length,1);
});

test('browser disconnect returns uncertain CLI move outcome and does not change research topology',async t=>{
 const f=await fixture(t),project=await f.project(),browser=await f.browser(),before=f.runtime.tree.graph(project.id),requestId=f.id();
 const result=f.cli({kind:'canvas.move',input:{project:project.id,canvas:browser.id,expectRevision:'layout-1',positions:[{id:project.mainNodeId!,x:200,y:300}]}},requestId);
 const rejected=assert.rejects(result,(error:unknown)=>{assert.ok(error instanceof Error);assert.equal((error as Error&{code:string}).code,'CANVAS_UNCERTAIN');assert.ok(error.message.includes(requestId));return true;});
 const command=await browser.command();assert.equal(command.requestId,requestId);
 const closed=once(browser.ws,'close');browser.ws.terminate();await closed;await rejected;
 assert.deepEqual(f.runtime.tree.graph(project.id),before);
 await assert.rejects(f.cli({kind:'canvas.get',input:{project:project.id,canvas:browser.id}}),{code:'CANVAS_UNAVAILABLE'});
});

test('temporary files are outside research and finish respects worker scope without a browser',async t=>{
 const f=await fixture(t),project=await f.project(),other=await f.project(),browser=await f.browser();
 await activateWorker(f.runtime.agents,project.id,project.mainNodeId!,project.initialWorkerId!);const credential=f.credentials[0];
 const png=await sharp({create:{width:2,height:2,channels:4,background:'#123456'}}).png().toBuffer();
 async function capture(credential?:string){
  const result=f.cli<CanvasSnapshotFile>({kind:'canvas.snapshot',input:{project:project.id,canvas:browser.id}},undefined,credential),request=await browser.command();
  const response=await f.request({method:'POST',url:`/api/canvas/${browser.id}/results`,payload:{id:request.id,result:{canvas:browser.id,project:project.id,revision:'layout-1',graphRevision:request.graph.revision,mediaType:'image/png',width:2,height:2,bounds:{x:0,y:0,width:100,height:100},data:png.toString('base64')}}});
  assert.equal(response.statusCode,200,response.body);return result;
 }
 const owner=await capture(),worker=await capture(credential);
 await assert.rejects(createApp(f.config),{code:'STATE_OWNED'});
 assert(!owner.output.startsWith(project.root+'/'));assert(!worker.output.startsWith(project.root+'/'));assert.equal('data' in worker,false);assert.equal(typeof worker.expiresAt,'number');assert.deepEqual(await readFile(worker.output),png);
 const closed=once(browser.ws,'close');browser.ws.terminate();await closed;
 await assert.rejects(f.cli({kind:'canvas.finish',input:{project:other.id}},undefined,credential),{code:'GRANT_DENIED'});
 assert.deepEqual(await f.cli({kind:'canvas.finish',input:{project:project.id}},undefined,credential),{removed:1});await assert.rejects(readFile(worker.output),{code:'ENOENT'});assert.deepEqual(await readFile(owner.output),png);
 assert.deepEqual(await f.cli({kind:'canvas.finish',input:{project:project.id}},undefined,credential),{removed:0});
 assert.deepEqual(await f.cli({kind:'canvas.finish',input:{project:project.id}}),{removed:1});await assert.rejects(readFile(owner.output),{code:'ENOENT'});
});

test('finish cancels a pending browser capture and refuses its late result',async t=>{
 const f=await fixture(t),project=await f.project(),browser=await f.browser();
 const capture=f.cli({kind:'canvas.snapshot',input:{project:project.id,canvas:browser.id}}),rejected=assert.rejects(capture,{code:'CANVAS_UNAVAILABLE'}),request=await browser.command();
 assert.deepEqual(await f.cli({kind:'canvas.finish',input:{project:project.id}}),{removed:0});await rejected;
 const response=await f.request({method:'POST',url:`/api/canvas/${browser.id}/results`,payload:{id:request.id,result:state(request,browser.id)}});assert.equal(response.statusCode,410);
 assert.deepEqual(await f.cli({kind:'canvas.finish',input:{project:project.id}}),{removed:0});
});
