import React,{useEffect,useRef,useState} from 'react';
import {ReactFlow,Controls,MarkerType,Position,useStore,useNodesInitialized,useReactFlow,type Node as FlowNode} from '@xyflow/react';
import type {Graph,EdgeRecord,NodeActivity} from '../../src/contracts.ts';
import {Tooltip} from './ui/index.ts';
import {graphLayout,type Point} from './graph-layout.ts';

/** Both interactive and capture surfaces use the same neutral card/edge projection.
 * Descriptions stay in the inspector; status never determines card placement. */
export function graphElements(graph:Graph,activity:NodeActivity[],positions:Record<string,Point>,showArchived:boolean,selected='') {
  const summaries=new Map(activity.map(summary=>[summary.nodeId,summary]));
  const nodes:FlowNode[]=graph.nodes.filter(n=>showArchived||!n.archived).map(n=>{
    const summary=summaries.get(n.id);
    return {id:n.id,position:positions[n.id]!,sourcePosition:Position.Right,targetPosition:Position.Left,
      data:{label:<div className="graph-node">{n.archived&&<small>ARCHIVED</small>}<b>{n.title}</b>
        <div className="graph-workers">{summary?<>
          <div className="worker-count">{summary.total} {summary.total===1?'worker':'workers'}</div>
          <div className="worker-states">{Object.entries(summary.states).filter(([,count])=>count>0).map(([state,count])=><span key={state}><i aria-hidden="true" className={`worker-light ${state}`}/>{count} {state}</span>)}</div>
          {summary.permissions>0&&<div className="worker-attention">{summary.permissions} awaiting permission</div>}
        </>:<div className="worker-count">Worker status unavailable</div>}</div>
      </div>},selected:n.id===selected};
  });
  const visible=new Set(nodes.map(node=>node.id));
  const edges=graph.edges.filter(e=>!e.retracted&&visible.has(e.from)&&visible.has(e.to)).map(e=>({id:e.id,source:e.from,target:e.to,label:e.relation,markerEnd:{type:MarkerType.ArrowClosed},type:'default'}));
  return {nodes,edges};
}

/** Human drags and worker edits share the browser owner. A worker update refreshes
 * positions only; the mounted camera is never restored or fitted as a side effect. */
export function GraphCanvas({project,graph,activity,showArchived,selected,onNode,onEdge,onConnect,onError}:{project:string;graph:Graph;activity:NodeActivity[];showArchived:boolean;selected:string;onNode:(id:string)=>void;onEdge:(edge:EdgeRecord)=>void;onConnect:(from:string,to:string)=>void;onError:(message:string)=>void}) {
  const [layout]=useState(()=>graphLayout(project));
  const [initialViewport]=useState(()=>layout.viewport);
  const [positions,setPositions]=useState<Record<string,Point>>({});
  const [,refresh]=useState(0);
  const [measurements,setMeasurements]=useState<Record<string,{width:number;height:number}>>({});
  const drag=useRef(false);
  useEffect(()=>layout.subscribe(()=>{setPositions({});refresh(value=>value+1);}),[layout]);
  useEffect(()=>{const cancel=()=>layout.endDrag(null);window.addEventListener('blur',cancel);window.addEventListener('pointercancel',cancel);return()=>{cancel();window.removeEventListener('blur',cancel);window.removeEventListener('pointercancel',cancel);};},[layout]);
  const elements=graphElements(graph,activity,{...layout.positions(graph.nodes.map(node=>node.id)),...positions},showArchived,selected);
  const nodes=elements.nodes.map(node=>({...node,measured:measurements[node.id]}));
  const report=(error:unknown)=>onError(error instanceof Error?error.message:String(error));
  return <ReactFlow defaultViewport={initialViewport} onMoveEnd={(_,viewport)=>{void layout.setViewport(viewport).catch(report);}}
    panOnScroll panOnScrollSpeed={1.0} zoomOnScroll={false} zoomOnPinch
    onConnect={connection=>onConnect(connection.source,connection.target)} nodes={nodes} edges={elements.edges}
    onNodesChange={changes=>{
      const dimensions=changes.filter(c=>c.type==='dimensions').filter(c=>c.dimensions);
      if(dimensions.length)setMeasurements(prior=>({...prior,...Object.fromEntries(dimensions.map(c=>[c.id,c.dimensions!]))}));
      const moved=changes.filter(c=>c.type==='position').filter(c=>c.position);
      if(moved.length){
        if(!drag.current){drag.current=true;void layout.beginDrag().catch(report).finally(()=>{drag.current=false;setPositions({});});}
        setPositions(prior=>({...prior,...Object.fromEntries(moved.map(c=>[c.id,c.position!]))}));
        const settled=moved.filter(change=>change.dragging!==true);
        if(settled.length)layout.endDrag(settled.map(change=>({id:change.id,position:change.position!})));
      }
    }}
    onNodeDragStart={()=>{if(!drag.current){drag.current=true;void layout.beginDrag().catch(report).finally(()=>{drag.current=false;setPositions({});});}}}
    onNodeClick={(_,n)=>onNode(n.id)} onEdgeClick={(_,e)=>onEdge(graph.edges.find(x=>x.id===e.id)!)} minZoom={0.3} maxZoom={1.6}>
    <InitialView restore={initialViewport!==undefined}/><GraphControls/>
  </ReactFlow>;
}

/** Fit once when no camera is saved. Membership/status changes never seize the camera. */
function InitialView({restore}:{restore:boolean}) {
  const initialized=useNodesInitialized(),{fitView,viewportInitialized}=useReactFlow(),seen=useRef(false);
  useEffect(()=>{if(!initialized||!viewportInitialized||seen.current)return;seen.current=true;if(!restore)void fitView();},[initialized,viewportInitialized,restore,fitView]);
  return null;
}

function GraphControls() {
  const {zoomIn,zoomOut,fitView}=useReactFlow();
  const canZoomIn=useStore(state=>state.transform[2]<state.maxZoom),canZoomOut=useStore(state=>state.transform[2]>state.minZoom);
  return <Controls showZoom={false} showFitView={false} showInteractive={false}>
    <Tooltip label="Zoom in" side="right"><button type="button" className="react-flow__controls-button" aria-label="Zoom in" disabled={!canZoomIn} onClick={()=>void zoomIn()}>+</button></Tooltip>
    <Tooltip label="Zoom out" side="right"><button type="button" className="react-flow__controls-button" aria-label="Zoom out" disabled={!canZoomOut} onClick={()=>void zoomOut()}>−</button></Tooltip>
    <Tooltip label="Fit view" side="right"><button type="button" className="react-flow__controls-button" aria-label="Fit view" onClick={()=>void fitView()}><svg viewBox="0 0 20 20" style={{fill:'none'}} stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button></Tooltip>
  </Controls>;
}
