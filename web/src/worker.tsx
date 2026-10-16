import React,{useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {WorkerView,Submission,StagedImage,ModelOption} from '../../src/contracts.ts';
import type {EnvironmentChoice,EnvironmentRef} from '../../src/environment/contracts.ts';
import type {WorkerObservation} from './native/presentation.ts';
import {Conversation,Trajectory,SessionStatistics} from './native/views.tsx';
import {ActionMenu} from './action-menu.tsx';
import {Select} from './select.tsx';
import {Tooltip,IconPlayOutline16,IconStopFill16,IconSendOutline14} from './ui/index.ts';
import {api,upload,uuid,ApiError} from './api.ts';
import {canSendMessage,saveOutgoing,restoreOutgoing,recoverOutgoing,type Outgoing} from './messages.ts';
/** Retained creation evidence and current setup remain inspectable without execution. */
function WorkerCreation({worker,modelName}:{worker:WorkerView;modelName:string}){
 const {creation,residency}=worker,{specification}=creation;
 return <details className="worker-creation"><summary>Worker creation</summary><dl>
  <dt>Created</dt><dd>{new Date(creation.createdAt).toLocaleString()}</dd>
  <dt>Created by</dt><dd>{creation.creator.kind==='owner'?'Local owner':`Worker ${creation.creator.id}`}</dd>
  {creation.creator.kind==='worker'&&<><dt>Creator process</dt><dd>{creation.creator.processId}</dd></>}
  <dt>Execution</dt><dd>{residency.phase}</dd>
  <dt>Automatic unloading</dt><dd>{residency.timeoutMs===null?'Disabled':`After ${residency.timeoutMs/60000} minutes of confirmed inactivity`}</dd>
  {residency.lastUnloadedAt!==null&&<><dt>Last idle unload</dt><dd>{new Date(residency.lastUnloadedAt).toLocaleString()}</dd></>}
  {residency.blockers.length>0&&<><dt>Keeping resident</dt><dd>{residency.blockers.join(', ')}</dd></>}
  <dt>Creation request</dt><dd>{creation.requestId}</dd>
  <dt>Initial title</dt><dd>{specification.title}</dd>
  <dt>Selected model</dt><dd>{modelName}</dd>
  <dt>{worker.environment.locked?'Assigned environment':'Selected environment'}</dt><dd>{worker.environment.selection?`${worker.environment.selection.name} · revision ${worker.environment.selection.revisionId}`:'No environment'}</dd>
  {specification.systemPrompt&&<><dt>Instruction source</dt><dd>{specification.systemPrompt.sourcePath}</dd><dt>Instruction SHA-256</dt><dd>{creation.instructionDigest}</dd></>}
 </dl>{specification.systemPrompt?<><p>Captured at creation. Subsequent source-file edits do not change these instructions.</p><pre tabIndex={0} aria-label="Captured worker instructions">{specification.systemPrompt.text}</pre></>:<p>No additional worker instructions.</p>}</details>;
}
type DraftImage=Pick<StagedImage,'id'|'name'>&{preview:string};
// Revision names belong to an environment; the picker must preserve the full reference.
const environmentKey=(value:EnvironmentRef|null)=>value?JSON.stringify([value.environmentId,value.revisionId]):'';
/** Keep worker state mounted across module navigation. Visibility gates reading
 * and restoration independently of the worker's execution state and source feed. */
export function WorkerPane({visible,choicesPollMs,notices,worker,observation,onError,onChanged,projectName,onGraph,details,onDetails}:{visible:boolean;choicesPollMs:number;notices?:React.ReactNode;worker:WorkerView;observation:WorkerObservation;onError:(s:string)=>void;onChanged:()=>void;projectName:string;onGraph:()=>void;details:HTMLElement|null;onDetails:()=>void}) {
 const version=useSyncExternalStore(observation.subscribe,observation.getSnapshot),base=observation.base;
 const [tab,setTab]=useState<'conversation'|'trajectory'>(()=>sessionStorage.getItem(`polariton.tab.${worker.id}`)==='trajectory'?'trajectory':'conversation');
 const [inspectedCall,setInspectedCall]=useState<string|null>(null);
 const inspectCall=useCallback((callId:string)=>{setInspectedCall(callId);setTab('trajectory');onDetails();},[onDetails]);
 const completeInspection=useCallback(()=>setInspectedCall(null),[]);
 const [draft,setDraft]=useState(localStorage.getItem(`polariton.draft.${worker.id}`)??''),[images,setImages]=useState<DraftImage[]>(()=>{try{return JSON.parse(localStorage.getItem(`polariton.images.${worker.id}`)??'[]') as DraftImage[];}catch{return [];}}),[busy,setBusy]=useState(false);
 useEffect(()=>{localStorage.setItem(`polariton.images.${worker.id}`,JSON.stringify(images));},[images,worker.id]);
 const [restoredOutbox]=useState(()=>{try{return {messages:restoreOutgoing(localStorage.getItem(`polariton.outbox.${worker.id}`)),error:''};}catch{return {messages:[] as Outgoing[],error:'Saved message receipts could not be read. Inspect this worker’s history before dismissing them.'};}});
 const [outbox,setOutbox]=useState<Outgoing[]>(restoredOutbox.messages),[outboxError,setOutboxError]=useState(restoredOutbox.error);
 const sending=useRef(false);
 useEffect(()=>{if(outboxError)return;try{localStorage.setItem(`polariton.outbox.${worker.id}`,saveOutgoing(outbox));}catch{setOutboxError('Message receipts could not be saved in this browser.');}},[outbox,worker.id,outboxError]);
 // Reconnect and worker refresh reconcile old identities independently of the recent receipt page.
 useEffect(()=>{
  const controller=new AbortController(),snapshot=outbox;
  void recoverOutgoing(snapshot,worker.submissions,id=>api<Submission>(`${base}/submissions/${id}`,undefined,controller.signal)).then(recovered=>{
   if(controller.signal.aborted)return;
   const byId=new Map(recovered.map(value=>[value.request.id,value]));
   setOutbox(current=>current.flatMap(value=>snapshot.includes(value)?(byId.has(value.request.id)?[byId.get(value.request.id)!]:[]):[value]));
  });
  return()=>controller.abort();
 },[base,worker.submissions]);
 const [setup,setSetup]=useState<{models:ModelOption[];environments:EnvironmentChoice[];environmentError:string|null}|null>(null),[setupError,setSetupError]=useState<string|null>(null);
 const refreshSetup=useCallback(()=>{let mounted=true;void api<{models:ModelOption[];environments:EnvironmentChoice[];environmentError:string|null}>(`${base}/setup`).then(value=>{if(mounted){setSetup(value);setSetupError(null);}},error=>{if(mounted)setSetupError(String(error));});return ()=>{mounted=false;};},[base]);
 useEffect(()=>{let stopped=false,timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const value=await api<{models:ModelOption[];environments:EnvironmentChoice[];environmentError:string|null}>(`${base}/setup`);if(!stopped){setSetup(value);setSetupError(null);}}catch{if(!stopped)setSetupError('Configuration choices are unavailable; showing last known choices.');}finally{if(!stopped)timer=setTimeout(poll,choicesPollMs);}};void poll();return()=>{stopped=true;clearTimeout(timer);};},[base,choicesPollMs]);
 useEffect(()=>{localStorage.setItem(`polariton.draft.${worker.id}`,draft);},[draft,worker.id]);
 useEffect(()=>{sessionStorage.setItem(`polariton.tab.${worker.id}`,tab);},[tab,worker.id]);
 // Native source identity, rather than receipt arrival, retires optimistic content.
 useEffect(()=>{const recorded=new Set([...observation.recordedSubmissions(),...worker.submissions.filter(value=>value.kind==='interrupt'&&value.state==='completed').map(value=>value.id)]);setOutbox(previous=>previous.some(value=>recorded.has(value.request.id))?previous.filter(value=>!recorded.has(value.request.id)):previous);},[version,worker.submissions]);
 const command=async(action:string,body:unknown={})=>{if(sending.current)return;sending.current=true;setBusy(true);try{await api(`${base}/${action}`,body);onChanged();}catch(error){onError((error as Error).message);}finally{sending.current=false;setBusy(false);}};
 const submit=async(value:Outgoing)=>{
  if(sending.current)return;sending.current=true;setBusy(true);onError('');
  setOutbox(previous=>[...previous.filter(item=>item.request.id!==value.request.id),{...value,error:undefined,rejected:undefined}]);
  try{localStorage.setItem(`polariton.outbox.${worker.id}`,saveOutgoing([...outbox.filter(item=>item.request.id!==value.request.id),value]));const receipt=await api<Submission>(`${base}/submissions`,value.request);setOutbox(previous=>previous.map(item=>item.request.id===value.request.id?{...item,receipt,error:undefined,rejected:undefined}:item));onChanged();}
  catch(error){const message=(error as Error).message;setOutbox(previous=>previous.map(item=>item.request.id===value.request.id?{...item,error:message,rejected:error instanceof ApiError&&error.status<500,...error instanceof ApiError&&error.status<500?{}:{recovering:true as const}}:item));onError(message);}
  finally{sending.current=false;setBusy(false);}
 };
 const canSend=canSendMessage({busy,storageBlocked:Boolean(outboxError),text:draft,imageCount:images.length,state:worker.state,cleanupPending:worker.cleanupPending});
 const send=()=>{if(sending.current||!canSend)return;const value:Outgoing={createdAt:Date.now(),request:{id:uuid(),text:draft,content:[...(draft?[{type:'text' as const,text:draft}]:[]),...images.map(image=>({type:'image' as const,attachmentId:image.id}))]}};observation.latest();setDraft('');setImages([]);void submit(value);};
 const editMessage=(value:Outgoing)=>{if(('kind' in value.request)||!value.rejected)return;setDraft(value.request.text);setImages(value.request.content.flatMap(part=>part.type==='image'?[{id:part.attachmentId,name:'Attached image',preview:`/api${base}/staged-image?id=${encodeURIComponent(part.attachmentId)}`}]:[]));setOutbox(previous=>previous.filter(item=>item.request.id!==value.request.id));};
 const interrupt=()=>{if(sending.current||outbox.some(value=>'kind' in value.request))return;void submit({createdAt:Date.now(),request:{id:uuid(),kind:'interrupt',text:''}});};
 const addImages=async(files:File[])=>{if(sending.current||busy)return;if(['interrupting','closed','uncertain'].includes(worker.state)||worker.cleanupPending)return;if(!worker.imageCapability){onError('Select and confirm an image-capable model before adding images.');return;}sending.current=true;setBusy(true);try{for(const file of files){const id=uuid(),receipt=await upload<StagedImage>(`${base}/images?${new URLSearchParams({id,name:file.name||'Pasted image',mediaType:file.type})}`,file,()=>{});const preview=`/api${base}/staged-image?id=${id}`;setImages(prior=>[...prior,{...receipt,preview}]);}}catch(error){onError(String(error));}finally{sending.current=false;setBusy(false);}};
 const active=['running','starting','interrupting'].includes(worker.state);
 const modelOptions=setup?.models.find(option=>option.id==='model')?.options??[];
 const modelName=modelOptions.find(option=>option.value===worker.model)?.name??(worker.model?JSON.parse(worker.model)[1]:setup?'No model selected':'Loading models…');
 const environmentName=worker.environment.selection?.name??'No environment';
 return <section className="worker-pane">
  {details&&createPortal(<WorkerCreation worker={worker} modelName={modelName}/>,details)}
  <header className="chat-header">
   <div className="chat-heading">
    <Tooltip label={`Back to graph · ${projectName}`} side="bottom"><button className="chat-graph" onClick={onGraph} aria-label="Back to graph">
     <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.7 7.6-4.4m-7.6 7 7.6 4.4"/></svg>
    </button></Tooltip>
    <div className="chat-identity"><Tooltip label={worker.title} side="bottom"><b>{worker.title}</b></Tooltip><span className="chat-status">{worker.state}</span></div>
   </div>
   <div className="chat-views" role="group" aria-label="Worker view">
    <Tooltip label="Conversation" side="bottom"><button className={tab==='conversation'?'active':''} aria-pressed={tab==='conversation'} aria-label="Conversation" onClick={()=>setTab('conversation')}>
     <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3.5h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3v-3a2 2 0 0 1-1-1.7V5.5a2 2 0 0 1 2-2Z"/></svg>
    </button></Tooltip>
    <Tooltip label="Trajectory" side="bottom"><button className={tab==='trajectory'?'active':''} aria-pressed={tab==='trajectory'} aria-label="Trajectory" onClick={()=>setTab('trajectory')}>
     <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 10h4l2.5-6 4 12 2.5-6h4"/></svg>
    </button></Tooltip>
   </div>
   <ActionMenu label="Worker controls" actions={[
    {label:'Worker details',icon:<span aria-hidden="true">ⓘ</span>,onSelect:onDetails},
    {label:'Resume',icon:<IconPlayOutline16/>,disabled:active||busy||(!worker.harnessSessionId&&!['failed','uncertain','closed'].includes(worker.state)),onSelect:()=>void command('resume')},
    {label:'Close worker',icon:<IconStopFill16/>,onSelect:()=>void command('close')},
  ]}/></header>
  {notices}
  {outboxError&&<div className="notice" role="alert">{outboxError}<button onClick={()=>{localStorage.removeItem(`polariton.outbox.${worker.id}`);setOutboxError('');}}>Dismiss saved receipts</button></div>}
  {worker.mcp.some(value=>value.status==='unavailable')&&<div className="notice" role="status"><details><summary>Some environment tools are unavailable. This worker can continue.</summary><p>Last activation check. Fix the affected component, then close and resume this worker to retry.</p><ul>{worker.mcp.map(value=><li key={value.componentId}>{value.componentId}: {value.status}{value.code?` (${value.code})`:''}</li>)}</ul></details></div>}
   {observation.status==='connecting'&&<div className="notice" role="status">Synchronizing worker…</div>}{worker.error&&<div className="notice">{worker.error}</div>}{observation.error&&<div className="notice" role="alert">{observation.error}{observation.status==='error'&&<button onClick={()=>observation.retry()}>Retry source</button>}</div>}
  <div className="conversation-body" hidden={tab!=='conversation'}>
   <Conversation active={visible&&tab==='conversation'} observation={observation} submissions={worker.submissions} outgoing={outbox} busy={busy} edit={editMessage} retry={value=>void submit(value)} retrySetup={id=>void command(`submissions/${id}/retry`)} dismiss={id=>setOutbox(previous=>previous.filter(value=>value.request.id!==id))} onInspectCall={inspectCall}/>
  </div>
  {worker.submissions.filter(s=>s.kind==='interrupt'&&['pending','failed','uncertain'].includes(s.state)).map(s=><div className="notice" role="status" key={s.id}>Interrupt · {s.detail??s.state}</div>)}
  <div className="trajectory-host" hidden={tab!=='trajectory'}><Trajectory observation={observation} details={details} onDetails={onDetails} focus={inspectedCall} onFocusComplete={completeInspection}/></div>
  {outbox.filter(value=>'kind' in value.request).map(value=>{const receipt=worker.submissions.find(receipt=>receipt.id===value.request.id)??value.receipt;return <div className="notice" role="status" key={value.request.id}>{receipt?.detail??(receipt?`Interrupt: ${receipt.state}`:value.error?'Interrupt outcome is unconfirmed.':'Interrupting…')}{value.error&&!receipt&&<button disabled={busy} onClick={()=>void submit(value)}>Retry same interrupt</button>}</div>;})}
  {worker.permissions.map(permission=><div className="permission" key={permission.id}><b>Permission required · {permission.title}</b><pre>{permission.detail}</pre><div className="row">{permission.options.map(option=><button key={option.optionId} onClick={()=>void command('permissions',{id:permission.id,option:option.optionId})}>{option.name}</button>)}</div></div>)}
  <div className="composer" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void addImages([...e.dataTransfer.files]);}} onPaste={e=>{const files=[...e.clipboardData.files];if(files.length){e.preventDefault();void addImages(files);}}}>
   {images.length>0&&<div className="draft-images">{images.map(image=><figure key={image.id}><img src={image.preview} alt={image.name}/><button aria-label={`Remove ${image.name}`} onClick={()=>{setImages(prior=>prior.filter(value=>value.id!==image.id));}}>×</button></figure>)}</div>}
   {setupError&&<div className="notice" role="alert">Model choices unavailable.<button onClick={refreshSetup}>Retry choices</button></div>}{setup?.environmentError&&<div className="muted setup-note">{setup.environmentError}</div>}{worker.cleanupPending&&<div className="notice" role="alert">Environment cleanup is pending. Retry Close worker before changing setup.</div>}
   <textarea aria-label="Message" aria-keyshortcuts="Shift+Enter Control+Enter Meta+Enter" placeholder="Send a message…" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.shiftKey||e.metaKey||e.ctrlKey)&&!e.altKey&&!e.repeat&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/>
   <div className="composer-footer"><label className="image-picker"><span aria-hidden="true">＋</span> Image<input aria-label="Add chat images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={busy||!worker.imageCapability||worker.cleanupPending||['interrupting','closed','uncertain'].includes(worker.state)} onChange={e=>{void addImages([...e.target.files??[]]);e.target.value='';}}/></label><div className="composer-controls">
    <Select label="Environment" className="composer-choice composer-environment" value={environmentKey(worker.environment.selection)}
      tooltip={worker.environment.locked?'Environment is fixed after activation. Create a new worker to change it.':environmentName}
      disabled={!worker.environment.locked&&(busy||active||worker.cleanupPending)} onFocus={()=>refreshSetup()}
      onChange={value=>{if(!worker.environment.locked)void command('environment',{selection:setup?.environments.find(choice=>environmentKey(choice.environment)===value)?.environment??null});}}
      options={worker.environment.locked?[
        {value:environmentKey(worker.environment.selection),label:environmentName},
        {value:'locked',label:'Fixed after activation — create a new worker to change',disabled:true},
      ]:[{value:'',label:'No environment'},
        ...(worker.environment.selection&&!setup?.environments.some(choice=>environmentKey(choice.environment)===environmentKey(worker.environment.selection))?[{value:environmentKey(worker.environment.selection),label:`${worker.environment.selection.name} (unavailable)`}]:[]),
        ...(setup?.environments.map(choice=>({value:environmentKey(choice.environment),label:choice.environment.name}))??[])]}/>
    <Select label="Model" className="composer-choice composer-model" value={worker.model??''} tooltip={modelName}
      disabled={busy||active||worker.state==='uncertain'||worker.cleanupPending||!setup}
      onChange={value=>void command('configure',{configId:'model',value})}
      options={[...(!modelOptions.some(option=>option.value===worker.model)?[{value:worker.model??'',label:modelName}]:[]),...modelOptions.map(option=>({value:option.value,label:option.name}))]}/>
    <div className="composer-actions">{active&&<button disabled={busy||worker.state==='interrupting'} onClick={interrupt}>Interrupt</button>}<Tooltip label="Send · Shift + Return" side="top"><span className="composer-send-hint"><button className="primary composer-send" aria-label="Send" aria-keyshortcuts="Shift+Enter Control+Enter Meta+Enter" disabled={!canSend} onClick={send}><span aria-hidden="true"><IconSendOutline14 size={18}/></span></button></span></Tooltip></div></div></div>
  </div>
  <SessionStatistics observation={observation}/>
 </section>;
}
