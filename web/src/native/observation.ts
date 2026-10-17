import {z} from 'zod';
import {SessionMetrics} from '../../../src/metrics.ts';
import type {PresentationSnapshot,PresentationFrame} from './presentation.ts';
import {createPresentation} from './projection.ts';
import {ClientAssistantStream} from './api/session-controller/src/client/sessions/assistant-stream.ts';
import type {SessionEventLikeEntry,SessionLiveEventEntry} from './api/session-controller/src/client/contract/events.ts';
import type {SessionAssistantStreamBaseline,SessionAssistantStreamFrame} from '@deepseek-ai/dsh-api-session-controller';
import type {HistoryPage,HistoryEvent} from '../../../src/contracts.ts';
import type {ChatNode} from './client/ui-chat/src/client/contract/chat-nodes.ts';
import type {ChatSnapshot} from './client/ui-chat/src/client/contract/snapshot.ts';
import {submissionId} from './receipts.ts';
import {api,ApiError} from '../api.ts';
// Decode only the process-local stream grammar here. Durable source records keep
// their original payload so future event kinds remain available to inspection.
const revision=z.number().int().nonnegative(),attemptId=z.string().min(1);
const location={attemptId,startedAfterSeq:z.number().int().min(-1),turn:revision,step:revision};
const streamBaseline=z.object({revision,activeAttempt:z.object({...location,nextIndex:revision,stream:z.array(z.json())}).optional()});
const streamFrame=z.discriminatedUnion('type',[
 z.object({type:z.literal('start'),revision,...location}),
 z.object({type:z.literal('chunk'),revision,attemptId,index:revision,time:z.number(),chunk:z.json()}),
 z.object({type:z.literal('end'),revision,attemptId,index:revision,outcome:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('committed'),eventType:z.enum(['assistant/message','assistant/attempt']),seq:revision}),
  z.object({kind:z.literal('abandoned')}),
 ])}),
]);
export type Scope={project:string;node:string;workerId:string};
/** One cancellable screen publication; source ingestion never waits for a paint. */
export type PresentationScheduler=(publish:()=>void)=>()=>void;
const schedulePaint:PresentationScheduler=publish=>{
 const frame=requestAnimationFrame(publish);return()=>cancelAnimationFrame(frame);
};
/** One mounted or unmounted worker projection. Scroll and selection never control synchronization. */
export class SourceObservation {
 /** Applied source identities let the composer retire optimistic receipts without reading source records. */
 recordedSubmissions():ReadonlySet<string>{const chat=this.engine.snapshot('chat') as ChatSnapshot;return new Set(chat.order.flatMap(key=>{const node=chat.nodes.get(key) as ChatNode|undefined,id=node&&submissionId(node);return id?[id]:[];}));}
 /** Complete, ordered source evidence, including types unknown to this renderer. */
 inspectSource():HistoryPage|null{return this.page?{...this.page,events:[...this.durable.entries()].sort(([a],[b])=>a-b).map(([,event])=>JSON.parse(event) as HistoryEvent)}:null;}
 get hasHistory(){return this.page!==null;}
 get hasMore(){return Boolean(this.page&&this.page.before!==null);}
 readonly presentationState=new Map<string,unknown>();
 readonly engine=createPresentation(); private fold=new ClientAssistantStream();
 private listeners=new Set<()=>void>(); private entries:SessionEventLikeEntry[]=[];
 private repairing=false;private envelopes=new Map<number,string>();private streamFrames=new Map<number,string>();
 private opening:{generation:string;queue:Parameters<SourceObservation['accept']>[0][]}|null=null;
 private epoch=0;private durable=new Map<number,string>(); private generation='';private sequence=0;private streamRevision=0;
 metrics:SessionMetrics|undefined;
 status:'connecting'|'ready'|'error'='connecting';page:HistoryPage|null=null;error='';loadingOlder=false;version=0;latestRequest=0;
 /** A deliberate navigation command; source updates never manufacture one. */
 latest(){if(this.disposed)return;this.latestRequest++;this.changed();}
 readonly scope:Scope;private repair:()=>void;private maxEvents:number;
 private cancelPaint:(()=>void)|null=null;private disposed=false;private schedule:PresentationScheduler;
 constructor(scope:Scope,repair:()=>void,maxEvents:number,schedule:PresentationScheduler=schedulePaint){this.scope=scope;this.repair=repair;this.maxEvents=maxEvents;this.schedule=schedule;}
 readonly subscribe=(listener:()=>void)=>{if(!this.disposed)this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 readonly getSnapshot=()=>this.version;
 get base(){return `/projects/${this.scope.project}/nodes/${this.scope.node}/workers/${this.scope.workerId}`;}
 private rebaseline(){if(this.repairing||this.disposed)return;this.repairing=true;this.status='connecting';this.publish();this.repair();}
 private changed(){this.version++;for(const listener of this.listeners)listener();}
 /** Materialize the latest fold once per paint; terminal and control changes publish immediately. */
 private publish(){this.cancelPaint?.();this.cancelPaint=null;this.engine.flush();this.changed();}
 fail(error:string){if(this.disposed)return;this.status='error';this.error=error;this.publish();}
 stale(){if(this.disposed)return;this.status='connecting';this.publish();}
 /** Retry a failed source synchronization once, preserving readable history until replacement succeeds. */
 retry(){if(this.disposed||this.status!=='error')return;this.repairing=false;this.rebaseline();}
 /** Retire pending paints and asynchronous history replies when the transport owner closes. */
 dispose(){this.disposed=true;this.epoch++;this.opening=null;this.cancelPaint?.();this.cancelPaint=null;this.listeners.clear();}
 snapshot(envelope:PresentationSnapshot) {
  if(this.disposed)return;
  const value={...envelope,page:envelope.page?.metrics===undefined?envelope.page:{...envelope.page,metrics:SessionMetrics.parse(envelope.page.metrics)},assistantStream:streamBaseline.parse(envelope.assistantStream) as SessionAssistantStreamBaseline};
  this.cancelPaint?.();this.cancelPaint=null;this.epoch++;this.loadingOlder=false;
  if((value.page?.events.length??0)>this.maxEvents){this.fail('Snapshot exceeds configured event budget');this.rebaseline();return;}
  const previous=this.entries.filter(entry=>entry.type==='event').map(entry=>entry.event);
  const latest=value.page?.events??[],first=latest[0]?.seq??Infinity;
  const sameSource=Boolean(value.page&&this.page?.sourceSessionId===value.page.sourceSessionId);
  const overlap=sameSource&&latest.some(event=>this.durable.has(event.seq));
  const consistent=overlap&&latest.every(event=>!this.durable.has(event.seq)||this.durable.get(event.seq)===JSON.stringify(event));
  if(sameSource&&!overlap&&previous.length&&value.page?.before!==null&&value.page?.before!==undefined&&previous[0]!.seq<first) {
    // Keep the reading surface until finite pages bridge the disconnected source cut.
    const opening={generation:value.generation,queue:[] as Parameters<SourceObservation['accept']>[0][]};this.opening=opening;
    void (async()=>{
      let page=value.page!,events=[...page.events],attachments=[...page.attachments];
      while(page.before!==null&&events[0]!.seq>previous[0]!.seq) {
        page=await api<HistoryPage>(`${this.base}/history?cut=${page.cut}&before=${page.before}`);
        if(this.opening!==opening)return;
        events=[...page.events,...events];attachments=[...page.attachments,...attachments];
        if(events.length>this.maxEvents)throw new Error('Recovered history exceeds configured event budget');
      }
      if(this.opening!==opening)return;
      this.install({...value,page:{...value.page!,events,attachments,before:page.before}},[]);
      this.opening=null;
      for(const event of opening.queue)this.accept(event);
    })().catch(error=>{if(this.opening===opening){this.opening=null;this.fail(String(error));}});
    return;
  }
  this.opening=null;
  const retained=consistent?previous.filter(event=>event.seq<first):[];
  this.install(value,retained);
 }
 private install(value:{generation:string;page:HistoryPage|null;assistantStream:SessionAssistantStreamBaseline},retained:HistoryEvent[]) {
  const events=[...retained,...value.page?.events??[]];
  if(events.length>this.maxEvents){this.fail('Snapshot exceeds configured event budget');this.rebaseline();return;}
  this.generation=value.generation;this.sequence=0;this.streamRevision=value.assistantStream.revision;this.error='';this.status='ready';this.repairing=false;this.envelopes.clear();this.streamFrames.clear();
  this.metrics=value.page?.metrics;
  this.page=value.page?{...value.page,before:retained.length?Math.min(value.page.before??0,retained[0]!.seq)||null:value.page.before}:null;
  this.durable=new Map(events.map(event=>[event.seq,JSON.stringify(event)]));
  this.entries=[...this.fold.replace(events.map(event=>({type:'event',event} as SessionLiveEventEntry)),value.assistantStream)];
  this.engine.replaceWindow(this.entries,this.page?.before!==null&&Boolean(this.page));this.engine.flush();this.changed();
 }
 accept(envelope:PresentationFrame) {
  if(this.disposed)return;
  if(envelope.generation!==this.generation&&envelope.generation!==this.opening?.generation)return;
  const value={...envelope,metrics:envelope.metrics===undefined?undefined:SessionMetrics.parse(envelope.metrics),frame:envelope.frame===undefined?undefined:streamFrame.parse(envelope.frame) as SessionAssistantStreamFrame};
  if(this.opening?.generation===value.generation){if(this.opening.queue.length>=this.maxEvents){this.opening=null;this.fail('Opening observation buffer exhausted');this.rebaseline();}else this.opening.queue.push(value);return;}
  const encodedEnvelope=JSON.stringify(value);
  if(value.sequence<=this.sequence){if(this.envelopes.get(value.sequence)!==encodedEnvelope)this.rebaseline();return;}
  if(this.repairing)return;
  this.envelopes.set(value.sequence,encodedEnvelope);while(this.envelopes.size>this.maxEvents)this.envelopes.delete(this.envelopes.keys().next().value!);
  if(value.sequence!==this.sequence+1){this.rebaseline();return;}this.sequence=value.sequence;
  let outcome;
  if(value.kind==='event'&&value.event){
   const prior=this.durable.get(value.event.seq),encoded=JSON.stringify(value.event);
   if(prior){if(prior!==encoded)this.rebaseline();return;}
   let last=-1;for(const seq of this.durable.keys())last=Math.max(last,seq);if(value.event.seq!==last+1){this.rebaseline();return;}
   if(value.metrics!==undefined)this.metrics=value.metrics;
   this.durable.set(value.event.seq,encoded);outcome=this.fold.acceptDurable({type:'event',event:value.event} as SessionLiveEventEntry);
  } else if(value.frame) {
   if(value.frame.revision<=this.streamRevision){if(this.streamFrames.get(value.frame.revision)!==JSON.stringify(value.frame))this.rebaseline();return;}
   this.streamFrames.set(value.frame.revision,JSON.stringify(value.frame));while(this.streamFrames.size>this.maxEvents)this.streamFrames.delete(this.streamFrames.keys().next().value!);
   if(value.frame.revision!==this.streamRevision+1){this.rebaseline();return;}this.streamRevision=value.frame.revision;
   outcome=this.fold.acceptFrame(value.frame);
  }
  if(!outcome){if(value.kind==='event')this.publish();return;}
  if(outcome.type==='rebaseline'){this.rebaseline();return;}
  const retireAttemptId=outcome.type==='publish'?outcome.retireAttemptId:outcome.type==='settlement'||outcome.type==='abandonment'?outcome.attemptId:undefined;
  if(retireAttemptId!==undefined)this.entries=this.entries.filter(entry=>entry.type!=='transient'||entry.event.data.attemptId!==retireAttemptId);
  if(outcome.type!=='abandonment')this.entries.push(outcome.entry);
  if(this.entries.length>this.maxEvents){this.fail('Loaded history exceeds configured event budget');return;}
  const publication=outcome.type==='settlement'?this.engine.settleAssistant(outcome.attemptId,outcome.entry):
   outcome.type==='abandonment'?this.engine.replaceWindow(this.entries,this.page?.before!==null&&Boolean(this.page)):
   this.engine.append(outcome.entry);
  // Successful streams retain preparation until step/end, then retire it after
  // publishing the step boundary so missing dispatches cannot leave ghost tools.
  if(outcome.type==='publish'&&outcome.retireAttemptId!==undefined)this.engine.settleAssistant(outcome.retireAttemptId);
  if(outcome.type==='transient'&&publication!=='immediate'){
   if(publication==='animation-frame'&&!this.cancelPaint)this.cancelPaint=this.schedule(()=>{
    this.cancelPaint=null;
    try{this.publish();}catch(error){this.status='error';this.error=String(error);this.changed();}
   });
  }else this.publish();
 }
 async older():Promise<boolean> {
  if(this.disposed||this.repairing||this.status!=='ready'||this.loadingOlder||!this.page||this.page.before===null)return false;
  const epoch=this.epoch,page=this.page;
  this.loadingOlder=true;this.changed();
  try {
   const result=await api<HistoryPage>(`${this.base}/history?cut=${page.cut}&before=${page.before}`);
   if(epoch!==this.epoch)return false;
   if(result.sourceSessionId!==page.sourceSessionId||result.cut!==page.cut||
     (result.before!==null&&(result.before>=page.before!||!result.events.length))||
     result.events.some(event=>event.seq>=page.before!))throw new Error('Earlier history did not advance within the current source cut');
   const entries=result.events.filter(event=>!this.durable.has(event.seq)).map(event=>({type:'event',event} as SessionLiveEventEntry));
   if(this.entries.length+entries.length>this.maxEvents)throw new Error('Loaded history exceeds configured event budget');
   for(const entry of entries)this.durable.set(entry.event.seq,JSON.stringify(entry.event));
   this.entries=[...entries,...this.entries];this.page={...result,attachments:[...result.attachments,...this.page!.attachments]};this.error='';
   this.engine.prepend(entries,result.before!==null);this.cancelPaint?.();this.cancelPaint=null;this.engine.flush();return true;
  } catch(error){if(epoch===this.epoch){this.error=String(error);if(error instanceof ApiError&&error.code==='HISTORY_CUT_EXPIRED')this.rebaseline();}return false;}finally{if(epoch===this.epoch){this.loadingOlder=false;this.changed();}}
 }
}
