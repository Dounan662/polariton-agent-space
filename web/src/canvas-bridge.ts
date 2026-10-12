import {CanvasNotice,CanvasResponse,type CanvasPolicy,type CanvasRequest} from '../../src/canvas-contracts.ts';
import {api} from './api.ts';
import {graphLayout,LayoutError} from './graph-layout.ts';
import {renderCanvas} from './canvas-render.tsx';
import type {BrowserPolicy} from './observations.ts';

/** Connected-UI presentation endpoint. A connection owns its canvas identity and
 * in-flight requests; reconnect never replays a move or transfers it to another tab. */
export class CanvasBridge {
  private socket:WebSocket|null=null;
  private stopped=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending=new Map<string,AbortController>();
  private replies=new Map<string,AbortController>();
  private delay:number;

  private readonly connectionPolicy:Pick<BrowserPolicy,'reconnectMs'|'maxReconnectMs'>;
  private readonly report:(message:string)=>void;
  constructor(connectionPolicy:Pick<BrowserPolicy,'reconnectMs'|'maxReconnectMs'>,report:(message:string)=>void){this.connectionPolicy=connectionPolicy;this.report=report;this.delay=connectionPolicy.reconnectMs;this.connect();}

  private connect():void {
    const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/canvas`);
    this.socket=socket;
    let canvas:string|undefined,policy:CanvasPolicy|undefined;
    socket.onmessage=event=>{
      try{
        const notice=CanvasNotice.parse(JSON.parse(event.data));
        if(notice.kind==='canvas-ready'){canvas=notice.canvas;policy=notice.policy;this.delay=this.connectionPolicy.reconnectMs;return;}
        if(notice.kind==='canvas-cancel'){(this.pending.get(notice.id)??this.replies.get(notice.id))?.abort(new LayoutError('CANVAS_CANCELLED','Canvas request was cancelled.'));return;}
        if(!canvas||!policy)throw new Error('Canvas request arrived before connection policy.');
        if(this.pending.has(notice.id))return;
        if(this.pending.size>=policy.maxPending){
          // Rejection uploads are bounded independently of occupied render slots.
          // Closing an overloaded transport leaves Main to report its real outcome.
          if(this.replies.size>=policy.maxPending){socket.close();return;}
          const controller=new AbortController();this.replies.set(notice.id,controller);
          const timeout=setTimeout(()=>controller.abort(),Math.max(0,Math.min(policy.timeoutMs,notice.expiresAt-Date.now())));
          void this.respond(canvas,{id:notice.id,error:{code:'CANVAS_BUSY',message:'This browser is already processing its configured maximum canvas requests.'}},socket,controller.signal).finally(()=>{clearTimeout(timeout);this.replies.delete(notice.id);});return;
        }
        const controller=new AbortController();this.pending.set(notice.id,controller);
        const timeout=setTimeout(()=>controller.abort(new LayoutError('CANVAS_TIMEOUT','Browser canvas request timed out.')),Math.max(0,Math.min(policy.timeoutMs,notice.expiresAt-Date.now())));
        void this.execute(canvas,notice,policy,controller.signal).then(result=>{if(!controller.signal.aborted)return this.respond(canvas!,{id:notice.id,result},socket,controller.signal);}).catch(error=>{
          if(controller.signal.aborted||socket.readyState!==WebSocket.OPEN)return;
          return this.respond(canvas!,{id:notice.id,error:{code:error instanceof LayoutError?error.code:'CANVAS_RENDER_FAILED',message:error instanceof Error?error.message:'Canvas operation failed.'}},socket,controller.signal);
        }).finally(()=>{clearTimeout(timeout);this.pending.delete(notice.id);});
      }catch(error){this.report(`Canvas connection failed: ${error instanceof Error?error.message:String(error)}`);socket.close();}
    };
    socket.onclose=()=>{
      for(const controller of [...this.pending.values(),...this.replies.values()])controller.abort(new LayoutError('CANVAS_UNAVAILABLE','Browser canvas disconnected.'));
      if(!this.stopped){this.timer=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(this.connectionPolicy.maxReconnectMs,this.delay*2);}
    };
  }

  private async respond(canvas:string,response:CanvasResponse,socket:WebSocket,signal:AbortSignal):Promise<void> {
    if(signal.aborted||socket.readyState!==WebSocket.OPEN)return;
    try{await api(`/canvas/${canvas}/results`,CanvasResponse.parse(response),signal);}
    catch(error){if(signal.aborted)return;this.report(`Canvas result could not be delivered: ${error instanceof Error?error.message:String(error)} Inspect the canvas before retrying an edit.`);socket.close();}
  }

  private async execute(canvas:string,request:CanvasRequest,policy:CanvasPolicy,signal:AbortSignal):Promise<Extract<CanvasResponse,{result:unknown}>['result']> {
    const check=()=>{signal.throwIfAborted();if(Date.now()>=request.expiresAt)throw new LayoutError('CANVAS_TIMEOUT','Canvas request expired before it could complete.');};
    check();
    const {command,graph,activity}=request,{project}=command.input,layout=graphLayout(project);
    if(command.kind!=='canvas.get'&&command.input.canvas!==canvas)throw new LayoutError('CANVAS_UNAVAILABLE','Canvas identity changed. Read the canvas again.');
    if(command.kind==='canvas.move'){
      if(!request.requestId)throw new LayoutError('INVALID_REQUEST','Canvas move requires a request ID.');
      if(command.input.positions.length>policy.maxNodes)throw new LayoutError('CANVAS_LIMIT','Move exceeds the configured node budget.');
      const known=new Set(graph.nodes.map(node=>node.id));
      for(const position of command.input.positions){
        if(!known.has(position.id))throw new LayoutError('NOT_FOUND','A moved node is absent from the project graph.');
        if(Math.abs(position.x)>policy.maxCoordinate||Math.abs(position.y)>policy.maxCoordinate)throw new LayoutError('CANVAS_LIMIT','Position exceeds the configured canvas coordinate budget.');
      }
      const revision=await layout.move(command.input.positions.map(({id,x,y})=>({id,position:{x,y}})),command.input.expectRevision,JSON.stringify([request.actor,request.requestId]),policy.maxReceipts,check);
      return {canvas,project,revision,requestId:request.requestId,moved:command.input.positions.map(position=>position.id)};
    }
    const saved=await layout.inspect(graph.nodes.map(node=>node.id));check();
    const rendered=await renderCanvas(graph,activity,saved.positions,policy,signal,command.kind==='canvas.snapshot',command.kind==='canvas.snapshot'?command.input.node:undefined);check();
    const identity={canvas,project,revision:saved.revision,graphRevision:graph.revision};
    if(command.kind==='canvas.get')return {...identity,nodes:rendered.nodes,edges:graph.edges.filter(edge=>!edge.retracted).map(({id,from,to,relation})=>({id,from,to,relation}))};
    return {...identity,mediaType:'image/png',...rendered.image!};
  }

  close():void {this.stopped=true;clearTimeout(this.timer);for(const controller of [...this.pending.values(),...this.replies.values()])controller.abort(new LayoutError('CANVAS_UNAVAILABLE','Browser canvas closed.'));this.socket?.close();}
}
