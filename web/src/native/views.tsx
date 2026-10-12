import '../ui/native-base.css';
import '../ui/native-gradient-shadow-text.css';
import '../ui/native-design-platform.css';
import '../ui/native-focus.css';
import {StatsPills} from './client/ui-chat/src/client/chat/StatsPills.tsx';
import {ContextMeter} from './client/ui-conversation/src/client/skeleton/ContextMeter.tsx';
import {metricsTranslate} from './metrics.ts';
import React,{memo,useCallback,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {submissionContent,type Submission} from '../../../src/contracts.ts';
import type {Outgoing} from '../messages.ts';
import type {WorkerObservation} from './presentation.ts';
import {SourceObservation} from './observation.ts';
import type {ChatNode} from './client/ui-chat/src/client/contract/chat-nodes.ts';
import type {ChatSnapshot} from './client/ui-chat/src/client/contract/snapshot.ts';
import type {TrajectorySnapshot} from './client/ui-trajectory/src/client/trajectory-contract.ts';
import {TrajectoryView} from './client/ui-trajectory/src/client/TrajectoryView.tsx';
import {PresentationState} from './worker-state.tsx';
import {ConversationViewport} from './conversation-viewport.tsx';
import {InspectorContext} from './outlet.tsx';
import {translate} from './client/ui-trajectory/src/client/locales.ts';
import {conversationRows,messageStatus,type MessageRow} from './receipts.ts';
import {bindChat,chatTranslate} from './conversation-rendering.tsx';
import type {RenderMessageImages} from './conversation.ts';
import {ChatGroupSeat} from './client/ui-chat/src/client/chat/ChatGroupSeat.tsx';
import {ChatNodeSeat} from './client/ui-chat/src/client/chat/ChatNodeSeat.tsx';
import {UserStyleBubble} from './client/ui-chat/src/client/chat/MessageItem.tsx';
import {RecordedImages} from './images.tsx';
import {DisclosureIdentity} from './client/ui-chat/src/client/chat/use-disclosure.ts';
import {MessageIconActions} from './client/ui-chat/src/client/chat/MessageIconActions.tsx';

// Only this integration can consume source projections. The application holds
// the narrow reading handle returned by observeWorker.
function source(observation:WorkerObservation):SourceObservation{
 if(!(observation instanceof SourceObservation))throw new Error('Unknown harness presentation handle');
 return observation;
}
/** Keep the same DOM row while admission becomes a recorded DSH message. */
const UserRow=memo(function UserRow({row,base,renderMessageImages,busy,retry,retrySetup,dismiss,edit}:{row:MessageRow;base:string;renderMessageImages:RenderMessageImages;busy:boolean;retry:(value:Outgoing)=>void;retrySetup:(id:string)=>void;dismiss:(id:string)=>void;edit:(value:Outgoing)=>void}){
 const node=row.node,recorded=node&&(node.kind==='user'||node.kind==='steering')?node:undefined;
 const value=row.submission,local=row.outgoing,status=messageStatus(row);
 const time=local?.createdAt??value?.attempts?.[0]?.at??recorded?.data.time;
 const content=value?submissionContent(value):(local&&!('kind' in local.request)?local.request.content:[]);
 return <DisclosureIdentity.Provider value={row.key}><article className="native-user-message" data-record={row.key}>
  <UserStyleBubble content={recorded?.data.content??content} renderMessageImages={renderMessageImages} t={chatTranslate}
    echo={!recorded} referenceLabels={recorded?.data.referenceLabels} skillNames={recorded?.data.skillNames}
    previewAttachments={recorded?undefined:content.flatMap(part=>part.type==='image'?[{type:'image' as const,image:{preview:{url:`/api${base}/staged-image?id=${encodeURIComponent(part.attachmentId)}`,name:'Attached image'}}}]:[])}
    actions={text=><MessageIconActions text={text} time={time} clock="start" t={chatTranslate}/>}/>
  {status&&<div className="message-delivery" role={value?.state==='failed'||value?.state==='uncertain'||local?.error?'alert':'status'}>{status}</div>}
  {value?.state==='failed'&&value.retryable&&<button disabled={busy} onClick={()=>retrySetup(value.id)}>Retry setup and send</button>}
  {!value&&local?.error&&<div className="row"><button disabled={busy} onClick={()=>retry(local)}>Retry same message</button>{local.rejected&&<button disabled={busy} onClick={()=>edit(local)}>Edit message</button>}<button disabled={busy} onClick={()=>dismiss(local.request.id)}>Dismiss receipt</button></div>}
 </article></DisclosureIdentity.Provider>;
},(before,after)=>before.row.node===after.row.node&&before.row.submission===after.row.submission&&before.row.outgoing===after.row.outgoing&&before.base===after.base&&before.renderMessageImages===after.renderMessageImages&&before.busy===after.busy&&before.retry===after.retry&&before.retrySetup===after.retrySetup&&before.dismiss===after.dismiss&&before.edit===after.edit);

/** Render source-backed messages and pending delivery receipts as one stable list. */
export function Conversation({observation,submissions,outgoing,active,onInspectCall,...actions}:{active:boolean;observation:WorkerObservation;submissions:readonly Submission[];outgoing:readonly Outgoing[];busy:boolean;retry:(value:Outgoing)=>void;retrySetup:(id:string)=>void;dismiss:(id:string)=>void;edit:(value:Outgoing)=>void;onInspectCall?:(callId:string)=>void}){
 const actionRef=useRef(actions);actionRef.current=actions;
 const handlers=useMemo(()=>({retry:(value:Outgoing)=>actionRef.current.retry(value),retrySetup:(id:string)=>actionRef.current.retrySetup(id),dismiss:(id:string)=>actionRef.current.dismiss(id),edit:(value:Outgoing)=>actionRef.current.edit(value)}),[]);
 const current=source(observation),base=current.base;
 const version=useSyncExternalStore(current.subscribe,current.getSnapshot);
 const chat=current.engine.snapshot('chat') as ChatSnapshot,groups=current.engine.grouped('chat');
 if(!groups)throw new Error('Native chat grouping is not registered');
 const renderMessageImages=useCallback<RenderMessageImages>(owner=><RecordedImages {...owner} base={base}/>,[base]);
 const binding=useMemo(()=>bindChat(current,chat,groups,renderMessageImages,onInspectCall),[current,chat.nodes,groups,renderMessageImages,onInspectCall]);
 const rows=useMemo(()=>conversationRows(groups.entries,chat.nodes.values() as readonly ChatNode[],submissions,outgoing),[chat,groups.entries,version,submissions,outgoing]);
 const previousKeys=useRef<readonly string[]>([]),nextKeys=rows.map(row=>row.key);
 if(nextKeys.length!==previousKeys.current.length||nextKeys.some((key,index)=>key!==previousKeys.current[index]))previousKeys.current=nextKeys;
 return <PresentationState.Provider value={current.presentationState}><ConversationViewport source={current} active={active} keys={previousKeys.current}>{index=>{
  const row=rows[index]!;
  if(row.kind==='message')return <UserRow row={row.message} base={base} renderMessageImages={renderMessageImages} busy={actions.busy} {...handlers}/>;
  const entry=row.entry;
  return entry.kind==='group'?<ChatGroupSeat {...binding} nodeStore={chat.nodes} groupKey={entry.key}/>:<ChatNodeSeat {...binding} nodeStore={chat.nodes} nodeKey={entry.key} groupPart={entry.groupPart}/>;
 }}</ConversationViewport></PresentationState.Provider>;
}
/** Preserve the full trajectory, inspectors and authorized retained-image access. */
export function Trajectory({observation,details,onDetails,focus,onFocusComplete}:{observation:WorkerObservation;details:HTMLElement|null;onDetails:()=>void;focus?:string|null;onFocusComplete?:()=>void}){
 const current=source(observation),base=current.base,trajectory=current.engine.snapshot('trajectory') as TrajectorySnapshot;
 const [actualDuration,setActualDuration]=useState(true);
 const imageLoader=useCallback(async(attachment:ImageAttachmentRef)=>`/api${base}/image?id=${encodeURIComponent(attachment.attachmentId)}`,[base]);
 const inspector=useMemo(()=>({element:details,onInspect:onDetails}),[details,onDetails]);
 return <><PresentationState.Provider value={current.presentationState}><InspectorContext.Provider value={inspector}><TrajectoryView useSession={select=>select({openState:current.status==='error'?'error':current.status==='connecting'?'loading':'ready',loadingOlder:current.loadingOlder,hasMore:current.hasMore})} useTrajectory={select=>select(trajectory)} useDuration={select=>select(actualDuration)} loadOlder={()=>current.older()} loadImage={imageLoader} setActualDuration={setActualDuration} viewRequest={focus?{view:'trajectory',focus}:undefined} completeViewRequest={onFocusComplete??(()=>{})} renderSlot={(_name,owner)=><RecordedImages {...owner} base={base}/> } t={translate}/></InspectorContext.Provider></PresentationState.Provider>{details&&createPortal(<SourceRecords observation={observation}/>,details)}</>;
}
/** Whole-session metrics stay independent from the paginated conversation window. */
export function SessionStatistics({observation}:{observation:WorkerObservation}){
 const current=source(observation);
 useSyncExternalStore(current.subscribe,current.getSnapshot);
 const metrics=current.metrics;
 return metrics?<div className="session-statistics"><StatsPills metrics={metrics} t={metricsTranslate}/><ContextMeter metrics={metrics} t={metricsTranslate}/></div>:null;
}

/** Inspection never drops unknown records or allocates rendered copies of every
 * payload. The selected event is displayed verbatim within its source envelope. */
function SourceRecords({observation}:{observation:WorkerObservation}){
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<number|null>(null);
 const page=observation.inspectSource();
 if(!page)return null;
 const event=page.events.find(event=>event.seq===selected)??page.events[0];
 return <details className="source-records" onToggle={event=>setOpen(event.currentTarget.open)}><summary>Full source records ({page.events.length})</summary>{open&&<><p>Source {page.sourceSessionId} · format {page.formatVersion} · {page.coverage}</p><label>Source record<select value={event?.seq??''} onChange={event=>setSelected(Number(event.target.value))}>{page.events.map(event=><option key={event.seq} value={event.seq}>#{event.seq} · {event.type}</option>)}</select></label><pre tabIndex={0}>{event?JSON.stringify(event,null,2):'No source records in this window.'}</pre></>}</details>;
}
