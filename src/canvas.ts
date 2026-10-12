import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';
import {Fault,type Graph,type NodeActivity} from './contracts.ts';
import {CanvasImage,CanvasState,CanvasMoveResult,CanvasResponse,type CanvasCommand,type CanvasPolicy,type CanvasNotice,type CanvasSnapshot} from './canvas-contracts.ts';

type Result=CanvasState|CanvasMoveResult|CanvasSnapshot;
type Pending={canvas:string;command:CanvasCommand;graph:Graph;requestId?:string;settle:(error?:Error,result?:Result)=>void;receiving:boolean};
type Browser={send:(message:CanvasNotice)=>void};

/** Routes bounded presentation operations to one connected UI. Layouts and replay receipts
 * remain in that browser; losing a move response never authorizes an automatic replay. */
export class CanvasBridge {
 private browsers=new Map<string,Browser>();
 private pending=new Map<string,Pending>();
 private occupied=new Set<string>();
 private policy:CanvasPolicy;
 private uuid:()=>string;
 private now:()=>number;
 constructor(policy:CanvasPolicy,dependencies:{uuid?:()=>string;now?:()=>number}={}){this.policy=policy;this.uuid=dependencies.uuid??randomUUID;this.now=dependencies.now??Date.now;}

 connect(send:Browser['send']):{id:string;close:()=>void}{
  const id=this.uuid();this.browsers.set(id,{send});
  try{send({kind:'canvas-ready',canvas:id,policy:this.policy});}catch(error){this.browsers.delete(id);throw error;}
  return {id,close:()=>{
   this.browsers.delete(id);
   for(const item of [...this.pending.values()])if(item.canvas===id)item.settle(this.lost(item,'The browser disconnected'));
  }};
 }

 async execute(command:CanvasCommand,graph:Graph,activity:NodeActivity[],actor:string,requestId?:string,signal?:AbortSignal):Promise<Result>{
  if(signal?.aborted)throw new Fault('CANVAS_CANCELLED','Canvas request cancelled before dispatch',408);
  let nodeCount=command.kind==='canvas.move'?command.input.positions.length:command.kind==='canvas.snapshot'?graph.nodes.filter(n=>!n.archived).length:graph.nodes.length;
  if(command.kind==='canvas.snapshot'&&command.input.node){
   const focus=command.input.node;
   if(!graph.nodes.some(n=>n.id===focus&&!n.archived))throw new Fault('NODE_NOT_FOUND','Snapshot focus must be a non-archived node in this project',404);
   const ids=new Set([focus]);
   for(const edge of graph.edges)if(!edge.retracted&&(edge.from===focus||edge.to===focus)){ids.add(edge.from);ids.add(edge.to);}
   nodeCount=graph.nodes.filter(n=>!n.archived&&ids.has(n.id)).length;
  }
  if(nodeCount>this.policy.maxNodes)throw new Fault('CANVAS_LIMIT','Graph exceeds the configured canvas node budget; use a focused snapshot',413);
  if(command.kind==='canvas.move'){
   if(!requestId)throw new Fault('INVALID_INPUT','Canvas moves require a retained request ID',400);
   const ids=new Set(graph.nodes.map(node=>node.id));
   if(command.input.positions.length>this.policy.maxNodes)throw new Fault('CANVAS_LIMIT','Move exceeds the configured node budget',413);
   for(const point of command.input.positions){
    if(!ids.has(point.id))throw new Fault('NODE_NOT_FOUND','Move contains a node outside this project',404);
    if(Math.abs(point.x)>this.policy.maxCoordinate||Math.abs(point.y)>this.policy.maxCoordinate)throw new Fault('CANVAS_LIMIT','Position exceeds the configured canvas coordinate range',400);
   }
  }
  if(command.kind==='canvas.snapshot'&&command.input.node&&!graph.nodes.some(n=>n.id===command.input.node&&!n.archived))throw new Fault('NODE_NOT_FOUND','Snapshot focus must be a non-archived node in this project',404);
  let canvas=command.input.canvas;
  if(!canvas){
   if(this.browsers.size>1)throw new Fault('CANVAS_AMBIGUOUS',`Several browser canvases are connected. Repeat canvas get with --canvas ID: ${[...this.browsers.keys()].join(', ')}`);
   canvas=this.browsers.keys().next().value;
  }
  const browser=canvas?this.browsers.get(canvas):undefined;
  if(!browser||!canvas)throw new Fault('CANVAS_UNAVAILABLE','Open the Polariton browser UI, then run canvas get to obtain its canvas identity. A disconnected canvas is never replaced automatically.',503);
  if(this.occupied.size>=this.policy.maxPending)throw new Fault('CANVAS_BUSY','Canvas request capacity is busy; retry after current requests finish',409);
  const selected=canvas,id=this.uuid();
  return new Promise<Result>((resolve,reject)=>{
   const cancel=()=>item.settle(this.lost(item,'The caller cancelled observation'));
   const timer=setTimeout(()=>item.settle(this.lost(item,'The browser did not respond before the capture deadline')),this.policy.timeoutMs);
   const item:Pending={canvas:selected,command,graph,requestId,receiving:false,settle:(error,result)=>{
    if(!this.pending.delete(id))return;
    if(!item.receiving)this.occupied.delete(id);
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    if(error){try{browser.send({kind:'canvas-cancel',id});}catch{/* Connection loss already determines the returned outcome. */}reject(error);}else resolve(result!);
   }};
   this.pending.set(id,item);this.occupied.add(id);signal?.addEventListener('abort',cancel,{once:true});
   try{browser.send({kind:'canvas-request',id,command,graph,activity,actor,requestId,expiresAt:this.now()+this.policy.timeoutMs});}
   catch{item.settle(this.lost(item,'The browser connection could not accept the request'));}
  });
 }

 /** Only the selected connection can complete a request. Validate browser output before it reaches a worker. */
 async respond(canvas:string,input:unknown):Promise<void>{
  const {id}=z.object({id:z.string().uuid()}).parse(input),item=this.pending.get(id);
  if(!item||item.canvas!==canvas)throw new Fault('CANVAS_REQUEST_GONE','This canvas request is no longer pending',410);
  if(item.receiving)throw new Fault('CANVAS_RESPONSE_CONFLICT','This canvas request already has a response',409);
  item.receiving=true;
  try{
   const response=CanvasResponse.parse(input);
   if('error' in response){
    const statuses:Record<string,number>={CANVAS_BUSY:409,CANVAS_STALE:409,CANVAS_UNAVAILABLE:503,CANVAS_LIMIT:413,CANVAS_CANCELLED:408,CANVAS_TIMEOUT:408};
    item.settle(new Fault(response.error.code,response.error.message,statuses[response.error.code]??409));return;
   }
   const raw=response.result;
   if(raw.canvas!==canvas||raw.project!==item.command.input.project)throw new Error('Canvas response identity does not match its request');
   let result:Result;
   if(item.command.kind==='canvas.get'){
    const state=CanvasState.parse(raw);
    if(state.graphRevision!==item.graph.revision||state.nodes.length!==item.graph.nodes.length||new Set(state.nodes.map(n=>n.id)).size!==state.nodes.length||state.nodes.some(n=>!item.graph.nodes.some(source=>source.id===n.id)))throw new Error('Canvas response topology does not match its request');
    const expected=item.graph.edges.filter(e=>!e.retracted).map(({id,from,to,relation})=>({id,from,to,relation}));
    if(JSON.stringify(state.edges)!==JSON.stringify(expected))throw new Error('Canvas response relations do not match its request');
    if(state.nodes.some(n=>Math.abs(n.x)>this.policy.maxCoordinate||Math.abs(n.y)>this.policy.maxCoordinate||n.width<=0||n.height<=0))throw new Error('Canvas response card bounds are invalid');
    result=state;
   }else if(item.command.kind==='canvas.move'){
    const moved=CanvasMoveResult.parse(raw),expected=item.command.input.positions.map(p=>p.id).sort();
    if(moved.requestId!==item.requestId||JSON.stringify([...moved.moved].sort())!==JSON.stringify(expected))throw new Error('Canvas move response does not match its request');
    result=moved;
   }else{
    const snapshot=CanvasImage.parse(raw);
    if(snapshot.graphRevision!==item.graph.revision)throw new Error('Canvas snapshot graph revision does not match its request');
    if(snapshot.data.length>Math.ceil(this.policy.maxImageBytes/3)*4||snapshot.width>this.policy.maxDimension||snapshot.height>this.policy.maxDimension||snapshot.width*snapshot.height>this.policy.maxPixels)throw new Error('Canvas snapshot exceeds configured image bounds');
    const bytes=Buffer.from(snapshot.data,'base64');
    if(!bytes.length||bytes.length>this.policy.maxImageBytes||bytes.toString('base64')!==snapshot.data)throw new Error('Canvas snapshot is not canonical bounded base64');
    const decoded=sharp(bytes,{limitInputPixels:this.policy.maxPixels}).timeout({seconds:Math.ceil(this.policy.timeoutMs/1000)}),metadata=await decoded.metadata();
    if(metadata.format!=='png'||metadata.width!==snapshot.width||metadata.height!==snapshot.height)throw new Error('Canvas image does not match its declared PNG dimensions');
    await decoded.stats();
    result={...snapshot,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
   }
   item.settle(undefined,result);
  }catch(error){item.settle(new Fault(item.command.kind==='canvas.move'?'CANVAS_UNCERTAIN':'CANVAS_INVALID_RESPONSE',`${error instanceof Error?error.message:'Invalid canvas response'}. Inspect canvas get --project ${item.command.input.project} --canvas ${canvas} before retrying.`,502));}
  finally{this.occupied.delete(id);}
 }

 close():void{
  for(const item of [...this.pending.values()])item.settle(this.lost(item,'Main is shutting down'));
  this.browsers.clear();
 }
 private lost(item:Pending,reason:string):Fault{
  return item.command.kind==='canvas.move'
   ?new Fault('CANVAS_UNCERTAIN',`${reason}; the move may have applied. Inspect canvas get --project ${item.command.input.project} --canvas ${item.canvas}. Retain request ID ${item.requestId}; never retry with a new identity merely because the response was lost.`,503)
   :new Fault('CANVAS_UNAVAILABLE',`${reason}. Reconnect the UI and run canvas get before another capture.`,503);
 }
}
