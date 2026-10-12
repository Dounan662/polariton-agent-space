import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test,type TestContext} from 'node:test';
import sharp from 'sharp';
import {CanvasBridge} from '../src/canvas.ts';
import {CanvasPolicy,type CanvasCommand,type CanvasNotice,type CanvasRequest,type CanvasState} from '../src/canvas-contracts.ts';
import type {Graph} from '../src/contracts.ts';

const id=(n:number)=>`27000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project=id(1),node=id(2),requestId=id(3);
const graph:Graph={revision:4,nodes:[{id:node,title:'Research',description:'',archived:false}],edges:[],recovery:null};
function fixture(t:TestContext,overrides:Partial<CanvasPolicy>={}){
 let sequence=10;
 const policy=CanvasPolicy.parse({timeoutMs:100,maxPending:2,maxNodes:4,maxImageBytes:4096,maxPixels:100,maxDimension:10,padding:1,maxReceipts:4,maxCoordinate:1000,...overrides});
 const bridge=new CanvasBridge(policy,{uuid:()=>id(sequence++),now:()=>500});t.after(()=>bridge.close());
 function browser(){const notices:CanvasNotice[]=[];const connection=bridge.connect(message=>notices.push(message));return {...connection,notices,requests:()=>notices.filter((m):m is CanvasRequest=>m.kind==='canvas-request')};}
 return {bridge,policy,browser};
}
const get=(canvas?:string):CanvasCommand=>({kind:'canvas.get',input:{project,canvas}});
const move=(canvas:string):CanvasCommand=>({kind:'canvas.move',input:{project,canvas,expectRevision:'layout-1',positions:[{id:node,x:100,y:200}]}});
const snapshot=(canvas:string):CanvasCommand=>({kind:'canvas.snapshot',input:{project,canvas}});
function state(canvas:string):CanvasState{return {canvas,project,revision:'layout-1',graphRevision:graph.revision,nodes:[{id:node,title:'Research',archived:false,x:0,y:0,width:200,height:100}],edges:[]};}
const moved=(canvas:string)=>({canvas,project,revision:'layout-2',requestId,moved:[node]});
const run=(bridge:CanvasBridge,command:CanvasCommand,signal?:AbortSignal)=>bridge.execute(command,graph,[],'worker',command.kind==='canvas.move'?requestId:undefined,signal);

test('selection is explicit with multiple browsers and never switches a retained canvas identity',async t=>{
 const {bridge,browser}=fixture(t);
 await assert.rejects(run(bridge,get()),{code:'CANVAS_UNAVAILABLE'});
 const a=browser();const result=run(bridge,get());assert.equal(a.requests().length,1);
 const b=browser();await assert.rejects(run(bridge,get()),{code:'CANVAS_AMBIGUOUS'});
 await assert.rejects(bridge.respond(b.id,{id:a.requests()[0].id,result:state(b.id)}),{code:'CANVAS_REQUEST_GONE'});
 await bridge.respond(a.id,{id:a.requests()[0].id,result:state(a.id)});assert.deepEqual(await result,state(a.id));
 a.close();await assert.rejects(run(bridge,get(a.id)),{code:'CANVAS_UNAVAILABLE'});assert.equal(b.requests().length,0);
 const next=run(bridge,get(b.id));await bridge.respond(b.id,{id:b.requests()[0].id,result:state(b.id)});assert.equal((await next).canvas,b.id);
});

test('moves validate project membership, coordinates and retained identity before dispatch',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 await assert.rejects(bridge.execute(move(a.id),graph,[],'worker'),{code:'INVALID_INPUT'});
 const outside=move(a.id);assert.equal(outside.kind,'canvas.move');if(outside.kind!=='canvas.move')return;
 outside.input.positions=[{id:id(99),x:0,y:0}];await assert.rejects(run(bridge,outside),{code:'NODE_NOT_FOUND'});
 outside.input.positions=[{id:node,x:1001,y:0}];await assert.rejects(run(bridge,outside),{code:'CANVAS_LIMIT'});
 assert.equal(a.requests().length,0);
 const valid=run(bridge,move(a.id)),sent=a.requests()[0];assert.equal(sent.requestId,requestId);assert.equal(sent.actor,'worker');assert.equal(sent.expiresAt,600);
 await bridge.respond(a.id,{id:sent.id,result:moved(a.id)});assert.deepEqual(await valid,moved(a.id));assert.deepEqual(graph.nodes[0],{id:node,title:'Research',description:'',archived:false});
});

test('stale and active-drag errors remain observable and a refreshed move can succeed',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 for(const code of ['CANVAS_STALE','CANVAS_BUSY']){
  const result=run(bridge,move(a.id)),rejected=assert.rejects(result,{code,status:409});
  await bridge.respond(a.id,{id:a.requests().at(-1)!.id,error:{code,message:'Human changed the canvas'}});await rejected;
 }
 const result=run(bridge,move(a.id));await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:moved(a.id)});assert.equal((await result).revision,'layout-2');
});

test('slow presentation requests do not block another browser; capacity is released on completion',async t=>{
 const {bridge,browser}=fixture(t),a=browser(),b=browser();
 const blocked=run(bridge,snapshot(a.id)),blockedFailure=assert.rejects(blocked,{code:'CANVAS_UNAVAILABLE'});
 const independent=run(bridge,get(b.id));await assert.rejects(run(bridge,get(b.id)),{code:'CANVAS_BUSY'});
 await bridge.respond(b.id,{id:b.requests()[0].id,result:state(b.id)});assert.equal((await independent).canvas,b.id);
 const next=run(bridge,get(b.id));await bridge.respond(b.id,{id:b.requests()[1].id,result:state(b.id)});await next;
 a.close();await blockedFailure;
});

test('disconnection makes an in-flight move uncertain and never replays it elsewhere',async t=>{
 const {bridge,browser}=fixture(t),a=browser(),b=browser();
 const result=run(bridge,move(a.id)),rejected=assert.rejects(result,(error:unknown)=>{
  assert.ok(error instanceof Error);assert.equal((error as Error&{code:string}).code,'CANVAS_UNCERTAIN');assert.ok(error.message.includes(requestId));assert.ok(error.message.includes(a.id));return true;
 });
 const sent=a.requests()[0];a.close();await rejected;assert.equal(b.requests().length,0);
 await assert.rejects(bridge.respond(a.id,{id:sent.id,result:moved(a.id)}),{code:'CANVAS_REQUEST_GONE'});
});

test('caller cancellation distinguishes undispatched work from a move with uncertain outcome',async t=>{
 const {bridge,browser}=fixture(t),a=browser(),before=new AbortController();before.abort();
 await assert.rejects(run(bridge,move(a.id),before.signal),{code:'CANVAS_CANCELLED'});assert.equal(a.requests().length,0);
 const during=new AbortController(),result=run(bridge,move(a.id),during.signal),rejected=assert.rejects(result,{code:'CANVAS_UNCERTAIN'});during.abort();await rejected;
 assert.equal(a.requests().length,1);assert.ok(a.notices.some(m=>m.kind==='canvas-cancel'));
 const next=run(bridge,get(a.id));await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:state(a.id)});await next;
});

test('deadline and shutdown settle pending work, discard late responses, and release capacity',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const {bridge,browser,policy}=fixture(t),a=browser();
 const timed=run(bridge,move(a.id)),failure=assert.rejects(timed,{code:'CANVAS_UNCERTAIN'});t.mock.timers.tick(policy.timeoutMs);await failure;
 await assert.rejects(bridge.respond(a.id,{id:a.requests()[0].id,result:moved(a.id)}),{code:'CANVAS_REQUEST_GONE'});
 const pending=run(bridge,get(a.id)),closed=assert.rejects(pending,{code:'CANVAS_UNAVAILABLE'});bridge.close();await closed;
 await assert.rejects(run(bridge,get(a.id)),{code:'CANVAS_UNAVAILABLE'});assert.equal(a.requests().length,2);
});

test('a failed send yields uncertainty for moves and does not consume request capacity',async t=>{
 const {bridge}=fixture(t);let sent=0;
 const a=bridge.connect(notice=>{if(notice.kind==='canvas-request'){sent++;throw new Error('Transport failed');}});
 await assert.rejects(run(bridge,move(a.id)),{code:'CANVAS_UNCERTAIN'});await assert.rejects(run(bridge,get(a.id)),{code:'CANVAS_UNAVAILABLE'});assert.equal(sent,2);
});

test('node and focus budgets reject requests without sending browser work',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 await assert.rejects(bridge.execute(get(a.id),{...graph,nodes:Array.from({length:5},(_,i)=>({...graph.nodes[0],id:id(i+40)}))},[],'worker'),{code:'CANVAS_LIMIT'});
 await assert.rejects(run(bridge,{kind:'canvas.snapshot',input:{project,canvas:a.id,node:id(99)}}),{code:'NODE_NOT_FOUND'});
 await assert.rejects(bridge.execute({kind:'canvas.snapshot',input:{project,canvas:a.id,node}},{...graph,nodes:[{...graph.nodes[0],archived:true}]},[],'worker'),{code:'NODE_NOT_FOUND'});
 assert.equal(a.requests().length,0);
});

test('snapshot validates real PNG contents and returns exact size and digest',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 const png=await sharp({create:{width:2,height:3,channels:4,background:'#224466'}}).png().toBuffer();
 const result=run(bridge,snapshot(a.id));
 await bridge.respond(a.id,{id:a.requests()[0].id,result:{canvas:a.id,project,revision:'layout-1',graphRevision:graph.revision,mediaType:'image/png',width:2,height:3,bounds:{x:-10,y:-20,width:400,height:600},data:png.toString('base64')}});
 const actual=await result;assert.ok('sha256' in actual);assert.equal(actual.bytes,png.length);assert.equal(actual.sha256,createHash('sha256').update(png).digest('hex'));assert.deepEqual(Buffer.from(actual.data,'base64'),png);
});

test('invalid images fail without exposing image data and leave the bridge usable',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 const png=await sharp({create:{width:2,height:3,channels:4,background:'#224466'}}).png().toBuffer();
 const jpeg=await sharp(png).jpeg().toBuffer();
 const base={canvas:a.id,project,revision:'layout-1',graphRevision:graph.revision,mediaType:'image/png' as const,width:2,height:3,bounds:{x:0,y:0,width:2,height:3},data:png.toString('base64')};
 const cases=[{width:11},{width:3},{data:jpeg.toString('base64')},{data:png.subarray(0,40).toString('base64')},{data:base.data+'\n'},{data:Buffer.alloc(4097).toString('base64')},{graphRevision:5},{project:id(99)}];
 for(const change of cases){
  const image={...base,...change},result=run(bridge,snapshot(a.id)),failure=assert.rejects(result,(error:unknown)=>{assert.ok(error instanceof Error);assert.equal((error as Error&{code:string}).code,'CANVAS_INVALID_RESPONSE');assert.ok(!error.message.includes(image.data));return true;});
  await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:image});await failure;
 }
 const read=run(bridge,get(a.id));await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:state(a.id)});await read;
});

test('mismatched move acknowledgment is uncertain instead of claiming success',async t=>{
 const {bridge,browser}=fixture(t),a=browser(),result=run(bridge,move(a.id)),failure=assert.rejects(result,{code:'CANVAS_UNCERTAIN'});
 await bridge.respond(a.id,{id:a.requests()[0].id,result:{...moved(a.id),moved:[id(99)]}});await failure;
});

test('malformed selected-browser responses settle promptly and release capacity',async t=>{
 const {bridge,browser}=fixture(t,{maxPending:1}),a=browser();
 for(const command of [get(a.id),move(a.id),snapshot(a.id)]){
  const result=run(bridge,command),failure=assert.rejects(result,{code:command.kind==='canvas.move'?'CANVAS_UNCERTAIN':'CANVAS_INVALID_RESPONSE'});
  await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:{canvas:a.id}});await failure;
 }
 const result=run(bridge,get(a.id));await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:state(a.id)});await result;
});

test('browser reads cannot invent topology or return unusable card bounds',async t=>{
 const {bridge,browser}=fixture(t),a=browser();
 const valid=state(a.id),invalid=[{nodes:[]},{nodes:[...valid.nodes,...valid.nodes]},{nodes:[{...valid.nodes[0],x:1001}]},{nodes:[{...valid.nodes[0],width:0}]},{edges:[{id:id(99),from:node,to:node,relation:'invented'}]}];
 for(const change of invalid){
  const result=run(bridge,get(a.id)),failure=assert.rejects(result,{code:'CANVAS_INVALID_RESPONSE'});
  await bridge.respond(a.id,{id:a.requests().at(-1)!.id,result:{...valid,...change}});await failure;
 }
});

test('focused capture remains available when unrelated graph nodes exceed the rendering budget',async t=>{
 const {bridge,browser}=fixture(t,{maxNodes:1}),a=browser();
 const large={...graph,nodes:[...graph.nodes,{...graph.nodes[0],id:id(99)}]};
 await assert.rejects(bridge.execute(snapshot(a.id),large,[],'worker'),{code:'CANVAS_LIMIT'});
 const pending=bridge.execute({kind:'canvas.snapshot',input:{project,canvas:a.id,node}},large,[],'worker');
 const failed=assert.rejects(pending,{code:'CANVAS_UNAVAILABLE'});assert.equal(a.requests().length,1);assert.equal(a.requests()[0].command.kind,'canvas.snapshot');a.close();await failed;
});
