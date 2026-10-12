import React,{createContext,useContext,useEffect,useMemo,useState,useRef,useLayoutEffect,useSyncExternalStore,useId} from 'react';
import type {WorkspaceEntry,FilePage,Checkpoint,UploadPublication} from '../../src/contracts.ts';
import type {WorkspaceScope} from '../../src/workspace-contracts.ts';
import type {Observations,BrowserPolicy} from './observations.ts';
import {RefreshResource} from './workspace-resource.ts';
import {api,ApiError,upload,uuid} from './api.ts';
import {Markdown} from './ui/Markdown.tsx';
import {PdfPreview} from './pdf.tsx';
import {CodeBlock,Tooltip,IconBranchOutline16,IconRefreshOutline16,IconChevronDownOutline14,IconChevronRightOutline14,IconWrapLinesOutline16,IconCodeOutline16,IconRightUpOutline14} from './ui/index.ts';
import {FileTypeIcon} from './ui/FileTypeIcon.tsx';
type PreviewState={source:boolean;wrap:boolean;scroll:number;loaded?:number;version?:string};
const defaultPreview:PreviewState={source:false,wrap:false,scroll:0};
type WorkspaceContextValue={base:string;scope:Pick<WorkspaceScope,'project'|'node'>;transport:Observations|null;policy:BrowserPolicy};
const WorkspaceContext=createContext<WorkspaceContextValue>(null!);

/** Mounted views retain their last successful read. Only visible resources subscribe or
 * reconcile; reopening a view checks current disk state without borrowing another node's data. */
function useWorkspaceRead<T>(kind:WorkspaceScope['kind'],path:string,active:boolean,read:(signal:AbortSignal)=>Promise<T>,equal:(a:T,b:T)=>boolean) {
 const {base,scope,transport,policy}=useContext(WorkspaceContext);
 const reader=useRef(read),comparison=useRef(equal);reader.current=read;comparison.current=equal;
 const resource=useMemo(()=>new RefreshResource<T>(signal=>reader.current(signal),{
  requestTimeoutMs:policy.workspaceReadTimeoutMs,retryDelayMs:policy.workspaceDebounceMs,
  maxRetryDelayMs:policy.workspaceReconcileMs,maxRetries:policy.workspaceReadRetries,
 },{equal:(a,b)=>comparison.current(a,b),retryable:error=>!(error instanceof ApiError)||!['FILE_DENIED','FILE_LIMIT','FILE_NOT_FOUND','DIRECTORY_NOT_FOUND','DIRECTORY_LIMIT'].includes(error.code)}),[base,path,kind,policy.workspaceReadTimeoutMs,policy.workspaceDebounceMs,policy.workspaceReconcileMs,policy.workspaceReadRetries]);
 const snapshot=useSyncExternalStore(resource.subscribe,resource.getSnapshot);
 const [watchError,setWatchError]=useState('');
 useEffect(()=>()=>resource.dispose(),[resource]);
 useEffect(()=>{
  if(!active)return;
  let release:(()=>void)|undefined,timer:ReturnType<typeof setInterval>|undefined;
  const stop=()=>{release?.();release=undefined;clearInterval(timer);timer=undefined;};
  const start=()=>{
   stop();if(document.hidden)return;
   resource.invalidate();
   release=transport?.observeWorkspace({...scope,kind,path},change=>{
    setWatchError(change.state==='unavailable'?change.detail??'Live workspace updates unavailable':'');
    if(change.state==='changed')resource.invalidate();
   });
   // Independent reconciliation also covers lost sockets and watcher admission failures.
   timer=setInterval(()=>resource.invalidate(),policy.workspaceReconcileMs);
  };
  const focus=()=>{if(!document.hidden)resource.invalidate();};
  start();document.addEventListener('visibilitychange',start);window.addEventListener('focus',focus);
  return()=>{stop();document.removeEventListener('visibilitychange',start);window.removeEventListener('focus',focus);};
 },[active,resource,transport,scope.project,scope.node,kind,path,policy.workspaceReconcileMs]);
 return {resource,...snapshot,watchError};
}

/** Directory identity and disclosure state survive background refreshes. */
function Directory({path,active,reload,openFile,expanded,toggle}:{path:string;active:boolean;reload:number;openFile:(path:string)=>void;expanded:string[];toggle:(path:string)=>void}) {
 const {base}=useContext(WorkspaceContext);
 const state=useWorkspaceRead('directory',path,active,signal=>api<WorkspaceEntry[]>(`${base}/files?path=${encodeURIComponent(path)}`,undefined,signal),(a,b)=>JSON.stringify(a)===JSON.stringify(b));
 useEffect(()=>{if(active&&reload)state.resource.invalidate();},[reload,active,state.resource]);
 const entries=state.data??[];
 return <div className="directory">
  {!state.data&&!state.error&&<small role="status">Loading files…</small>}
  {state.error&&<p className="workspace-read-status" role="status">{state.data?'Showing last available files. ':''}{state.error.message} <button onClick={state.resource.invalidate}>Retry</button></p>}
  {!state.error&&state.watchError&&<small role="status">{state.watchError} Checking periodically.</small>}
  {state.data&&!state.error&&!entries.length&&<small>Empty directory</small>}
  {entries.map(entry=><div key={entry.path}>
  <Tooltip label={entry.path} side="bottom"><button className="file-row" aria-expanded={entry.kind==='directory'?expanded.includes(entry.path):undefined} onClick={()=>entry.kind==='file'?openFile(entry.path):toggle(entry.path)}>
   <span className="file-disclosure" aria-hidden="true">{entry.kind==='directory'&&(expanded.includes(entry.path)?<IconChevronDownOutline14/>:<IconChevronRightOutline14/>)}</span>
   {entry.kind==='directory'?<FileTypeIcon kind="folder" size={16}/>:<FileTypeIcon path={entry.path} size={16}/>}
   <span className="file-name">{entry.name}</span><small>{entry.bytes===null?'':`${entry.bytes.toLocaleString()} B`}</small>
  </button></Tooltip>
  {entry.kind==='directory'&&expanded.includes(entry.path)&&<Directory path={entry.path} active={active} reload={reload} openFile={openFile} expanded={expanded} toggle={toggle}/>}
 </div>)}</div>;
}
function FilePreview({path,view,onView,maxPdfPages,maxPdfPixels,active}:{active:boolean;maxPdfPages:number;maxPdfPixels:number;path:string;view:PreviewState;onView:(value:PreviewState)=>void}) {
 const {base,policy}=useContext(WorkspaceContext);
 const container=useRef<HTMLDivElement>(null),restored=useRef(false);
 const requested=useRef(Math.min(policy.maxFileBytes,Math.max(policy.filePageBytes,view.loaded??0)));
 const state=useWorkspaceRead('file',path,active,signal=>api<FilePage>(`${base}/file?${new URLSearchParams({path,length:String(requested.current)})}`,undefined,signal),(a,b)=>a.version===b.version&&a.offset===b.offset&&a.next===b.next);
 const page=state.data;
 const viewRef=useRef(view),save=useRef(onView);viewRef.current=view;save.current=onView;
 useEffect(()=>{if(page)save.current({...viewRef.current,loaded:page.next??page.bytes,version:page.version});},[page]);
 useLayoutEffect(()=>{if(active&&page&&container.current&&!restored.current){container.current.scrollTop=view.scroll;restored.current=true;}},[page,view.scroll,active]);
 const extension=path.split('.').at(-1)?.toLowerCase(),image=['png','jpg','jpeg','gif','webp'].includes(extension??''),pdf=extension==='pdf';
 const url=page?`/api${base}/media?${new URLSearchParams({path,version:page.version})}`:'';
 return <div className="file-preview-pane">
  <div className="file-toolbar" role="group" aria-label="File preview actions">
   <div className="file-metadata">{page&&<><span>{page.bytes.toLocaleString()} bytes</span><Tooltip label={`Version ${page.version}`} side="bottom"><code tabIndex={0}>{page.version.slice(0,10)}</code></Tooltip></>}</div>
   <div className="workspace-actions">
    <WorkspaceAction label="Reload file" disabled={state.refreshing} onClick={state.resource.invalidate}><IconRefreshOutline16/></WorkspaceAction>
    {!image&&!pdf&&<WorkspaceAction label="Wrap lines" pressed={view.wrap} onClick={()=>onView({...view,wrap:!view.wrap})}><IconWrapLinesOutline16/></WorkspaceAction>}
    {extension==='md'&&<WorkspaceAction label="Show Markdown source" pressed={view.source} onClick={()=>onView({...view,source:!view.source})}><IconCodeOutline16/></WorkspaceAction>}
    {page&&<Tooltip label="Open original file in new tab" side="bottom"><a className="workspace-icon" href={url} target="_blank" rel="noreferrer" aria-label="Open original file in new tab"><span aria-hidden="true"><IconRightUpOutline14 size={16}/></span></a></Tooltip>}
   </div>
  </div>
  <div ref={container} tabIndex={0} role="region" aria-label={`Preview of ${path}`} className={`file-document ${view.wrap?'wrap-code':''}`} onScroll={e=>{if(restored.current)onView({...view,scroll:e.currentTarget.scrollTop,loaded:page?.next??page?.bytes,version:page?.version});}}>
   {state.error&&<p className="workspace-read-status" role="status">{page?'Showing last available version. ':''}{state.error.message} <button onClick={state.resource.invalidate}>Retry</button></p>}
   {!state.error&&state.watchError&&<small role="status">{state.watchError} Checking periodically.</small>}
   {!page&&!state.error&&<small role="status">Loading file…</small>}
   {page&&<>{image?<img src={url} alt={path}/>:pdf?<PdfPreview url={url} maxPages={maxPdfPages} maxPixels={maxPdfPixels}/>:extension==='md'&&!view.source?<Markdown text={page.text}/>:<CodeBlock code={page.text} lang={extension==='html'?'html':extension} lineNumbers copyLabel="Copy" copiedLabel="Copied"/>}{page.next!==null&&!image&&!pdf&&<button disabled={state.refreshing} onClick={()=>{requested.current=Math.min(policy.maxFileBytes,page.next!+policy.filePageBytes);state.resource.invalidate();}}>Load more</button>}</>}
  </div>
 </div>;
}
/** Icon actions keep their labels available to keyboard users, including disabled reasons. */
function WorkspaceAction({label,disabled=false,pressed,onClick,children}:{label:string;disabled?:boolean;pressed?:boolean;onClick:()=>void;children:React.ReactNode}) {
 return <Tooltip label={label} side="bottom"><button type="button" className="workspace-icon" aria-label={label} aria-pressed={pressed} aria-disabled={disabled} onClick={()=>{if(!disabled)onClick();}}><span aria-hidden="true">{children}</span></button></Tooltip>;
}
/** Selection publishes the original filename. Retained operation identities make retries safe;
 * replacing an existing file remains an explicit, version-checked action after a conflict. */
function WorkspaceActions({base,onReload,onChanged,children}:{base:string;onReload:()=>void;onChanged:()=>void;children:React.ReactNode}) {
 const input=useRef<HTMLInputElement>(null),locked=useRef(false);
 const pending=useRef<{file:File;operation?:UploadPublication}|null>(null),checkpoint=useRef<string|null>(null);
 const [action,setAction]=useState<'upload'|'checkpoint'|null>(null),[progress,setProgress]=useState(0);
 const [error,setError]=useState<{message:string;action:'upload'|'checkpoint';conflict:boolean}|null>(null);
 const {policy}=useContext(WorkspaceContext);
 async function publishFile(selected?:File,replace=false) {
  if(locked.current)return;
  if(selected)pending.current={file:selected};
  const saved=pending.current;if(!saved)return;
  locked.current=true;setAction('upload');setProgress(0);setError(null);
  try {
   if(saved.file.size>policy.maxFileBytes)throw new Error('File exceeds the workspace upload limit');
   if(!saved.operation||replace){
    const digest=saved.operation?.digest??[...new Uint8Array(await crypto.subtle.digest('SHA-256',await saved.file.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const expectedVersion=replace?(await api<FilePage>(`${base}/file?path=${encodeURIComponent(saved.file.name)}`)).version:undefined;
    saved.operation={operationId:uuid(),path:saved.file.name,digest,...expectedVersion?{expectedVersion}:{}};
   }
   await upload(`${base}/uploads?${new URLSearchParams(saved.operation as Record<string,string>)}`,saved.file,setProgress);
   await api(`${base}/uploads/publish`,saved.operation);
   pending.current=null;onChanged();
  }catch(error){setError({message:error instanceof Error?error.message:String(error),action:'upload',conflict:error instanceof ApiError&&error.code==='FILE_CONFLICT'});}
  finally{locked.current=false;setAction(null);}
 }
 async function publishCheckpoint() {
  if(locked.current)return;
  locked.current=true;setAction('checkpoint');setError(null);
  try {
   checkpoint.current??=uuid();
   await api(`${base}/checkpoints`,{id:checkpoint.current});
   checkpoint.current=null;onChanged();
  }catch(error){setError({message:error instanceof Error?error.message:String(error),action:'checkpoint',conflict:false});}
  finally{locked.current=false;setAction(null);}
 }
 return <>
  <div className="section-label workspace-heading"><span>WORKSPACE FILES</span><div className="workspace-actions">
   <WorkspaceAction label="Refresh workspace files" onClick={onReload}><IconRefreshOutline16/></WorkspaceAction>
   <WorkspaceAction label={action==='upload'?`Uploading file (${Math.round(progress*100)}%)`:'Upload file'} disabled={action!==null} onClick={()=>input.current?.click()}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10V2m-3 3 3-3 3 3M3 10v3h10v-3"/></svg></WorkspaceAction>
   <WorkspaceAction label={action==='checkpoint'?'Publishing checkpoint…':'Publish checkpoint'} disabled={action!==null} onClick={()=>void publishCheckpoint()}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M1.5 8h3m7 0h3"/><circle cx="8" cy="8" r="3.5"/></svg></WorkspaceAction>
  </div></div>
  <div className="node-section-scroll" tabIndex={0} role="region" aria-label="Workspace file list">
  <input ref={input} hidden type="file" aria-label="Upload workspace file" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void publishFile(file);}}/>
  {action&&<p className="workspace-action-status" role="status">{action==='upload'?`Uploading ${pending.current?.file.name} · ${Math.round(progress*100)}%`:'Publishing checkpoint…'}</p>}
  {error&&<div className="workspace-action-status" role="alert"><span>{error.conflict?`“${pending.current?.file.name}” already exists or has changed.`:error.message}</span>{error.conflict?<button disabled={action!==null} onClick={()=>void publishFile(undefined,true)}>Replace existing file</button>:<button disabled={action!==null} onClick={()=>void(error.action==='upload'?publishFile():publishCheckpoint())}>Retry</button>}</div>}
  {children}
  </div>
 </>;
}
/** Reveal overflowing checkpoint text at a readable speed without moving the timestamp or widening the row. */
function CheckpointMessage({text}:{text:string}) {
 const viewport=useRef<HTMLSpanElement>(null),content=useRef<HTMLSpanElement>(null),[overflow,setOverflow]=useState(0);
 useLayoutEffect(()=>{
  const outer=viewport.current,inner=content.current;
  if(!outer||!inner)return;
  const measure=()=>setOverflow(Math.max(0,inner.scrollWidth-outer.clientWidth));
  const observer=new ResizeObserver(measure);
  observer.observe(outer);observer.observe(inner);measure();
  return()=>observer.disconnect();
 },[text]);
 return <span ref={viewport} className="checkpoint-message" data-overflow={overflow>0} style={{'--checkpoint-travel':`${-overflow}px`,'--checkpoint-duration':`${Math.max(1,overflow/32)}s`} as React.CSSProperties}><span ref={content}>{text}</span></span>;
}
/** Node files and open previews remain scoped to the node; trajectory inspection has an independent outlet. */
export function WorkspacePanel({maxPdfPages,maxPdfPixels,maxTabs,maxExpanded,base,scope,transport,policy,active,checkpoints,detailsActive,onTab,onDetails,onDetailsElement,onChanged,onContinue}:{maxPdfPages:number;maxPdfPixels:number;maxTabs:number;maxExpanded:number;base:string;scope:Pick<WorkspaceScope,'project'|'node'>;transport:Observations|null;policy:BrowserPolicy;active:boolean;checkpoints:Checkpoint[];detailsActive:boolean;onTab:()=>void;onDetails:()=>void;onDetailsElement:(el:HTMLDivElement|null)=>void;onChanged:()=>void;onContinue:(id:string)=>void}) {
 const key=`polariton.files.${base}`,[tabs,setTabs]=useState<string[]>(()=>{try{return JSON.parse(localStorage.getItem(key)??'[]') as string[];}catch{return [];}}),[selected,setSelected]=useState(()=>localStorage.getItem(key+'.selected')??'node'),[error,setError]=useState('');
 const [expanded,setExpanded]=useState<string[]>(()=>{try{return JSON.parse(localStorage.getItem(key+'.expanded')??'[]');}catch{return [];}}),[views,setViews]=useState<Record<string,PreviewState>>(()=>{try{return JSON.parse(localStorage.getItem(key+'.views')??'{}');}catch{return {};}}),[reload,setReload]=useState(0);
 useEffect(()=>{localStorage.setItem(key+'.expanded',JSON.stringify(expanded));localStorage.setItem(key+'.views',JSON.stringify(views));},[expanded,views,key]);
 const toggle=(path:string)=>{if(!expanded.includes(path)&&expanded.length>=maxExpanded){setError('Expanded directory limit reached; collapse a directory first.');return;}setExpanded(prior=>prior.includes(path)?prior.filter(p=>p!==path):[...prior,path]);};
 useEffect(()=>{localStorage.setItem(key,JSON.stringify(tabs));localStorage.setItem(key+'.selected',selected);},[tabs,selected,key]);
 const openFile=(path:string)=>{if(!tabs.includes(path)&&tabs.length>=maxTabs){setError('File tab limit reached; close a tab before opening another.');return;}setError('');setTabs(prior=>prior.includes(path)?prior:[...prior,path]);setSelected(path);onTab();};
 return <WorkspaceContext.Provider value={{base,scope,transport,policy}}><nav className="inspector-tabs"><button className={!detailsActive&&selected==='node'?'active':''} onClick={()=>{setSelected('node');onTab();}}>Node</button><button className={detailsActive?'active':''} onClick={onDetails}>Details</button>{tabs.map(path=><span key={path}><button className={!detailsActive&&selected===path?'active':''} onClick={()=>{setSelected(path);onTab();}}>{path.split('/').at(-1)}</button><button aria-label={`Close ${path}`} onClick={()=>{setTabs(prior=>prior.filter(value=>value!==path));setViews(prior=>{const next={...prior};delete next[path];return next;});if(selected===path)setSelected('node');}}>×</button></span>)}</nav>
 <div hidden={detailsActive||selected!=='node'} className="node-panel">
  <section className="node-section" aria-label="Workspace files">
   <WorkspaceActions base={base} onReload={()=>setReload(n=>n+1)} onChanged={()=>{setReload(n=>n+1);onChanged();}}>
   <Directory path="" active={active&&!detailsActive&&selected==='node'} reload={reload} openFile={openFile} expanded={expanded} toggle={toggle}/>
   </WorkspaceActions>
  </section>
  <section className="node-section" aria-label="Checkpoints">
   <div className="section-label checkpoint-heading"><span>CHECKPOINTS</span><span>{checkpoints.length}</span></div>
   <div className="node-section-scroll" tabIndex={0} role="region" aria-label="Checkpoint list">
    {!checkpoints.length&&<p className="workspace-empty">No checkpoints yet</p>}
    {checkpoints.map(checkpoint=><div className="checkpoint" key={checkpoint.id}>
     <details className="checkpoint-description">
      <summary><IconChevronRightOutline14/><time dateTime={new Date(checkpoint.createdAt).toISOString()}>{new Date(checkpoint.createdAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time><CheckpointMessage text={checkpoint.note?.trim()||'No checkpoint message'}/></summary>
      <div className="checkpoint-detail"><span>{checkpoint.files.length} files</span><time dateTime={new Date(checkpoint.createdAt).toISOString()}>{new Date(checkpoint.createdAt).toLocaleString()}</time><span>Published by {checkpoint.publisher.kind==='owner'?'you':`worker ${checkpoint.publisher.id}`}</span>{checkpoint.note&&<p>{checkpoint.note}</p>}<code>{checkpoint.commit}</code></div>
     </details>
     <WorkspaceAction label="Create node from checkpoint" onClick={()=>onContinue(checkpoint.id)}><IconBranchOutline16/></WorkspaceAction>
    </div>)}
   </div>
  </section>
  {error&&<p className="workspace-action-status" role="alert">{error}</p>}
 </div>
 {tabs.map(path=><div className="inspector-file" hidden={detailsActive||selected!==path} key={path}><FilePreview active={active&&!detailsActive&&selected===path} maxPdfPages={maxPdfPages} maxPdfPixels={maxPdfPixels} path={path} view={views[path]??defaultPreview} onView={value=>setViews(prior=>({...prior,[path]:value}))}/></div>)}<div className="native-details" hidden={!detailsActive} ref={onDetailsElement}/></WorkspaceContext.Provider>;
}
export function DirectoryPicker({value,onChange,nativePicker,label='Project folder'}:{value:string;onChange:(path:string)=>void;nativePicker:{available:boolean;reason?:string};label?:string}){
 const [choosing,setChoosing]=useState(false),[error,setError]=useState('');
 const fieldId=useId();
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>()=>pending.current?.abort(),[]);
 const choose=async()=>{
  const controller=new AbortController();pending.current=controller;setChoosing(true);setError('');
  try {const {path}=await api<{path:string|null}>('/directories/pick',{},controller.signal);if(path)onChange(path);}
  catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
  finally {if(!controller.signal.aborted)setChoosing(false);pending.current=null;}
 };
 return <div className="directory-picker">
  <label htmlFor={fieldId}>{label}</label>
  <div className="directory-picker-control">
   <input id={fieldId} autoFocus required value={value} onChange={event=>onChange(event.target.value)} placeholder="Enter an absolute folder path" aria-describedby={`${fieldId}-help`} spellCheck={false} autoComplete="off"/>
   {nativePicker.available&&<button type="button" disabled={choosing} onClick={()=>void choose()}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2.5 5.5V4h5l2 2h8v10h-15z"/></svg>{choosing?'Choosing…':'Browse…'}</button>}
  </div>
  <p id={`${fieldId}-help`} className="directory-picker-help">Use a folder on the computer running Polariton.{!nativePicker.available&&<> {nativePicker.reason??'The folder chooser is unavailable; enter the path above.'}</>}</p>
  {error&&<p className="directory-picker-error" role="alert">{error}</p>}
 </div>;
}
