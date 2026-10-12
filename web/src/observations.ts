import {WorkspaceChange,type WorkspaceScope} from '../../src/workspace-contracts.ts';
import {observeWorker,type WorkerObservation,type Scope} from './native/presentation.ts';
export type BrowserPolicy={nativePicker:{available:boolean;reason?:string};filePageBytes:number;workspaceReadTimeoutMs:number;workspaceDebounceMs:number;workspaceReconcileMs:number;workspaceReadRetries:number;choicesPollMs:number;minPanelWidth:number;minContentWidth:number;keyboardResizeStep:number;maxPdfPages:number;maxPdfPixels:number;maxFileTabs:number;maxExpandedDirectories:number;reconnectMs:number;maxReconnectMs:number;maxSubscriptions:number;maxHistoryEvents:number;historyCacheLimit:number;maxFileBytes:number};
/** Authenticated multiplexed transport. Reconnect opens snapshots, never repeats a command or prompt. */
export class Observations {
 private socket:WebSocket|null=null;private stopped=false;private timer:ReturnType<typeof setTimeout>|undefined;private delay:number;
 readonly workers=new Map<string,WorkerObservation>();
 private workspaces=new Map<string,{scope:WorkspaceScope;listeners:Set<(change:WorkspaceChange)=>void>}>();
 private policy:BrowserPolicy;private activity:()=>void;private connection:(connected:boolean)=>void;
 constructor(policy:BrowserPolicy,activity:()=>void,connection:(connected:boolean)=>void){this.policy=policy;this.activity=activity;this.connection=connection;this.delay=policy.reconnectMs;this.connect();}
 watch(scope:Scope){let worker=this.workers.get(scope.workerId);if(!worker){
  if(this.workers.size>=this.policy.maxSubscriptions)return null;
  worker=observeWorker(scope,()=>this.open(scope),this.policy.maxHistoryEvents);this.workers.set(scope.workerId,worker);this.open(scope);
 }return worker;}
 /** Workspace subscriptions are reference-counted independently of agent observations. */
 observeWorkspace(scope:WorkspaceScope,listener:(change:WorkspaceChange)=>void):()=>void {
  if(this.stopped)return()=>{};
  const key=JSON.stringify([scope.project,scope.node,scope.kind,scope.path]);
  let entry=this.workspaces.get(key);
  if(!entry){entry={scope,listeners:new Set()};this.workspaces.set(key,entry);this.sendWorkspace('workspace-subscribe',scope);}
  const registration=(change:WorkspaceChange)=>listener(change);
  entry.listeners.add(registration);
  let released=false;
  return()=>{
   if(released)return;released=true;entry!.listeners.delete(registration);
   if(!entry!.listeners.size&&this.workspaces.get(key)===entry){this.workspaces.delete(key);this.sendWorkspace('workspace-unsubscribe',scope);}
  };
 }
 private sendWorkspace(kind:'workspace-subscribe'|'workspace-unsubscribe',scope:WorkspaceScope){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({kind,scope}));}
 private open(scope:Scope){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({kind:'subscribe',...scope}));}
 private connect(){const socket=new WebSocket(`ws://${location.host}/api/live`);this.socket=socket;
  socket.onopen=()=>{this.delay=this.policy.reconnectMs;this.connection(true);for(const value of this.workers.values())this.open(value.scope);for(const value of this.workspaces.values())this.sendWorkspace('workspace-subscribe',value.scope);this.activity();};
  socket.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.kind==='refresh'){this.activity();return;}if(value.kind==='workspace-change'){
   const {kind,...payload}=value,change=WorkspaceChange.parse(payload),scope=change.scope;
   const entry=this.workspaces.get(JSON.stringify([scope.project,scope.node,scope.kind,scope.path]));for(const listener of entry?.listeners??[])listener(change);return;
  }const worker=this.workers.get(value.workerId);if(!worker)return;if(value.kind==='snapshot')worker.snapshot(value);else if(value.kind==='observation-error'){worker.fail(value.error);socket.close();}else worker.accept(value);}catch(error){for(const worker of this.workers.values())worker.fail(String(error));socket.close();}};
  socket.onclose=()=>{this.connection(false);for(const entry of this.workspaces.values())for(const listener of entry.listeners)listener({scope:entry.scope,state:'unavailable',detail:'Live updates disconnected.'});for(const worker of this.workers.values())worker.stale();if(!this.stopped){this.timer=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(this.policy.maxReconnectMs,this.delay*2);}};
 }
 close(){this.stopped=true;clearTimeout(this.timer);this.workspaces.clear();for(const worker of this.workers.values())worker.dispose();this.socket?.close();}
}
