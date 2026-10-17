import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {ResizeHandle} from './resize-handle.tsx';
import {EnvironmentPane} from './environment.tsx';
import {ProviderSettings,type ProviderSettingsView} from './provider-settings.tsx';
import {GraphCanvas} from './graph.tsx';
import {CanvasBridge} from './canvas-bridge.ts';
import {ActionMenu} from './action-menu.tsx';
import {Select} from './select.tsx';
import {Tooltip,IconEditOutlineRegular,IconArchiveOutlineRegular,IconRefreshOutlineRegular,IconPlusOutlineRegular,IconCheckOutlineRegular,IconChevronDownOutlineRegular} from './ui/index.ts';
import {WorkerPane} from './worker.tsx';
import {WorkspacePanel,DirectoryPicker} from './workspace.tsx';
import {Observations,type BrowserPolicy} from './observations.ts';
import {projectName,projectRequest} from './projects.ts';
import {api,uuid} from './api.ts';
import '@xyflow/react/dist/style.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import './ui/design-platform.css';
import './ui/shiki.css';
import './style.css';
import './project-dialog.css';
import polaritonLogo from './assets/polariton-jasmine-logo-botanical-linework-v7.png';
import type { ProjectView, NodeActivity, Graph, NodeRecord, EdgeRecord, WorkerView, HistoryPage, HistoryEvent, Checkpoint, Mutation } from '../../src/contracts.ts';

const emptyGraph: Graph = { revision: 0, nodes: [], edges: [], recovery: null };
type Dialog = 'project' | 'rename-project' | 'node' | 'relation' | 'edit-node' | 'edit-edge' | 'rename-worker' | null;

function App() {
  const [module,setModule]=useState<'project'|'environment'|'settings'>(()=>{const saved=localStorage.getItem('polariton.module');return saved==='environment'||saved==='settings'?saved:'project';});
  const [providerSettings,setProviderSettings]=useState<ProviderSettingsView|null>(null);
  const selectModule=(value:'project'|'environment'|'settings')=>{setModule(value);localStorage.setItem('polariton.module',value);};
  const shell=useRef<HTMLDivElement>(null), layout=useRef<HTMLDivElement>(null);
  const [policy,setPolicy]=useState<BrowserPolicy|null>(null);
  const [projects, setProjects] = useState<ProjectView[]>([]), [projectId, setProjectId] = useState(localStorage.getItem('polariton.project') ?? '');
  const [graph, setGraph] = useState<Graph>(emptyGraph), [nodeId, setNodeId] = useState(localStorage.getItem('polariton.node')??''), [workerId, setWorkerId] = useState(localStorage.getItem('polariton.worker')??'');
  const [nodeActivity,setNodeActivity]=useState<NodeActivity[]>([]);
  const selection=useRef({projectId,nodeId});selection.current={projectId,nodeId};
  const [creatingWorker,setCreatingWorker]=useState(false);
  // Each open node shares its worker data with the active pane so navigation
  // never borrows another node's workers. Selecting one preserves other lists.
  const [expandedNodes,setExpandedNodes]=useState(()=>new Set(nodeId?[nodeId]:[]));
  const [nodeWorkers,setNodeWorkers]=useState<Record<string,WorkerView[]>>({});
  const workers=nodeWorkers[nodeId]??[];
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [error, setError] = useState(''), [ready, setReady] = useState(false), [revision, setRevision] = useState(0);
  const [transport,setTransport]=useState<Observations|null>(null);
  const [details,setDetails]=useState<HTMLDivElement|null>(null),[detailsActive,setDetailsActive]=useState(false);
  const showDetails=useCallback(()=>setDetailsActive(true),[]);
  const [connection,setConnection]=useState<{from:string;to:string}|null>(null);
  const [widths,setWidths]=useState(()=>{try{return JSON.parse(localStorage.getItem('polariton.widths')??'[240,340]') as [number,number];}catch{return [240,340] as [number,number];}});
  const inspectorVisible=graph.nodes.some(value=>value.id===nodeId);
  const clampWidths=useCallback((values:[number,number],changed?:number)=>{
    if(!policy||!layout.current?.clientWidth)return values;
    const rail=layout.current.querySelector<HTMLElement>('.module-rail')!.offsetWidth;
    const handles=Math.max(...[...layout.current.querySelectorAll<HTMLElement>('.project-workspace,.environment-workspace')].map(workspace=>[...workspace.querySelectorAll<HTMLElement>(':scope > .panel-resizer')].reduce((total,handle)=>total+parseFloat(getComputedStyle(handle).width),0)));
    // Both modules keep the same panel budget, even while one workspace is hidden.
    const available=Math.max(0,layout.current.clientWidth-rail-handles-policy.minContentWidth),minimum=Math.min(policy.minPanelWidth,available/2);
    const next=values.map(value=>Math.max(minimum,Math.min(Number.isFinite(value)?value:minimum,available-minimum))) as [number,number];
    if(next[0]+next[1]>available){if(changed!==undefined)next[changed]=available-next[1-changed]!;else{const scale=available/(next[0]+next[1]);next[0]*=scale;next[1]*=scale;}}
    return next;
  },[policy,inspectorVisible]);
  const resize=(index:number,width:number)=>setWidths(prior=>{const next:[number,number]=[...prior];next[index]=width;return clampWidths(next,index);});
  useEffect(()=>{localStorage.setItem('polariton.widths',JSON.stringify(widths));},[widths]);
  useEffect(()=>{const listener=()=>setWidths(prior=>clampWidths(prior));listener();window.addEventListener('resize',listener);return()=>window.removeEventListener('resize',listener);},[clampWidths,ready]);
  const [startingCheckpoint,setStartingCheckpoint]=useState('');
  const [renamingWorker,setRenamingWorker]=useState<WorkerView|null>(null);
  const [dialog, setDialog] = useState<Dialog>(null), [selectedEdge, setSelectedEdge] = useState<EdgeRecord | null>(null);
  const [surface, setSurface] = useState<'graph' | 'worker'>(localStorage.getItem('polariton.surface')==='worker'?'worker':'graph'), [archives, setArchives] = useState(false), [paused, setPaused] = useState(false);
  const project = projects.find(p => p.id === projectId), node = graph.nodes.find(n => n.id === nodeId), worker = workers.find(s => s.id === workerId);
  const hasProject=!!project,hasNode=!!node;
  const base = `/projects/${projectId}`, nodeBase = `${base}/nodes/${nodeId}`;
  useEffect(() => { localStorage.setItem('polariton.node',nodeId); localStorage.setItem('polariton.worker',workerId); localStorage.setItem('polariton.surface',surface); },[nodeId,workerId,surface]);
  const refresh = () => setRevision(n => n + 1);
  const act = async (task: () => Promise<unknown>) => { setError(''); try { await task(); refresh(); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { const authenticate=()=>{ void act(async () => {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has('token')) { const token = params.get('token'); history.replaceState(null, '', location.pathname); await api('/bootstrap', { token }); }
    setProjects(await api('/projects'));setPolicy(await api('/browser-policy')); setReady(true);
  }); }; authenticate(); window.addEventListener('hashchange',authenticate); return()=>window.removeEventListener('hashchange',authenticate); }, []);
  useEffect(()=>{if(!ready||!policy)return;const connection=new CanvasBridge(policy,setError);return()=>connection.close();},[ready,policy]);
  useEffect(()=>{if(!ready||!policy)return;const connection=new Observations(policy,refresh,()=>{});setTransport(connection);return()=>connection.close();},[ready,policy]);
  useEffect(() => { if (!ready) return; let active = true; void api<ProjectView[]>('/projects').then(v => { if (active) setProjects(v); }).catch(e => setError(e.message)); return () => { active = false; }; }, [ready, revision]);
  useEffect(() => { if (!hasProject || !ready) return; let active = true; localStorage.setItem('polariton.project', projectId);
    void Promise.all([api<Graph>(`${base}/graph`),api<NodeActivity[]>(`${base}/activity`)]).then(([v,a]) => { if (active) {setGraph(v);setNodeActivity(a);} }).catch(e => {if(active)setError(e.message);}); return () => { active = false; };
  }, [projectId, hasProject, ready, revision]);
  useEffect(() => {
    if (!ready || !hasProject) return;
    let active=true;
    const visible=new Set([...expandedNodes,nodeId]);
    for(const id of visible) {
      if(!graph.nodes.some(node=>node.id===id))continue;
      void api<WorkerView[]>(`${base}/nodes/${id}/workers`)
        .then(value=>{if(active)setNodeWorkers(prior=>({...prior,[id]:value}));})
        .catch(error=>{if(active)setError(error.message);});
    }
    return()=>{active=false;};
  },[ready,projectId,hasProject,nodeId,graph.nodes,expandedNodes,revision]);
  useEffect(() => { if (!ready || !hasNode || !hasProject) { setCheckpoints([]); return; } let active = true;
    void api<Checkpoint[]>(`${nodeBase}/checkpoints`)
      .then(value => { if (active) setCheckpoints(value); }).catch(e => {if(active)setError(e.message);}); return () => { active = false; };
  }, [nodeId, hasNode, projectId, hasProject, revision, ready]);
  const mutate = async (command: Mutation['command']) => setGraph(await api(`${base}/graph`, { operationId: uuid(), revision: graph.revision, command }));
  const selectNode = (id: string) => { setNodeId(id); setWorkerId(''); setDetailsActive(false); setPaused(false); };
  const chooseProject = (id: string) => { const target=projects.find(value=>value.id===id); setProjectId(id); if(id!==projectId){setGraph(emptyGraph);setNodeWorkers({});}setExpandedNodes(new Set(target?.mainNodeId?[target.mainNodeId]:[]));selectNode(target?.mainNodeId??'');setSurface('graph'); };
  // Saved navigation is a preference, never evidence that a project still exists.
  useEffect(()=>{if(ready&&projectId&&!hasProject){localStorage.removeItem('polariton.project');chooseProject('');}},[ready,projectId,hasProject]);
  const observation=surface==='worker'&&worker&&transport?transport.watch({project:projectId,node:nodeId,workerId:worker.id}):null;
  const createWorker = (targetNode:string) => {
    const targetProject=projectId,count=nodeActivity.find(value=>value.nodeId===targetNode)?.total??0;
    if(targetNode!==nodeId)setCheckpoints([]);
    setExpandedNodes(prior=>new Set([...prior,targetNode]));
    selectNode(targetNode);setSurface('graph');setCreatingWorker(true);
    void act(async()=>{
      try {
        const worker=await api<WorkerView>(`/projects/${targetProject}/nodes/${targetNode}/workers`,{id:uuid(),title:`Worker ${count+1}`});
        if(selection.current.projectId===targetProject&&selection.current.nodeId===targetNode){
          setNodeWorkers(prior=>({...prior,[targetNode]:[...(prior[targetNode]??[]).filter(value=>value.id!==worker.id),worker]}));setWorkerId(worker.id);setSurface('worker');
        }
      } finally {setCreatingWorker(false);}
    });
  };
  const notices = <>
    {providerSettings&&!providerSettings.choices.length&&<div className="provider-setup-notice" role="status"><span>Connect a model provider to start working with agents. Your research and history are still available.</span><button type="button" className="primary" onClick={()=>selectModule('settings')}>Set up models</button></div>}
    {project&&project.initialization.state!=='ready'&&<div className="alert" role="status">Project setup {project.initialization.state}: {project.initialization.detail??'Preparing main workspace'}<button onClick={()=>void act(()=>api(`${base}/initialize`,{}))}>Retry setup</button></div>}
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    {graph.recovery && <div className="alert">{graph.recovery}<button onClick={() => act(() => api(`${base}/repair`, {}))}>Preserve damaged bytes & repair tail</button></div>}
  </>;
  return <div className="app" ref={layout}>
    <nav className="module-rail" aria-label="Modules">
      <Tooltip label="Project" side="right"><button type="button" className="module-item" aria-label="Project" aria-current={module==='project'?'page':undefined} aria-controls="project-workspace" onClick={()=>{selectModule('project');shell.current?.focus({preventScroll:true});}}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z"/></svg>
      </button></Tooltip>
      <Tooltip label="Environment" side="right"><button type="button" className="module-item" aria-label="Environment" aria-current={module==='environment'?'page':undefined} aria-controls="environment-workspace" onClick={()=>selectModule('environment')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M7 6h2M7 12h2M7 18h2"/></svg></button></Tooltip>
      <Tooltip label="Settings" side="right"><button type="button" className="module-item" aria-label="Settings" aria-current={module==='settings'?'page':undefined} aria-controls="settings-workspace" onClick={()=>selectModule('settings')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.7 3-.6 2.3-1.7 1L5 5.7 2.7 9.6l1.7 1.7v1.9L2.7 15 5 18.9l2.4-.6 1.7 1 .6 2.3h4.6l.6-2.3 1.7-1 2.4.6 2.3-3.9-1.7-1.8v-1.9l1.7-1.7L19 5.7l-2.4.6-1.7-1-.6-2.3Z"/><circle cx="12" cy="12.3" r="3.1"/></svg></button></Tooltip>
    </nav>
    {ready&&policy&&<ProviderSettings pollMs={policy.choicesPollMs} active={module==='settings'} onLoaded={setProviderSettings} onChanged={refresh}/>}
    {ready&&policy&&<EnvironmentPane nativePicker={policy.nativePicker} active={module==='environment'} pollMs={policy.reconnectMs} widths={widths} resizeStep={policy.keyboardResizeStep} onNavigationResize={width=>resize(0,width)} onInspectorResize={width=>resize(1,width)}/> }
    <div hidden={module!=='project'} id="project-workspace" className="project-workspace" role="region" aria-label="Project workspace" tabIndex={-1} ref={shell}>
    <aside className="sidebar" style={{width:widths[0],minWidth:widths[0]}}>
      <div className="brand"><img className="brand-mark" src={polaritonLogo} alt="" aria-hidden="true"/><span>Polariton</span></div>
      <div className="section-label">PROJECT</div>
      <ActionMenu label="Select project" className="project-picker" actions={[
        ...projects.map(p=>({id:p.id,label:`${p.name}${p.availability!=='available'?` · ${p.availability}`:''}`,icon:p.id===projectId?<IconCheckOutlineRegular/>:null,current:p.id===projectId,onSelect:()=>chooseProject(p.id)})),
        {label:'Rename project',icon:<IconEditOutlineRegular/>,separatorBefore:projects.length>0,disabled:!project,onSelect:()=>setDialog('rename-project')},
        {label:'Create project',icon:<IconPlusOutlineRegular/>,onSelect:()=>setDialog('project')},
      ]}><span>{project?.name??(projects.length?'Select a project':'No projects yet')}</span><IconChevronDownOutlineRegular/></ActionMenu>
      {project && <><div className="section-label">RESEARCH NODES <ActionMenu label="Research node actions" actions={[
        {label:'Create node',icon:<IconPlusOutlineRegular/>,onSelect:()=>{setStartingCheckpoint('');setDialog('node');}},
        {label:archives?'Hide archived work':'Show archived work',icon:<IconArchiveOutlineRegular size={16}/>,onSelect:()=>setArchives(value=>!value)},
      ]}><IconChevronDownOutlineRegular/></ActionMenu></div>
      {graph.nodes.filter(n => archives || n.id===project.mainNodeId || !n.archived || nodeActivity.some(a=>a.nodeId===n.id&&(a.active>0||a.permissions>0))).map(n => <div key={n.id}>
        <div className={`nav-row node-row ${n.id===nodeId&&surface==='graph'?'selected':''}`}>
          <button type="button" className="nav-item node-select" aria-current={n.id===nodeId&&surface==='graph'?'page':undefined} aria-expanded={expandedNodes.has(n.id)} aria-controls={`workers-${n.id}`} onClick={()=>{setExpandedNodes(prior=>{const next=new Set(prior);if(next.has(n.id)&&n.id===nodeId&&surface==='graph')next.delete(n.id);else next.add(n.id);return next;});selectNode(n.id);setSurface('graph');}}><svg className="node-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{expandedNodes.has(n.id)?<><path d="M3 19V5a1 1 0 0 1 1-1h5l2 3h8a1 1 0 0 1 1 1v3"/><path d="m3 19 3-8h16l-3 8Z"/></>:<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z"/>}</svg><Tooltip label={n.title} side="right"><span className="node-label">{n.title}</span></Tooltip>{n.archived&&<small>archived</small>}</button><Tooltip label={`Add worker to ${n.title}`} side="right"><button type="button" className="row-action" aria-label={`Add worker to ${n.title}`} disabled={creatingWorker} onClick={()=>createWorker(n.id)}><IconPlusOutlineRegular/></button></Tooltip><ActionMenu label={`Node menu ${n.title}`} actions={[
          {label:'Edit',icon:<IconEditOutlineRegular/>,onSelect:()=>{selectNode(n.id);setDialog('edit-node');}},
          {label:n.archived?'Restore':'Archive',icon:n.archived?<IconRefreshOutlineRegular/>:<IconArchiveOutlineRegular size={16}/>,onSelect:()=>void act(()=>mutate({kind:'node.archive',id:n.id,archived:!n.archived}))},
        ]}/></div>
        <div id={`workers-${n.id}`} hidden={!expandedNodes.has(n.id)} className="worker-nav">
          {!nodeWorkers[n.id]&&expandedNodes.has(n.id)&&<span className="nav-loading">Loading workers…</span>}
          {(nodeWorkers[n.id]??[]).filter(s=>archives||!s.archived||['running','starting','interrupting'].includes(s.state)||s.permissions.length).map(s => <div className={`nav-row worker-row ${n.id===nodeId&&s.id === workerId && surface==='worker' ? 'selected':''}`} key={s.id}><button className="worker-select" aria-current={n.id===nodeId&&s.id===workerId&&surface==='worker'?'page':undefined} onClick={() => { if(n.id!==nodeId)selectNode(n.id);setWorkerId(s.id); setSurface('worker'); }}><i aria-hidden="true" className={`worker-light ${s.state}`} data-attention={s.permissions.length>0||undefined}/><Tooltip label={s.title} side="right"><span className="worker-label">{s.title}</span></Tooltip><small>{s.archived?'Archived · ':''}{s.state}</small></button><ActionMenu label={`Worker menu ${s.title}`} actions={[
          {label:'Rename',icon:<IconEditOutlineRegular/>,onSelect:()=>{setRenamingWorker(s);setDialog('rename-worker');}},
          {label:s.archived?'Restore':'Archive',icon:s.archived?<IconRefreshOutlineRegular/>:<IconArchiveOutlineRegular size={16}/>,onSelect:()=>void act(()=>api(`${base}/nodes/${n.id}/workers/${s.id}/archive`,{archived:!s.archived}))},
        ]}/></div>)}</div>
      </div>)}</>}
    </aside><ResizeHandle step={policy?.keyboardResizeStep??0} label="Navigation width" width={widths[0]} onChange={width=>resize(0,width)}/>
    <main>
      {surface!=='worker'&&<header><div><span className="muted">{project?.name ?? 'Your research'}</span><span className="slash">/</span>Research graph</div><div className="header-actions">{project && <><Tooltip label="Add node" side="bottom"><button className="graph-add" aria-label="Add node" onClick={() => {setStartingCheckpoint('');setDialog('node');}}><IconPlusOutlineRegular/></button></Tooltip></>}</div></header>}
      {!(surface==='worker'&&worker&&observation)&&notices}
      {!project ? <div className="welcome"><div className="eyebrow">A PLACE FOR YOUR NEXT QUESTION</div><h1>Follow the research.</h1><p>Connect ideas, keep the evidence, and let agents work alongside you.</p><button className="primary" onClick={() => setDialog('project')}>Create a project <span>↗</span></button><div className="welcome-grid"><article><b>01 / Map</b><p>Organize research with your own relationships.</p></article><article><b>02 / Explore</b><p>Run independent workers in shared workspaces.</p></article><article><b>03 / Continue</b><p>Keep checkpoints and inspect the work behind them.</p></article></div></div>
      : surface === 'graph' ? <div className="graph-wrap"><div className="canvas-heading"><h1>{project.name}</h1><p>{graph.nodes.length} nodes · {graph.edges.filter(e => !e.retracted).length} relations · revision {graph.revision}</p></div><GraphCanvas key={projectId} project={projectId} activity={nodeActivity} onError={setError} graph={graph} showArchived={archives} selected={nodeId} onNode={selectNode} onEdge={edge => { setSelectedEdge(edge); setDialog('edit-edge'); }} onConnect={(from,to)=>{setConnection({from,to});setDialog('relation');}}/>{!graph.nodes.length && <div className="graph-empty"><h2>Start with a research question</h2><p>Each node has an independent Git workspace.</p><button className="primary" onClick={() => {setStartingCheckpoint('');setDialog('node');}}>Create first node</button></div>}</div>
      : worker && transport && (observation ? <WorkerPane visible={module==='project'} choicesPollMs={policy!.choicesPollMs} notices={notices} key={worker.id} worker={worker} observation={observation} onError={setError} onChanged={refresh} projectName={project.name} onGraph={()=>setSurface('graph')} details={details} onDetails={showDetails}/>:<div className="alert" role="alert">The configured worker observation limit is reached. Reopen the webapp to choose a new set of workers. Agent work continues.</div>)}
    </main>
    {node&&<><ResizeHandle step={policy?.keyboardResizeStep??0} label="Inspector width" width={widths[1]} onChange={width=>resize(1,width)} reverse/><aside className="inspector" style={{width:widths[1],minWidth:widths[1]}}><WorkspacePanel maxPdfPages={policy!.maxPdfPages} maxPdfPixels={policy!.maxPdfPixels} maxTabs={policy!.maxFileTabs} maxExpanded={policy!.maxExpandedDirectories} key={nodeBase} base={nodeBase} scope={{project:projectId,node:nodeId}} transport={transport} policy={policy!} active={module==='project'} checkpoints={checkpoints} detailsActive={detailsActive} onTab={()=>setDetailsActive(false)} onDetails={showDetails} onDetailsElement={setDetails} onChanged={refresh} onContinue={id=>{setStartingCheckpoint(id);setDialog('node');}}/></aside></>}
    {dialog && <EditDialog nativePicker={policy!.nativePicker} project={project} worker={renamingWorker} connection={connection} startingCheckpoint={startingCheckpoint} kind={dialog} node={node} edge={selectedEdge} graph={graph} checkpoints={checkpoints} close={() => {setDialog(null);setConnection(null);}} submit={async form => {
      await act(async () => {
        if (dialog === 'project') { const request=projectRequest(localStorage,form.root);const p = await api<ProjectView>('/projects',request);localStorage.removeItem('polariton.pendingProject');setProjects(v => [...v.filter(value=>value.id!==p.id),p]);setProjectId(p.id);setGraph(emptyGraph);setNodeWorkers({});setExpandedNodes(new Set(p.mainNodeId?[p.mainNodeId]:[]));selectNode(p.mainNodeId??'');setWorkerId(p.initialWorkerId??'');setSurface(p.initialWorkerId?'worker':'graph'); }
        else if (dialog === 'rename-project' && project) {await api(`${base}/rename`,{name:form.title});setProjects(values=>values.map(value=>value.id===project.id?{...value,name:form.title.trim()}:value));}
        else if (dialog === 'rename-worker' && renamingWorker) await api(`/projects/${renamingWorker.projectId}/nodes/${renamingWorker.nodeId}/workers/${renamingWorker.id}/rename`,{title:form.title});
        else if (dialog === 'node') { const id=uuid(); await mutate({kind:'node.create',id,title:form.title,description:form.description, ...(form.checkpoint && node ? {source:{nodeId:node.id,checkpointId:form.checkpoint}}:{})}); selectNode(id); setSurface('graph'); }
        else if (dialog === 'edit-node' && node) await mutate({kind:'node.edit',id:node.id,title:form.title,description:form.description});
        else if (dialog === 'relation') await mutate({kind:'edge.create',id:uuid(),from:form.from,to:form.to,relation:form.title,explanation:form.description});
        else if (dialog === 'edit-edge' && selectedEdge) await mutate({kind:'edge.edit',id:selectedEdge.id,relation:form.title,explanation:form.description});
        setDialog(null);
      });
    }} retract={() => act(async () => { if(selectedEdge) await mutate({kind:'edge.retract',id:selectedEdge.id}); setDialog(null); })}/>}
    </div>
  </div>;
}

type FormValues={root:string;title:string;description:string;from:string;to:string;checkpoint:string};
function EditDialog({nativePicker,project,worker,connection,startingCheckpoint,kind,node,edge,graph,checkpoints,close,submit,retract}:{nativePicker:BrowserPolicy['nativePicker'];project?:ProjectView;worker:WorkerView|null;connection:{from:string;to:string}|null;startingCheckpoint:string;kind:Dialog;node?:NodeRecord;edge:EdgeRecord|null;graph:Graph;checkpoints:Checkpoint[];close:()=>void;submit:(f:FormValues)=>Promise<void>;retract:()=>void}) {
  const [form,setForm]=useState<FormValues>({root:'',title:kind==='rename-project'?project?.name??'':kind==='rename-worker'?worker?.title??'':kind==='edit-node'?node?.title??'':kind==='edit-edge'?edge?.relation??'':'',description:kind==='edit-node'?node?.description??'':kind==='edit-edge'?edge?.explanation??'':'',from:connection?.from??node?.id??graph.nodes[0]?.id??'',to:connection?.to??graph.nodes.find(n=>n.id!==node?.id)?.id??graph.nodes[0]?.id??'',checkpoint:startingCheckpoint});
  const [saving,setSaving]=useState(false);
  const relation=kind==='relation'||kind==='edit-edge';
  const field=(key:keyof FormValues)=>(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>setForm({...form,[key]:e.target.value});
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label={kind==='project'?'New project':kind??'Edit'} className={`modal${kind==='project'?' project-create':''}`}><div className="row dialog-heading"><h2>{kind==='rename-project'?'Rename project':kind==='rename-worker'?'Rename worker':kind==='project'?'New project':kind==='node'?'New research node':kind==='relation'?'Connect research':relation?'Edit relation':'Edit node'}</h2><button className="dialog-close" aria-label="Close dialog" onClick={close}>×</button></div>{kind==='project'&&<p className="project-create-intro">Choose a home for your research.</p>}<form onSubmit={e=>{e.preventDefault();if(saving||(kind==='project'&&!form.root))return;setSaving(true);void submit(form).finally(()=>setSaving(false));}}>
    {kind==='project'?<><DirectoryPicker nativePicker={nativePicker} value={form.root} onChange={root=>setForm({...form,root})}/><div className="project-name-preview">{form.root?<><span>Project name</span><strong>{projectName(form.root)}</strong><span>You can rename it later.</span></>:<span>The folder name becomes your project name. You can rename it later.</span>}</div></>:<label>{relation?'Relation':'Name'}<input autoFocus required maxLength={10000} value={form.title} onChange={field('title')}/></label>}
    {kind!=='project'&&kind!=='rename-project'&&kind!=='rename-worker'&&<label>{relation?'Explanation':'Description'}<textarea rows={3} value={form.description} onChange={field('description')}/></label>}
    {kind==='relation'&&<div className="row"><label>From<Select label="From" value={form.from} onChange={from=>setForm({...form,from})} options={graph.nodes.map(n=>({value:n.id,label:n.title}))}/></label><label>To<Select label="To" value={form.to} onChange={to=>setForm({...form,to})} options={graph.nodes.map(n=>({value:n.id,label:n.title}))}/></label></div>}
    {kind==='node'&&<label>Starting files<Select label="Starting files" value={form.checkpoint} onChange={checkpoint=>setForm({...form,checkpoint})} options={[{value:"",label:"Empty independent workspace"},...checkpoints.map(c=>({value:c.id,label:`Inherit ${node?.title} · ${c.commit.slice(0,9)}`}))]}/><small>Agent workers and context are never copied.</small></label>}
    <div className="modal-footer">{kind==='edit-edge'&&<button type="button" onClick={retract}>Retract relation</button>}<button type="button" onClick={close}>Cancel</button><button className="primary" disabled={saving||(kind==='project'&&!form.root)}>{saving?'Saving…':kind==='project'?'Create project':'Save'}</button></div>
  </form></section></div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
