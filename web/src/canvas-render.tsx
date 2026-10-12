import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow,useNodesInitialized,useReactFlow,type ReactFlowInstance} from '@xyflow/react';
import {toPng} from 'html-to-image';
import type {Graph,NodeActivity} from '../../src/contracts.ts';
import type {CanvasPolicy,CanvasState} from '../../src/canvas-contracts.ts';
import {graphElements} from './graph.tsx';
import {LayoutError,type Point} from './graph-layout.ts';

type Bounds={x:number;y:number;width:number;height:number};

/** Render a fixed presentation cut outside the user's canvas. Both measurement and
 * export use real React Flow geometry, including curved edges and relation labels.
 * The caller owns cancellation/deadlines; every exit removes the temporary root. */
export async function renderCanvas(graph:Graph,activity:NodeActivity[],positions:Record<string,Point>,policy:CanvasPolicy,signal:AbortSignal,snapshot:boolean,focus?:string):Promise<{nodes:CanvasState['nodes'];image?:{data:string;width:number;height:number;bounds:Bounds}}> {
  signal.throwIfAborted();
  let included=new Set(graph.nodes.filter(node=>!snapshot||!node.archived).map(node=>node.id));
  if(focus){
    if(!included.has(focus))throw new LayoutError('NOT_FOUND','The focused node is absent or archived.');
    const neighbors=new Set([focus]);
    for(const edge of graph.edges)if(!edge.retracted){if(edge.from===focus)neighbors.add(edge.to);if(edge.to===focus)neighbors.add(edge.from);}
    included=new Set([...included].filter(id=>neighbors.has(id)));
  }
  if(included.size>policy.maxNodes)throw new LayoutError('CANVAS_LIMIT','Canvas exceeds the configured node budget. Use a focused snapshot.');
  const cut={...graph,nodes:graph.nodes.filter(node=>included.has(node.id))};
  const elements=graphElements(cut,activity,positions,!snapshot);
  const host=document.createElement('div');
  host.className='graph-capture';host.setAttribute('aria-hidden','true');host.inert=true;
  Object.assign(host.style,{position:'fixed',left:`-${policy.maxCoordinate+policy.maxDimension}px`,top:'0',width:`${policy.maxDimension}px`,height:`${policy.maxDimension}px`,pointerEvents:'none'});
  document.body.append(host);
  const root=createRoot(host);
  let disposed=false;
  const dispose=()=>{if(!disposed){disposed=true;root.unmount();host.remove();}};
  signal.addEventListener('abort',dispose,{once:true});
  try{
    await cancellable(document.fonts.ready,signal);
    signal.throwIfAborted();
    const instance=await cancellable(new Promise<ReactFlowInstance>(resolve=>{
      root.render(<ReactFlow defaultNodes={elements.nodes} defaultEdges={elements.edges} defaultViewport={{x:0,y:0,zoom:1}} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} zoomOnDoubleClick={false} zoomOnPinch={false} preventScrolling={false} minZoom={Number.MIN_VALUE} maxZoom={1}>
        <Measured empty={!elements.nodes.length} ready={resolve}/>
      </ReactFlow>);
    }),signal);
    await cancellable(document.fonts.ready,signal);
    await frame(signal);
    const measured=instance.getNodes();
    const nodes=cut.nodes.map(node=>{
      const rendered=measured.find(value=>value.id===node.id);
      if(!rendered?.measured?.width||!rendered.measured.height)throw new LayoutError('CANVAS_RENDER_FAILED','Card dimensions were not available.');
      return {id:node.id,title:node.title,archived:node.archived,...positions[node.id]!,width:rendered.measured.width,height:rendered.measured.height};
    });
    if(!snapshot)return {nodes};
    const boxes:Bounds[]=nodes.map(node=>node);
    const origin=host.getBoundingClientRect();
    for(const element of host.querySelectorAll<SVGGraphicsElement>('.react-flow__edge-path,.react-flow__edge-textwrapper')){
      const rect=element.getBoundingClientRect();boxes.push({x:rect.left-origin.left,y:rect.top-origin.top,width:rect.width,height:rect.height});
    }
    const left=boxes.length?Math.min(...boxes.map(box=>box.x)):0,top=boxes.length?Math.min(...boxes.map(box=>box.y)):0;
    const right=boxes.length?Math.max(...boxes.map(box=>box.x+box.width)):0,bottom=boxes.length?Math.max(...boxes.map(box=>box.y+box.height)):0;
    const bounds={x:left-policy.padding,y:top-policy.padding,width:right-left+policy.padding*2,height:bottom-top+policy.padding*2};
    const scale=Math.min(1,policy.maxDimension/bounds.width,policy.maxDimension/bounds.height,Math.sqrt(policy.maxPixels/(bounds.width*bounds.height)));
    const width=Math.max(1,Math.floor(bounds.width*scale)),height=Math.max(1,Math.floor(bounds.height*scale));
    host.style.width=`${width}px`;host.style.height=`${height}px`;
    await instance.setViewport({x:-bounds.x*scale,y:-bounds.y*scale,zoom:scale});
    await frame(signal);
    signal.throwIfAborted();
    // The exporter has no cancellation API. Keep this request's admission slot
    // until it settles, even if cancellation already detached the capture root.
    // Static export positioning also neutralizes computed logical insets copied
    // from the offscreen host; resetting only left/top leaves it outside the image.
    const dataUrl=await toPng(host,{width,height,pixelRatio:1,backgroundColor:getComputedStyle(host).backgroundColor,style:{position:'static'},filter:node=>!node.classList?.contains('react-flow__attribution')});
    signal.throwIfAborted();
    const data=dataUrl.slice(dataUrl.indexOf(',')+1);
    if(Math.floor(data.length*3/4)>policy.maxImageBytes)throw new LayoutError('CANVAS_LIMIT','Snapshot exceeds the configured image byte budget. Use a focused snapshot.');
    return {nodes,image:{data,width,height,bounds}};
  }finally{signal.removeEventListener('abort',dispose);dispose();}
}

function Measured({empty,ready}:{empty:boolean;ready:(instance:ReactFlowInstance)=>void}) {
  const initialized=useNodesInitialized(),instance=useReactFlow();
  useEffect(()=>{if(instance.viewportInitialized&&(empty||initialized))ready(instance);},[initialized,empty,instance,ready]);
  return null;
}

/** Cancellation detaches listeners immediately, even when a browser font/image
 * operation cannot itself be interrupted. Late completion has no side effects. */
function cancellable<T>(task:PromiseLike<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    if(signal.aborted){reject(signal.reason);return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(task).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
function frame(signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
  const abort=()=>{cancelAnimationFrame(id);reject(signal.reason);};
  const id=requestAnimationFrame(()=>{signal.removeEventListener('abort',abort);resolve();});
  if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
});}
