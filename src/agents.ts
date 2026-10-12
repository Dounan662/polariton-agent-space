import {OverviewWorker,overviewText,type OverviewCoworker,type OverviewAttention,type AttentionPosition} from './worker-overview-contracts.ts';
import {IdleWorkers,type IdleClock} from './idle-workers.ts';
import {ResidencySnapshot} from '../harness/settings.ts';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Operations, canonical, owner, type Actor } from './operations.ts';
import sharp from 'sharp';
import { Harness } from '../harness/client.ts';
import {HarnessHistory} from '../harness/history.ts';
import type {HarnessPort,HarnessFactory,InputPart} from '../harness/contracts.ts';
import {executionHost} from './host-support.ts';
import { GuardianIdentity } from '../harness/settings.ts';
import { Fault, Id, Text, type WorkerView, type WorkerState, type NodeActivity, Submission, submissionContent, type WorkerInput, type Permission, type HistoryPage, type HistoryEvent, type PromptPart, type ModelOption, type StagedImage, WorkerEnvironment, WorkerMcpStatus, WorkerCreate, WorkerCreation } from './contracts.ts';
import type { Config } from './config.ts';
import type { ResearchTree } from './research.ts';
import { EnvironmentRef, type EnvironmentAccess, type AccessGrant } from './environment/contracts.ts';
import { HarnessCatalog, type ModelCatalog } from '../harness/catalog.ts';
import type {ProviderSettings,ProviderRuntime} from '../harness/providers.ts';

const Activation=z.object({guardian:GuardianIdentity.nullable(),id:Id,accessId:Id.nullable(),phase:z.enum(['preparing','opening','active','cleanup']),sessionUncertain:z.boolean()}).strict();
type Binding = Omit<WorkerView, 'submissions' | 'permissions' | 'cleanupPending' | 'mcp' | 'residency'> & {activation:z.infer<typeof Activation>|null;closeRequested:boolean;lastUnloadedAt:number|null};
// Persisted bindings are a domain boundary, not trusted objects reconstructed by a cast.
const StoredWorker = z.object({
  id:Id,projectId:Id,nodeId:Id,agentId:Id,assignmentId:Id,creation:WorkerCreation,
  lastUnloadedAt:z.number().nullable(),environment:WorkerEnvironment,activation:Activation.nullable(),closeRequested:z.boolean(),
  processId:Id.nullable(),harnessSessionId:z.string().nullable(),title:Text,
  state:z.enum(['inactive','closed','starting','idle','running','interrupting','uncertain','failed']),
  error:z.string().nullable(),archived:z.boolean(),
  model:z.string().nullable(),imageCapability:z.boolean(),
  configOptions:z.array(z.object({id:z.string(),name:z.string(),currentValue:z.string(),options:z.array(z.object({value:z.string(),name:z.string(),group:z.string().optional()}))})),
}).strict();
type Live = { providerRevision?:number; closing: boolean; cancelRequested:boolean; harness: HarnessPort; pending: Map<string, { value: Permission; finish: (option: string | null) => void }> };

/** Owns worker bindings, supervised execution and source authorization; never reconstructs model input. */
export class AgentManager extends EventEmitter {
  private config: Config;
  private tree: ResearchTree;
  private db: DatabaseSync;
  private live = new Map<string, Live>();
  private mcp = new Map<string,WorkerMcpStatus[]>();
  private imageTail:Promise<unknown>=Promise.resolve();
  private bindings = new Map<string,Binding>();
  private starts = new Map<string, Promise<Live>>();
  private jobs = new Map<Promise<void>,string>();
  private admissions = new Map<string,Promise<void>>();
  private closing = false;
  private historyStore:HarnessHistory;
  private budget: () => Promise<boolean>;
  private factory: HarnessFactory;
  private environment?:EnvironmentAccess;
  private catalog:ModelCatalog;
  private providers?:Pick<ProviderSettings,'choices'|'currentDefault'|'currentRevision'|'withRuntime'>;
  private owner:string;
  private stopping=new Set<string>();
  private launching=new Map<string,HarnessPort>();
  private transitions=new Map<string,Promise<WorkerView>>();
  private cleanups=new Map<string,Promise<void>>();
  private closes=new Map<string,Promise<void>>();
  private unloading=new Map<string,Promise<void>>();
  private residencyActivity=new Map<string,z.infer<typeof ResidencySnapshot>>();
  private idle:IdleWorkers;
  private controls=new Set<Promise<void>>();
  private credentials?:{issue(worker:string,processId:string):NonNullable<Config['workerCredential']>;revoke(processId:string):void};
  constructor(config: Config, tree: ResearchTree, budget: () => Promise<boolean> = async () => true, factory: HarnessFactory = (...args) => new Harness(...args), dependencies:{providers?:Pick<ProviderSettings,'choices'|'currentDefault'|'currentRevision'|'withRuntime'>;clock?:IdleClock;environment?:EnvironmentAccess;catalog?:ModelCatalog;credentials?:{issue(worker:string,processId:string):NonNullable<Config['workerCredential']>;revoke(processId:string):void}}={}) {
    super(); this.historyStore=new HarnessHistory(config); this.config = config; this.tree = tree; this.budget = budget; this.factory = factory;this.environment=dependencies.environment;this.credentials=dependencies.credentials;this.providers=dependencies.providers;this.catalog=dependencies.catalog??dependencies.providers??new HarnessCatalog(config,factory);
    this.idle=new IdleWorkers(config.workerIdleUnloadMs,(id,revision)=>this.unload(id,revision),(workerId,error)=>this.emit('failure',{workerId,error:error instanceof Error?error.message:'Idle unload failed'}),dependencies.clock);
    this.db = new DatabaseSync(join(config.stateRoot, 'agents.sqlite'));
    try {
    this.initializeStorage();
    const owner=this.db.prepare('SELECT id FROM owner').get() as {id:string}|undefined;
    this.owner=owner?.id??randomUUID();if(!owner)this.db.prepare('INSERT INTO owner VALUES (?)').run(this.owner);
    for (const row of this.db.prepare('SELECT data FROM workers').all() as {data:string}[]) {
      const worker = StoredWorker.parse(JSON.parse(row.data));
      if(worker.closeRequested)worker.state='closed';
      else if (['running','interrupting','starting'].includes(worker.state)) { worker.state = 'uncertain'; worker.error = 'Main stopped before work settled; inspect history before resuming'; }
      else if (worker.state === 'idle') worker.state = 'inactive';
      if(worker.activation&&(worker.activation.accessId||worker.activation.guardian))worker.activation.phase='cleanup';
      this.save(worker);
    }
    for (const row of this.db.prepare('SELECT worker_id AS workerId,data FROM submissions').all() as {workerId:string;data:string}[]) {
      const submission = Submission.parse(JSON.parse(row.data));
      if (['pending','admitted'].includes(submission.state)) this.saveSubmission(row.workerId, { ...submission, state: submission.retryable?'failed':'uncertain', detail: submission.retryable?'Setup was interrupted before message dispatch; explicit retry is safe':'Execution receipt was unresolved at restart; not resubmitted' });
    }
    } catch (error) { this.db.close(); throw error; }
  }
  /** Open current storage or create it atomically; incompatible experiments require fresh state. */
  private initializeStorage() {
    const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (version === 9) { this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); return; }
    if (version !== 0 || this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Fault('STORAGE_VERSION', 'Unsupported worker storage; use a fresh state directory for this build');
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE owner(id TEXT PRIMARY KEY);
        CREATE TABLE workers(id TEXT PRIMARY KEY, project TEXT NOT NULL, node TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE submissions(id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE images(id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE project_initial_workers(project TEXT PRIMARY KEY, node TEXT NOT NULL, worker TEXT NOT NULL UNIQUE);
        PRAGMA user_version=9;`);
      Operations.create(this.db);
      this.db.exec(`COMMIT;`);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Provision a project's starting worker through ordinary creation. Durable intent
   * makes retries reuse its identity without changing later edits or archive state. */
  ensureInitialWorker(project: string, node: string): WorkerView {
    this.tree.workspace(project,node);
    const intent=this.db.prepare('SELECT node,worker FROM project_initial_workers WHERE project=?').get(project) as {node:string;worker:string}|undefined;
    if(intent && intent.node!==node)throw new Fault('INITIAL_WORKER_BINDING','Initial worker belongs to a different main node');
    const id=intent?.worker??randomUUID();
    if(!intent)this.db.prepare('INSERT INTO project_initial_workers VALUES (?,?,?)').run(project,node,id);
    return this.create(project,node,id,{title:'Worker'});
  }
  /** Renaming changes presentation without changing worker identity. */
  rename(project: string, node: string, id: string, title: string): WorkerView {
    const worker = this.binding(project,node,id);
    worker.title = Text.parse(title); this.save(worker);
    return this.list(project,node).find(value=>value.id===id)!;
  }
  private binding(project: string, node: string, id: string): Binding {
    this.tree.workspace(project, node);
    const row = this.db.prepare('SELECT data FROM workers WHERE id=? AND project=? AND node=?').get(id, project, node) as {data:string} | undefined;
    if (!row) throw new Fault('WORKER_NOT_FOUND', 'Worker does not belong to this node', 404);
    return this.bindings.get(id)??StoredWorker.parse(JSON.parse(row.data));
  }
  private save(worker: Binding) { this.bindings.set(worker.id,worker); this.db.prepare('INSERT INTO workers VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(worker.id, worker.projectId, worker.nodeId, JSON.stringify(worker)); this.syncResidency(worker); this.emit('change'); }
  private status(worker: Binding, state: WorkerState, error: string | null = null) { worker.state = worker.closeRequested&&!['closed','uncertain','failed'].includes(state)?'interrupting':state; worker.error = error; this.save(worker); }
  private saveSubmission(worker:string,value:Submission){
    const prior=this.db.prepare('SELECT data FROM submissions WHERE id=?').get(value.id) as {data:string}|undefined;
    const saved=prior?Submission.parse(JSON.parse(prior.data)):undefined;
    const attempts=saved?.attempts??[];
    if(!saved||saved.state!==value.state||saved.detail!==value.detail){
      if(attempts.length>=this.config.cliMaxRecords)throw new Fault('REQUEST_CAPACITY','Submission transition retention is full');
      attempts.push({at:Date.now(),state:value.state,...value.detail?{detail:value.detail}:{}});
    }
    this.db.prepare('INSERT INTO submissions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,worker,JSON.stringify({...value,attempts}));const binding=this.bindings.get(worker);if(binding)this.syncResidency(binding);this.emit('change');
  }
  private submissions(worker: string): Submission[] { return (this.db.prepare('SELECT data FROM submissions WHERE worker_id=? ORDER BY rowid').all(worker) as {data:string}[]).map(r => Submission.parse(JSON.parse(r.data))); }
  list(project: string, node: string): WorkerView[] {
    this.tree.workspace(project, node);
    return (this.db.prepare('SELECT data FROM workers WHERE project=? AND node=? ORDER BY rowid').all(project, node) as {data:string}[]).map(row => this.view(row.data));
  }
  /** Metadata remains inspectable when its workspace is unavailable; execution admission is separate. */
  private view(data: string): WorkerView {
    const value = StoredWorker.parse(JSON.parse(data));
    const {activation,closeRequested,lastUnloadedAt,...visible}=value;
    return { ...visible,residency:{timeoutMs:this.config.workerIdleUnloadMs,phase:this.config.workerIdleUnloadMs===null?'disabled':this.unloading.has(value.id)?'unloading':!this.live.has(value.id)?'inactive':this.residencyActivity.has(value.id)?'resident':'unknown',blockers:this.residencyBlockers(value),lastUnloadedAt}, mcp:this.mcp.get(value.id)??[], cleanupPending:activation?.phase==='cleanup', submissions: (this.db.prepare('SELECT data FROM submissions WHERE worker_id=? ORDER BY rowid DESC LIMIT ?').all(value.id,this.config.cliPageSize) as {data:string}[]).reverse().map(row=>Submission.parse(JSON.parse(row.data))), permissions: [...(this.live.get(value.id)?.pending.values() ?? [])].map(p => p.value) };
  }
  /** One read-only summary per node, including empty nodes and archived workers.
   * Activity remains discoverable independently of navigation's archival filter. */
  activity(project:string): NodeActivity[] {
    return this.tree.graph(project).nodes.map(node=>{
      const states:Record<WorkerState,number>={inactive:0,closed:0,starting:0,idle:0,running:0,interrupting:0,uncertain:0,failed:0};
      let total=0,archived=0,permissions=0;
      // Summaries need lifecycle metadata, not submissions or session history.
      const rows=this.db.prepare('SELECT data FROM workers WHERE project=? AND node=?').all(project,node.id) as {data:string}[];
      for(const row of rows){
        const worker=StoredWorker.parse(JSON.parse(row.data));
        total++;states[worker.state]++;if(worker.archived)archived++;
        permissions+=this.live.get(worker.id)?.pending.size??0;
      }
      return {nodeId:node.id,total,archived,states,active:states.starting+states.running+states.interrupting,permissions};
    });
  }
  /** Saved configuration is effective for future activations; resident workers
   * retain their snapshot until the native quiescence boundary permits unloading. */
  providerApplication(){
    const pendingWorkers=this.providers?[...this.live.values()].filter(live=>live.providerRevision!==this.providers!.currentRevision).length:0;
    return {state:pendingWorkers?'pending' as const:'effective' as const,pendingWorkers,...pendingWorkers?{detail:'Saved. Existing workers will apply changes when their work and background activity settle; close and resume a worker to apply sooner.'}:{}};
  }
  providersChanged(){for(const worker of this.bindings.values())this.syncResidency(worker);this.emit('change');}
  /** Create an inactive worker from one immutable specification. The surrounding
   * owner request transaction commits its instructions and receipt together. */
  create(project: string, node: string, id: string, input: WorkerCreate, provenance:{requestId:string;creator:Actor}={requestId:id,creator:owner}): WorkerView {
    this.tree.workspace(project, node);
    const specification=WorkerCreate.parse(input);
    const row=this.db.prepare('SELECT data FROM workers WHERE id=?').get(id) as {data:string}|undefined;
    if(row){
      const existing=StoredWorker.parse(JSON.parse(row.data)),prior=existing.creation;
      const normalized={...specification,model:specification.model??prior.specification.model,environment:specification.environment??null};
      if(existing.projectId!==project||existing.nodeId!==node||canonical(prior.specification)!==canonical(normalized)||prior.requestId!==provenance.requestId||prior.creator.kind!==provenance.creator.kind||prior.creator.id!==provenance.creator.id)throw new Fault('WORKER_CONFLICT','Worker identity already belongs to a different creation specification');
      return this.view(row.data);
    }
    const creation=this.creation(provenance.creator,specification,provenance.requestId);
    const value: Binding = { id,creation,nodeId: node, projectId: project, agentId: randomUUID(), assignmentId: randomUUID(), processId: null, harnessSessionId: null, title: creation.specification.title, state: 'inactive', error: null, archived:false, model:creation.specification.model??null, configOptions:[],imageCapability:false, environment:{selection:creation.specification.environment??null,locked:false},activation:null,closeRequested:false,lastUnloadedAt:null };
    this.save(value); return this.view(JSON.stringify(value));
  }
  /** Validate instruction bytes and normalize initial choices once, before any persistence. */
  private creation(creator:Actor,input:WorkerCreate,requestId:string):WorkerCreation {
    const model=input.model??(this.providers?this.providers.currentDefault():JSON.stringify([this.config.provider,this.config.model]))??undefined;
    const specification={...WorkerCreate.parse(input),model,environment:input.environment??null};
    try{if(model!==undefined)z.tuple([z.string().min(1),z.string().min(1)]).parse(JSON.parse(model));}
    catch{throw new Fault('MODEL_INVALID','Choose a model route from worker options',400);}
    const text=specification.systemPrompt?.text;
    if(text!==undefined){
      if(Buffer.from(text,'utf8').toString('utf8')!==text)throw new Fault('PROMPT_INVALID','Worker instructions must be valid Unicode text',400);
      if(Buffer.byteLength(text,'utf8')>this.config.maxWorkerPromptBytes)throw new Fault('PROMPT_LIMIT','Worker instructions exceed maxWorkerPromptBytes',400);
    }
    return WorkerCreation.parse({requestId,creator,createdAt:Date.now(),specification,instructionDigest:text===undefined?null:createHash('sha256').update(text,'utf8').digest('hex')});
  }
  /** Reconcile only journaled grants belonging to this durable Main owner; never resume execution. */
  async initialize(){
    for(const worker of this.bindings.values())if(worker.activation?.accessId||worker.activation?.guardian){
      try{await this.cleanup(worker);}catch{this.emit('failure',{workerId:worker.id,error:'Worker or environment cleanup is pending'});}
    }
  }
  private async cleanup(worker:Binding){
    const existing=this.cleanups.get(worker.id);if(existing)return existing;
    const task=this.releaseAccess(worker);this.cleanups.set(worker.id,task);
    try{await task;}finally{this.cleanups.delete(worker.id);}
  }
  private async releaseAccess(worker:Binding){
    const activation=worker.activation;if(!activation)return;
    activation.phase='cleanup';this.save(worker);
    if(activation.guardian){
      try{await Harness.recover(activation.guardian,this.config);activation.guardian=null;this.save(worker);}
      catch{this.status(worker,'uncertain','Worker execution cleanup is unconfirmed; capacity and access remain retained');throw new Fault('PROCESS_CLOSE_FAILED','Worker execution cleanup is unconfirmed; capacity and access remain retained');}
    }
    if(activation.accessId){
      try{if(!this.environment)throw new Error('Unavailable');await this.environment.release({id:activation.accessId,owner:this.owner});}
      catch{this.status(worker,worker.state==='uncertain'?'uncertain':'failed','Environment grant cleanup is pending; retry Close or setup');throw new Fault('ACCESS_CLEANUP_PENDING','Environment grant cleanup is pending');}
    }
    worker.activation=activation.sessionUncertain?{...activation,accessId:null,phase:'preparing'}:null;this.save(worker);
  }
  /** Reading choices may start a catalog host, never a conversation or provider request. */
  async setup(project:string,node:string,id:string){
    const worker=this.binding(project,node,id);
    const choices=await this.catalog.choices();
    if(!this.live.has(id)&&!this.starts.has(id)&&!this.transitions.has(id)){
      const image=choices.find(choice=>choice.value===worker.model)?.image??false;
      if(worker.imageCapability!==image){worker.imageCapability=image;this.save(worker);}
    }
    const models:ModelOption[]=[{id:'model',name:'Model',currentValue:worker.model??'',options:choices.map(({value,name})=>({value,name}))}];
    let environments:Awaited<ReturnType<EnvironmentAccess['choices']>>=[],environmentError:string|null=null;
    if(this.environment){try{environments=await this.environment.choices();}catch{environmentError='Environment service is unavailable. No environment remains usable.';}}
    else environmentError='Environment service is not configured.';
    return {models,environments,environmentError};
  }
  async selectEnvironment(project:string,node:string,id:string,selection:EnvironmentRef|null){
    const worker=this.binding(project,node,id);
    if(worker.environment.locked)throw new Fault('ENVIRONMENT_FIXED','Use a new worker to select another environment');
    if(worker.activation||this.transitions.has(id)||this.starts.has(id)||this.stopping.has(id)||['starting','running','interrupting','uncertain'].includes(worker.state)||this.submissions(id).some(s=>['pending','admitted'].includes(s.state)))throw new Fault('SETUP_BUSY','Resolve activation before changing the environment');
    const priorState=worker.state;
    this.status(worker,'starting');
    const task=(async()=>{
      try{
        let selected:EnvironmentRef|null=null;
        if(selection){
          const input=EnvironmentRef.parse(selection);
          if(!this.environment)throw new Fault('ENVIRONMENT_UNAVAILABLE','Environment service is not configured');
          selected=(await this.environment.choices()).find(choice=>choice.environment.environmentId===input.environmentId&&choice.environment.revisionId===input.revisionId)?.environment??null;
          if(!selected)throw new Fault('ENVIRONMENT_UNAVAILABLE','Select an applied and available published revision');
        }
        if(this.stopping.has(id)||this.closing)throw new Fault('WORKER_CLOSING','Worker is closing');
        worker.environment={selection:selected,locked:false};this.status(worker,priorState);return this.view(JSON.stringify(worker));
      }catch(error){this.status(worker,priorState);throw error instanceof Fault?error:new Fault('ENVIRONMENT_UNAVAILABLE','Environment choices are unavailable');}
    })();this.transitions.set(id,task);
    try{return await task;}finally{this.transitions.delete(id);const worker=this.bindings.get(id);if(worker)this.syncResidency(worker);}
  }
  private async start(worker: Binding): Promise<Live> {
    if (this.closing) throw new Fault('SHUTTING_DOWN', 'Main is shutting down');
    if(this.stopping.has(worker.id))throw new Fault('WORKER_CLOSING','Worker is closing');
    const existing = this.live.get(worker.id); if (existing) { if(existing.closing) throw new Fault('WORKER_CLOSING','Wait for this worker process to exit'); return existing; }
    const pending = this.starts.get(worker.id); if (pending) return pending;
    if (new Set([...this.live.keys(),...this.starts.keys(),...[...this.bindings.values()].filter(value=>value.activation?.guardian).map(value=>value.id)]).size >= this.config.maxActiveWorkers) throw new Fault('WORKER_LIMIT', 'Close an idle worker to free execution capacity');
    const task = this.launch(worker); this.starts.set(worker.id, task);
    try { return await task; } finally { this.starts.delete(worker.id); this.syncResidency(worker); }
  }
  private async launch(worker: Binding): Promise<Live> {
    if(this.providers){
      if(!worker.model||!(await this.providers.choices()).some(choice=>choice.value===worker.model))throw new Fault('MODEL_REQUIRED','Choose a configured model in Settings and select it for this worker',400);
      return this.providers.withRuntime(runtime=>{
        if(!runtime.choices.some(choice=>choice.value===worker.model))throw new Fault('MODEL_REQUIRED','Selected model is no longer configured; choose another model',400);
        return this.launchConfigured(worker,runtime);
      });
    }
    return this.launchConfigured(worker);
  }
  private async launchConfigured(worker: Binding,providerRuntime?:ProviderRuntime): Promise<Live> {
    await this.cleanup(worker);
    if(this.stopping.has(worker.id)||this.closing)throw new Fault('ACTIVATION_CANCELLED','Worker activation was cancelled');
    const workspace = this.tree.workspace(worker.projectId, worker.nodeId, 'write');
    worker.processId = randomUUID();
    this.status(worker, 'starting');
    const pending: Live['pending'] = new Map();
    let requests = 0;
    let harness:HarnessPort;
    try{
    harness = this.factory({...this.config,providerRuntime,workerInstructions:worker.creation.specification.systemPrompt?.text,workerIdentity:{projectId:worker.projectId,nodeId:worker.nodeId,workerId:worker.id},workerCredential:this.credentials?.issue(worker.id,worker.processId!),selectedModel:worker.model}, join(this.config.stateRoot, 'harness', worker.id), workspace, async () => {
      if (++requests > this.config.maxRequestsPerTurn) { this.emit('failure', { workerId: worker.id, error: 'Per-turn model request limit reached' }); return false; }
      return this.budget();
    }, async request => {
      if (request.sessionId !== worker.harnessSessionId) return { outcome: 'cancelled' };
      const title=request.toolCall.title,detail=request.toolCall.rawInput;
      if(live.closing||live.cancelRequested||this.closing)return {outcome:'cancelled'};
      return new Promise<{ outcome: string; optionId?: string }>(accept => {
        const id = randomUUID();
        const value = { id, toolCallId: request.toolCall.toolCallId, title: title??'Tool approval', detail: typeof detail==='string'?detail:JSON.stringify(detail??{toolCallId:request.toolCall.toolCallId},null,2), options: request.options };
        const timer = setTimeout(() => pending.get(id)?.finish(null), this.config.permissionTimeoutMs);
        pending.set(id, { value, finish: option => { clearTimeout(timer); pending.delete(id); this.syncResidency(worker); accept(option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' }); this.emit('change'); } });
        this.syncResidency(worker);this.emit('change');
      });
    });
    }catch{this.credentials?.revoke(worker.processId!);this.status(worker,'failed','Worker process configuration is unavailable');throw new Fault('SETUP_FAILED','Worker process configuration is unavailable');}
    const live: Live = { providerRevision:providerRuntime?.revision, closing: false, cancelRequested:false, harness, pending };
    this.launching.set(worker.id,harness);
    const execution={state:'idle' as 'idle'|'running'};
    const processId=worker.processId;
    const current=()=>!live.closing&&worker.processId===processId;
    harness.on('diagnostic',notice=>this.emit('failure',{workerId:worker.id,error:notice.message,code:notice.code}));
    harness.on('suspending',()=>{live.closing=true;});
    harness.on('residency',notice=>{
      if(!current()||notice.sessionId!==worker.harnessSessionId)return;
      this.residencyActivity.set(worker.id,notice);this.syncResidency(worker);this.emit('change');
    });
    harness.on('submission',notice=>{
      if(!current()||notice.sessionId!==worker.harnessSessionId)return;
      const receipt=this.submissions(worker.id).find(value=>value.id===notice.requestId);
      if(receipt?.kind==='message'&&(notice.state==='applied'||['pending','admitted','uncertain'].includes(receipt.state)))this.saveSubmission(worker.id,{...receipt,state:notice.state,retryable:false,detail:notice.detail});
    });
    harness.on('source',notice=>{
      if(!current()||notice.sessionId!==worker.harnessSessionId)return;
      this.emit('observation',{project:worker.projectId,node:worker.nodeId,workerId:worker.id,process:processId,kind:'event',event:notice.event,metrics:notice.metrics});this.emit('change');
    });
    harness.on('assistantStream',notice=>{if(!current())return;if(notice.sessionId===worker.harnessSessionId)this.emit('observation',{project:worker.projectId,node:worker.nodeId,workerId:worker.id,process:processId,kind:'assistant-stream',frame:notice.frame});});
    harness.on('status', event => {
      if(!current())return;
      if (event.sessionId !== worker.harnessSessionId) return;
      execution.state=event.status;
      if (event.status === 'running') { requests = 0; this.status(worker, 'running'); }
      else if (worker.state !== 'interrupting') this.status(worker, 'idle');
    });
    const failed = (detail: string) => {
      if (!current() || !this.live.has(worker.id)) return;
      for (const p of pending.values()) p.finish(null);
      live.closing=true;
      this.status(worker, 'uncertain', detail);
      const job=(async()=>{await this.retire(worker,live);await this.cleanup(worker);})().catch(()=>{this.emit('failure',{workerId:worker.id,error:'Worker cleanup is pending'});});
      this.jobs.set(job,worker.id);void job.finally(()=>this.jobs.delete(job));
      for (const value of this.submissions(worker.id)) if (['pending','admitted'].includes(value.state)) this.saveSubmission(worker.id, { ...value, state: 'uncertain', detail });
    };
    harness.on('exit', () => {
      if(!live.closing)failed('Harness exited; inspect saved history before explicitly resuming');
    });
    harness.on('transportError', (error: Error) => {
      if(!current() || this.closing)return;
      this.status(worker, 'uncertain', 'Harness transport failed; worker cleanup is required');
      failed('Harness transport failed; inspect saved history before explicitly resuming');
    });
    try {
      const unresolved=worker.activation?.sessionUncertain??false;
      const activation={guardian:null as z.infer<typeof GuardianIdentity>|null,id:randomUUID(),accessId:worker.environment.selection?randomUUID():null,phase:'preparing' as const,sessionUncertain:unresolved};
      worker.activation=activation;this.save(worker);
      this.mcp.delete(worker.id);
      let access:AccessGrant={id:activation.id,servers:[],components:[]};
      if(worker.environment.selection){
        if(!this.environment)throw new Fault('ENVIRONMENT_UNAVAILABLE','Environment service is not configured');
        access=await this.environment.acquire({id:activation.accessId!,owner:this.owner,principal:worker.id,workspace,environment:worker.environment.selection,requireHead:!worker.environment.locked&&!unresolved});
      }
      const checkCancelled=()=>{if(this.stopping.has(worker.id)||this.closing)throw new Fault('ACTIVATION_CANCELLED','Worker activation was cancelled');};
      checkCancelled();
      if(access.servers.some(server=>'command'in server))executionHost();
      activation.guardian=harness.recoveryIdentity??null;this.save(worker);
      const initialized=await harness.start();
      checkCancelled();
      worker.imageCapability=initialized.image;
      worker.activation!.phase='opening';worker.activation!.sessionUncertain=true;this.save(worker);
      const opened=await harness.activate(worker.harnessSessionId,access.servers,access.components.filter(component=>component.status==='unavailable').map(({serverName,code})=>({serverName,status:'unavailable',code})));
      worker.harnessSessionId=opened.sessionId;checkCancelled();this.save(worker);
      const discovered=opened.mcp;
      const availability:WorkerMcpStatus[]=access.components.map(component=>{
        if(component.status==='unavailable')return {...component,status:'unavailable'};
        const result=discovered.find(value=>value.serverName===component.serverName);
        if(!result)throw new Fault('MCP_OBSERVATION','Environment access did not match the MCP server observations');
        return {componentId:component.componentId,...result};
      });
      this.mcp.set(worker.id,availability);this.emit('change');
      const options=opened.options;
      checkCancelled();worker.configOptions=options;worker.environment.locked=true;worker.activation!.phase='active';worker.activation!.sessionUncertain=false;
      this.live.set(worker.id, live);
      this.status(worker,execution.state);
      try{this.residencyActivity.set(worker.id,await harness.activity(worker.harnessSessionId));}
      catch(error){this.residencyActivity.delete(worker.id);this.emit('failure',{workerId:worker.id,error:'Idle activity could not be verified; worker remains resident'});}
      this.syncResidency(worker);return live;
    } catch (error) {
      live.closing=true;
      // A failed create can have published a session before its response was lost.
      if(worker.activation?.sessionUncertain&&!worker.harnessSessionId){
        try{const session=await harness.locate();
          if(session===null)worker.activation.sessionUncertain=false;
          else worker.harnessSessionId=session;
        }catch{/* Retain uncertainty until explicit recovery can query DSH. */}
      }
      await this.retire(worker,live);
      this.status(worker,'failed',error instanceof Fault?error.message:'Worker setup failed; inspect configuration and retry');
      await this.cleanup(worker);throw error instanceof Fault?error:new Fault('SETUP_FAILED','Worker setup failed; inspect configuration and retry');
    } finally {this.launching.delete(worker.id);}
  }
  /** Hold execution capacity and environment access until process exit is confirmed. */
  private async retire(worker:Binding,live:Live){
    this.idle.forget(worker.id);this.residencyActivity.delete(worker.id);
    if(worker.processId)this.credentials?.revoke(worker.processId);
    live.closing=true;
    try{await live.harness.close();}
    catch{
      this.live.set(worker.id,live);if(worker.activation)worker.activation.phase='cleanup';this.status(worker,'uncertain','Worker execution cleanup is unconfirmed; capacity and access remain retained');throw new Fault('PROCESS_CLOSE_FAILED','Worker execution cleanup is unconfirmed; capacity and access remain retained');
    }
    if(worker.activation){worker.activation.guardian=null;this.save(worker);}
    if(this.live.get(worker.id)===live)this.live.delete(worker.id);
  }
  /** Visibility is independent of execution and permission lifetimes. */
  archive(project:string,node:string,id:string,archived:boolean) {const worker=this.binding(project,node,id);worker.archived=archived;this.save(worker);return this.list(project,node).find(s=>s.id===id)!;}
  /** Save an inactive choice or confirm an idle-session change before admitting any next turn. */
  async configure(project:string,node:string,id:string,configId:string,value:string) {
    if(this.transitions.has(id)||this.closing)throw new Fault('MODEL_BUSY','A model transition is already pending or Main is closing');
    const task=this.applyConfiguration(project,node,id,configId,value);this.transitions.set(id,task);
    try{return await task;}finally{this.transitions.delete(id);const worker=this.bindings.get(id);if(worker)this.syncResidency(worker);}
  }
  private async applyConfiguration(project:string,node:string,id:string,configId:string,value:string) {
    const worker=this.binding(project,node,id);
    if(this.unloading.has(id)||!['idle','inactive','failed'].includes(worker.state)||this.starts.has(id)||this.stopping.has(id)||worker.activation?.phase==='cleanup'||this.submissions(id).some(s=>['pending','admitted'].includes(s.state)&&s.kind==='message'))throw new Fault('MODEL_BUSY','Model changes require a settled worker');
    const priorState=worker.state,live=this.live.get(id);
    if(live&&this.providers&&live.providerRevision!==this.providers.currentRevision)throw new Fault('PROVIDER_UPDATE_PENDING','Provider settings changed; wait for background work to settle, or close and resume this worker');
    this.status(worker,'starting');
    try {
      if(!live){
        const choice=(await this.catalog.choices()).find(option=>option.value===value);
        if(configId!=='model'||!choice)throw new Fault('MODEL_OPTION','Select an advertised model',400);
        if(this.stopping.has(id)||this.closing)throw new Fault('WORKER_CLOSING','Worker is closing');
        worker.model=value;worker.imageCapability=choice.image;this.status(worker,priorState);return this.view(JSON.stringify(worker));
      }
      const option=worker.configOptions.find(o=>o.id===configId);
      if(!option?.options.some(o=>o.value===value))throw new Fault('MODEL_OPTION','Select an advertised configuration value',400);
      const confirmed=await live.harness.configure(worker.harnessSessionId!,configId,value);
      if(confirmed.find(option=>option.id===configId)?.currentValue!==value)throw new Fault('MODEL_UNAVAILABLE','DSH did not confirm the selected model');
      worker.configOptions=confirmed;
      worker.model=worker.configOptions.find(o=>o.id==='model')?.currentValue??null;this.save(worker);
      if(configId==='model') {
        live.closing=true;await live.harness.closeSession(worker.harnessSessionId!);await this.retire(worker,live);
        await this.start(worker);
      } else this.status(worker,'idle');
      return this.list(project,node).find(s=>s.id===id)!;
    } catch(error) {
      if(error instanceof Fault&&error.code==='MODEL_OPTION'){this.status(worker,priorState);throw error;}
      if(live){await this.retire(worker,live);await this.cleanup(worker);}
      this.status(worker,live?'uncertain':priorState,'Model configuration did not settle; retry the selected route');throw error instanceof Fault?error:new Fault('MODEL_UNAVAILABLE','Model configuration did not settle');
    }
  }
  private imageBinding(worker:string,id:string):StagedImage {
    const row=this.db.prepare('SELECT data FROM images WHERE id=? AND worker_id=?').get(id,worker) as {data:string}|undefined;
    if(!row)throw new Fault('IMAGE_NOT_FOUND','Image is not staged for this worker',404);return JSON.parse(row.data) as StagedImage;
  }
  async stagedImage(project:string,node:string,worker:string,id:string) {
    this.binding(project,node,worker);const value=this.imageBinding(worker,id),bytes=await readFile(join(this.config.stateRoot,'images',id));
    if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.uploadedDigest)throw new Fault('IMAGE_UNAVAILABLE','Staged image is missing or damaged');return {bytes,mediaType:value.mediaType};
  }
  /** Ingress hashes identify original bytes; DSH alone owns normalization and durable attachment references. */
  async stageImage(project:string,node:string,worker:string,id:string,name:string,mediaType:string,bytes:Buffer):Promise<StagedImage> {
    if(this.closing)throw new Fault('SHUTTING_DOWN','Main is shutting down');
    const task=this.imageTail.then(async()=>{
    this.binding(project,node,worker);
    if(bytes.length>this.config.maxFileBytes||bytes.length===0)throw new Fault('IMAGE_LIMIT','Image exceeds configured byte limit',413);
    const detected=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.subarray(0,3).toString()==='GIF'?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
    if(mediaType!==detected)throw new Fault('IMAGE_TYPE','Only PNG, JPEG, GIF and WebP image bytes are admitted',400);
    // Validate all frames within explicit allocation bounds while retaining the original upload bytes.
    try {
      const decoder=sharp(bytes,{animated:true,limitInputPixels:this.config.maxImagePixels,failOn:'warning'});
      const metadata=await decoder.metadata();
      if(!metadata.width||!metadata.height||metadata.width*metadata.height*4>this.config.maxDecodedImageBytes)throw new Error('Decoded image exceeds configured byte limit');
      const decoded=await decoder.ensureAlpha().raw().toBuffer();
      if(decoded.length>this.config.maxDecodedImageBytes)throw new Error('Decoded image exceeds configured byte limit');
    } catch(error) {throw new Fault('IMAGE_DECODE',`Image cannot be decoded within configured dimensions and byte limits: ${String(error)}`,400);}
    const value:StagedImage={id,name,mediaType,bytes:bytes.length,uploadedDigest:createHash('sha256').update(bytes).digest('hex')};
    const prior=this.db.prepare('SELECT worker_id AS workerId,data FROM images WHERE id=?').get(id) as {workerId:string;data:string}|undefined;
    if(prior) {if(prior.workerId!==worker||prior.data!==JSON.stringify(value))throw new Fault('OPERATION_CONFLICT','Image identity has different content');try{const saved=await readFile(join(this.config.stateRoot,'images',id));if(saved.equals(bytes))return value;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    const total=(this.db.prepare('SELECT data FROM images').all() as {data:string}[]).reduce((sum,row)=>sum+(JSON.parse(row.data) as StagedImage).bytes,0);
    if(total+(prior?0:bytes.length)>this.config.maxStagedBytes)throw new Fault('STAGING_LIMIT','Retained images exceed staging budget');
    this.db.prepare('INSERT OR IGNORE INTO images VALUES (?,?,?)').run(id,worker,JSON.stringify(value));
    const dir=join(this.config.stateRoot,'images');await mkdir(dir,{recursive:true,mode:0o700});
    const file=await open(join(dir,id+'.receiving'),'w',0o600);try {await file.writeFile(bytes);await file.sync();}finally {await file.close();}
    await rename(join(dir,id+'.receiving'),join(dir,id));
    const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
    return value;
    });this.imageTail=task.then(()=>{},()=>{});return task;
  }
  /** Resolve stable worker identity without activating execution or guessing from cwd. */
  get(id:string){const row=this.db.prepare('SELECT data FROM workers WHERE id=?').get(id) as {data:string}|undefined;if(!row)throw new Fault('WORKER_NOT_FOUND','Worker does not exist',404);return this.view(row.data);}
  workers(project:string,node?:string){return (this.db.prepare('SELECT data FROM workers WHERE project=? ORDER BY rowid').all(project) as {data:string}[]).map(row=>this.view(row.data)).filter(value=>!node||value.nodeId===node);}
  /** Compact owner reads never load creation instructions, submission bodies or native history.
   * SQL counts cover all retained deliveries, including those outside worker.get's recent window. */
  overviewWorker(id:string):OverviewWorker {
    const row=this.db.prepare(`SELECT json_object('id',id,'projectId',project,'nodeId',node,
      'name',json_object('text',substr(json_extract(data,'$.title'),1,?),'truncated',json(CASE WHEN length(json_extract(data,'$.title'))>? THEN 'true' ELSE 'false' END)),
      'state',json_extract(data,'$.state'),'model',json_extract(data,'$.model'),
      'error',CASE WHEN json_extract(data,'$.error') IS NULL THEN NULL ELSE json_object('text',substr(json_extract(data,'$.error'),1,?),'truncated',json(CASE WHEN length(json_extract(data,'$.error'))>? THEN 'true' ELSE 'false' END)) END,'environment',json_extract(data,'$.environment'),
      'cleanupPending',json(CASE WHEN json_extract(data,'$.activation.phase')='cleanup' THEN 'true' ELSE 'false' END)) AS data FROM workers WHERE id=?`).get(this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,id) as {data:string}|undefined;
    if(!row)throw new Fault('WORKER_NOT_FOUND','Worker does not exist',404);
    const raw=z.object({id:Id,projectId:Id,nodeId:Id,name:z.object({text:z.string(),truncated:z.boolean()}),state:z.enum(['inactive','closed','starting','idle','running','interrupting','uncertain','failed']),model:z.string().nullable(),error:z.object({text:z.string(),truncated:z.boolean()}).nullable(),environment:WorkerEnvironment,cleanupPending:z.boolean()}).parse(JSON.parse(row.data));
    return OverviewWorker.parse({...raw,residency:this.config.workerIdleUnloadMs===null?'disabled':this.unloading.has(id)?'unloading':!this.live.has(id)?'inactive':this.residencyActivity.has(id)?'resident':'unknown',connections:(this.mcp.get(id)??[]).slice(0,this.config.workerOverviewPageSize),connectionsKnown:this.mcp.has(id),connectionTotal:this.mcp.get(id)?.length??0,unavailableConnections:(this.mcp.get(id)??[]).reduce((count,c)=>count+Number(c.status==='unavailable'),0),active:this.live.has(id)});
  }
  /** Stable ID ordering supports live keyset pages without copying worker records. */
  overviewCoworkers(worker:Pick<OverviewWorker,'id'|'projectId'|'nodeId'>,after:string,limit:number):{total:number;items:OverviewCoworker[]} {
    const where="project=? AND node=? AND id<>? AND json_extract(data,'$.archived')=0";
    const args=[worker.projectId,worker.nodeId,worker.id];
    const total=(this.db.prepare(`SELECT count(*) AS total FROM workers WHERE ${where}`).get(...args) as {total:number}).total;
    const rows=this.db.prepare(`SELECT id,substr(json_extract(data,'$.title'),1,?) AS name,length(json_extract(data,'$.title'))>? AS truncated,json_extract(data,'$.state') AS state FROM workers WHERE ${where} AND id>? ORDER BY id LIMIT ?`).all(this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,...args,after,limit) as {id:string;name:string;truncated:number;state:WorkerState}[];
    return {total,items:rows.map(row=>({id:row.id,name:{text:row.name,truncated:!!row.truncated},state:row.state}))};
  }
  /** Permissions precede pending delivery; recorded failures are historical and always last.
   * Only an existing CLI receipt yields an operation reference. */
  overviewAttention(id:string,after:AttentionPosition,limit:number):{totals:{permissions:number;pendingDelivery:number;historicalDelivery:number};items:OverviewAttention[]} {
    const pending=this.live.get(id)?.pending;
    const permissionIds=[...(pending?.keys()??[])].sort();
    const items:OverviewAttention[]=[];
    for(const key of permissionIds){if(items.length>=limit)break;if(after.rank>1||(after.rank===1&&key<=after.id))continue;const permission=pending!.get(key)!.value;
      items.push({id:key,kind:'permission',code:'PERMISSION_PENDING',title:overviewText(permission.title,this.config.workerOverviewTextChars),detail:null,sender:null,deliveryState:null,operation:null,inspect:`harnessctl worker get ${id}`});}
    const counts=this.db.prepare(`SELECT count(CASE WHEN json_extract(data,'$.state') IN ('pending','admitted') THEN 1 END) AS pendingDelivery,count(CASE WHEN json_extract(data,'$.state') IN ('failed','interrupted','uncertain') THEN 1 END) AS historicalDelivery FROM submissions WHERE worker_id=? AND json_extract(data,'$.kind')='message'`).get(id) as {pendingDelivery:number;historicalDelivery:number};
    const rows=this.db.prepare(`SELECT s.id,json_extract(s.data,'$.state') AS state,
      substr(json_extract(s.data,'$.detail'),1,?) AS detail,length(json_extract(s.data,'$.detail'))>? AS detailTruncated,
      json_extract(s.data,'$.sender.id') AS senderId,substr(json_extract(s.data,'$.sender.name'),1,?) AS senderName,length(json_extract(s.data,'$.sender.name'))>? AS senderTruncated,
      CASE WHEN json_extract(s.data,'$.state') IN ('pending','admitted') THEN 2 ELSE 3 END AS rank,
      (SELECT json_extract(r.data,'$.reference') FROM requests r WHERE r.id=s.id AND json_extract(r.data,'$.command')='worker.send') AS operation
      FROM submissions s WHERE worker_id=? AND json_extract(s.data,'$.kind')='message' AND json_extract(s.data,'$.state') IN ('pending','admitted','failed','interrupted','uncertain')
      AND (rank>? OR (rank=? AND s.id>?)) ORDER BY rank,s.id LIMIT ?`).all(this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,this.config.workerOverviewTextChars,id,after.rank,after.rank,after.id,limit-items.length) as {id:string;state:'pending'|'admitted'|'failed'|'interrupted'|'uncertain';detail:string|null;detailTruncated:number;senderId:string|null;senderName:string|null;senderTruncated:number;rank:number;operation:string|null}[];
    for(const row of rows)items.push({id:row.id,kind:row.rank===2?'pendingDelivery':'historicalDelivery',code:row.rank===2?'DELIVERY_PENDING':'DELIVERY_RECORDED',title:overviewText(row.rank===2?'Incoming message not yet confirmed applied':'Historical delivery outcome',this.config.workerOverviewTextChars),detail:row.detail===null?null:{text:row.detail,truncated:!!row.detailTruncated},sender:row.senderId?{id:row.senderId,name:{text:row.senderName!,truncated:!!row.senderTruncated}}:null,deliveryState:row.state,operation:row.operation,inspect:row.operation?`harnessctl operation get ${row.operation}`:`harnessctl worker history ${id}`});
    return {totals:{permissions:permissionIds.length,...counts},items};
  }
  /** Resolve the created initial worker without loading conversations or settings.
   * An unfinished provisioning intent is not yet a usable worker. */
  initialWorkerId(project:string):string|null {
    return (this.db.prepare('SELECT w.id FROM project_initial_workers i JOIN workers w ON w.id=i.worker AND w.project=i.project AND w.node=i.node WHERE i.project=?').get(project) as {id:string}|undefined)?.id??null;
  }
  private requestJournal?:Operations;
  private requests(){return this.requestJournal??=new Operations(this.db,'main:worker',this.config.cliMaxRecords);}
  operation(id:string){return this.requests().get(id);}
  async executeRequest(id:string,actor:Actor,command:string,input:unknown,effect:()=>Promise<unknown>,recoverable=false){
    let existing=false;try{this.requests().get(id);existing=true;}catch(error){if(!(error instanceof Fault)||error.code!=='OPERATION_NOT_FOUND')throw error;}
    const receipt=await this.requests().run(id,actor,command,input,recoverable,effect);
    // A send receipt acknowledges admission; its independently persisted submission owns completion and setup recovery.
    if(existing&&command==='worker.send'&&receipt.state==='succeeded'){
      const submission=this.submission(id);
      if(submission.state==='failed'&&submission.retryable){const {target}=z.object({target:Id}).parse(input);const worker=this.get(target);this.retry(worker.projectId,worker.nodeId,worker.id,id);}
    }
    return receipt;
  }
  editRequest(id:string,actor:Actor,command:string,input:unknown,effect:()=>unknown){return this.requests().sync(id,actor,command,input,effect);}
  submission(id:string){const row=this.db.prepare('SELECT data FROM submissions WHERE id=?').get(id) as {data:string}|undefined;if(!row)throw new Fault('SUBMISSION_NOT_FOUND','Submission does not exist',404);return Submission.parse(JSON.parse(row.data));}
  /** Recover one browser request independently of receipt pagination, without activating its worker. */
  readSubmission(project:string,node:string,id:string,submissionId:string):Submission{
    this.binding(project,node,id);
    const row=this.db.prepare('SELECT data FROM submissions WHERE worker_id=? AND id=?').get(id,submissionId) as {data:string}|undefined;
    if(!row)throw new Fault('SUBMISSION_NOT_FOUND','Submission does not belong to this worker',404);
    return Submission.parse(JSON.parse(row.data));
  }
  /** Authorization is checked before the execution-free integration resolves retained evidence. */
  async evidence(project:string,node:string,id:string,reference:string){return this.historyStore.evidence(this.binding(project,node,id),reference);}
  async resume(project: string, node: string, id: string) {
    const unloading=this.unloading.get(id);if(unloading)await unloading;
    if(this.closing)throw new Fault('SHUTTING_DOWN','Main is shutting down');
    const worker=this.binding(project,node,id);
    if(this.transitions.has(id)||this.stopping.has(id))throw new Fault('SETUP_BUSY','Worker configuration is changing');
    if(worker.closeRequested){worker.closeRequested=false;this.save(worker);}
    if(worker.state==='closed'&&!worker.harnessSessionId&&!worker.activation){this.status(worker,'inactive');return;}
    if(!worker.harnessSessionId&&!worker.activation)throw new Fault('FIRST_MESSAGE_REQUIRED','Send the first message to activate this worker');
    await this.start(worker);
  }
  /** Retain original input and authenticated sender once. Names may change, but
   * retries cannot change authorship. DSH alone decides when input enters execution. */
  async submit(project:string,node:string,id:string,input:WorkerInput,actor:Actor=owner):Promise<Submission> {
    if(this.closing)throw new Fault('SHUTTING_DOWN','Main is shutting down');
    const worker=this.binding(project,node,id),kind='kind' in input?'interrupt':'message';
    const prior=this.db.prepare('SELECT worker_id AS workerId,data FROM submissions WHERE id=?').get(input.id) as {workerId:string;data:string}|undefined;
    if(prior){
      const value=Submission.parse(JSON.parse(prior.data));
      if(prior.workerId!==id||value.kind!==kind||value.text!==input.text||JSON.stringify(value.content??[])!==JSON.stringify('content' in input?input.content??[]:[])||(kind==='message'&&value.sender?.id!==(actor.kind==='worker'?actor.id:undefined)))throw new Fault('SUBMISSION_CONFLICT','Submission identity already has different content or sender');
      return value;
    }
    const sender=kind==='message'&&actor.kind==='worker'?this.get(actor.id):undefined;
    const unsettled=this.submissions(id).filter(value=>['pending','admitted'].includes(value.state));
    if(kind==='message'){
      if(worker.closeRequested||['closed','uncertain'].includes(worker.state)||(worker.state==='failed'&&this.submissions(id).some(value=>value.state==='uncertain')))throw new Fault('RESUME_REQUIRED','Inspect retained history and explicitly resume this worker');
      if(this.transitions.has(id)||(!this.unloading.has(id)&&(this.stopping.has(id)||worker.activation?.phase==='cleanup'))||worker.state==='interrupting')throw new Fault('WORKER_BUSY','Wait for the current lifecycle transition to settle');
      if(unsettled.filter(value=>value.kind==='message').length>=this.config.maxPendingMessages)throw new Fault('MESSAGE_CAPACITY','Worker input capacity is full; inspect existing receipts before retrying');
      if('content' in input&&input.content?.some(part=>part.type==='image')){
        if(!worker.imageCapability)throw new Fault('IMAGE_UNSUPPORTED','Select and confirm an image-capable model before sending images');
        for(const part of input.content)if(part.type==='image')this.imageBinding(id,part.attachmentId);
      }
    }else{
      for(const pending of unsettled)if(pending.state==='pending'&&pending.retryable)this.saveSubmission(id,{...pending,state:'interrupted',retryable:false,detail:'Interrupted before application was confirmed'});
      if(this.starts.has(id)){
        const value:Submission={...structuredClone(input),kind,state:'pending',retryable:false};this.saveSubmission(id,value);
        const job=this.closeWorker(project,node,id).then(()=>this.saveSubmission(id,{...value,state:'completed'}),()=>this.saveSubmission(id,{...value,state:'uncertain',detail:'Activation cancellation requires cleanup'}));
        this.controls.add(job);void job.finally(()=>this.controls.delete(job));return structuredClone(value);
      }
      if(!this.live.has(id))throw new Fault('NOT_RUNNING','Worker is not active');
    }
    const value:Submission={...structuredClone(input),kind,state:'pending',retryable:kind==='message',...sender?{sender:{id:sender.id,name:sender.title}}:{}};
    this.saveSubmission(id,value);this.dispatch(worker,value);return structuredClone(value);
  }
  /** Only input proven not dispatched may reuse its receipt for an explicit retry. */
  retry(project:string,node:string,id:string,submissionId:string){
    const worker=this.binding(project,node,id),value=this.submissions(id).find(value=>value.id===submissionId);
    if(!value)throw new Fault('SUBMISSION_NOT_FOUND','Submission does not belong to this worker',404);
    if(value.state==='pending'||value.state==='admitted')return value;
    if(!value.retryable||value.state!=='failed'||value.kind!=='message')throw new Fault('RETRY_UNSAFE','This submission may have executed; inspect history instead');
    if(this.closing||this.transitions.has(id)||this.stopping.has(id)||worker.closeRequested||['interrupting','closed'].includes(worker.state)||worker.activation?.phase==='cleanup'||(worker.state==='uncertain'&&(this.live.has(id)||this.submissions(id).some(other=>other.state==='uncertain'))))throw new Fault('WORKER_BUSY','Worker lifecycle is unsettled; inspect existing receipts before retry');
    if(this.submissions(id).filter(other=>other.id!==value.id&&other.kind==='message'&&['pending','admitted'].includes(other.state)).length>=this.config.maxPendingMessages)throw new Fault('MESSAGE_CAPACITY','Worker input capacity is full; inspect existing receipts before retrying');
    const pending:Submission={...value,state:'pending',detail:undefined};this.saveSubmission(id,pending);
    // Explicit retry can recover interrupted setup once every receipt proves no dispatch.
    if(worker.state==='uncertain')this.status(worker,'inactive');
    this.dispatch(worker,pending);return structuredClone(pending);
  }
  private dispatch(worker:Binding,value:Submission){
    const previous=value.kind==='message'?this.admissions.get(worker.id):undefined;
    const job=(async()=>{
      const unloading=this.unloading.get(worker.id);if(unloading)await unloading;
      if(previous)await previous;
      if(this.submission(value.id).state!=='pending')return;
      await this.deliver(worker,value);
    })().catch(error=>{
      const uncertain=error instanceof Fault&&['EXECUTION_UNCERTAIN','INTERRUPT_UNCERTAIN'].includes(error.code);
      const detail=error instanceof Fault?error.message:'Worker operation failed';
      const current=this.submission(value.id);
      if(!['applied','completed','interrupted'].includes(current.state))this.saveSubmission(worker.id,{...current,state:uncertain?'uncertain':'failed',retryable:!uncertain&&value.retryable,detail});
      this.emit('failure',{workerId:worker.id,error:detail});
    }).finally(()=>{if(this.admissions.get(worker.id)===job)this.admissions.delete(worker.id);this.syncResidency(worker);});
    if(value.kind==='message')this.admissions.set(worker.id,job);
    this.jobs.set(job,worker.id);void job.finally(()=>this.jobs.delete(job));
  }
  private async deliver(worker:Binding,value:Submission) {
    if(value.kind==='message'&&(worker.closeRequested||this.closing||this.stopping.has(worker.id)||['interrupting','uncertain'].includes(worker.state)))throw new Fault('DELIVERY_STOPPED','Worker lifecycle changed before delivery; inspect the receipt');
    if(value.kind==='message'&&this.providers){
      const resident=this.live.get(worker.id);
      if(resident&&resident.providerRevision!==this.providers.currentRevision&&worker.state!=='running')throw new Fault('PROVIDER_UPDATE_PENDING','Provider settings changed; wait for background work to settle, or close and resume this worker');
    }
    const live=await this.start(worker);
    if(this.submission(value.id).state!=='pending')return;
    if(live.closing||this.closing||worker.closeRequested||this.stopping.has(worker.id))throw new Fault('DELIVERY_STOPPED','Worker lifecycle changed before delivery; inspect the receipt');
    const sessionId=worker.harnessSessionId!;
    if(value.kind==='interrupt'){
      live.cancelRequested=true;this.status(worker,'interrupting');
      for(const p of live.pending.values())p.finish(null);
      try{
        await live.harness.interrupt(sessionId);
        live.cancelRequested=false;this.status(worker,'idle');this.saveSubmission(worker.id,{...value,state:'completed'});
      }catch{
        // A lost cancellation acknowledgement cannot prove whether dispatched
        // input was consumed or discarded. Later native evidence may resolve it.
        for(const receipt of this.submissions(worker.id))if(receipt.kind==='message'&&!receipt.retryable&&['pending','admitted'].includes(receipt.state))this.saveSubmission(worker.id,{...receipt,state:'uncertain',detail:'Interruption was not confirmed; inspect recorded history'});
        throw new Fault('INTERRUPT_UNCERTAIN','Interruption did not settle; inspect history or close the worker');
      }
      return;
    }
    if(value.content?.some(part=>part.type==='image')&&!worker.imageCapability)throw new Fault('IMAGE_UNSUPPORTED','The current process did not negotiate image input');
    const content:InputPart[]=[];
    for(const part of submissionContent(value)){
      if(part.type==='text')content.push(part);
      else{
        const image=this.imageBinding(worker.id,part.attachmentId),bytes=await readFile(join(this.config.stateRoot,'images',image.id));
        if(createHash('sha256').update(bytes).digest('hex')!==image.uploadedDigest)throw new Fault('IMAGE_CORRUPT','Retained image does not match uploaded digest');
        content.push({type:'image',data:bytes.toString('base64'),mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif']).parse(image.mediaType)});
      }
    }
    // File reads may yield to cancellation. Never dispatch content after its receipt was interrupted.
    if(this.submission(value.id).state!=='pending')return;
    if(live.closing||live.cancelRequested||this.closing||worker.closeRequested||this.stopping.has(worker.id)||worker.state==='interrupting')throw new Fault('DELIVERY_STOPPED','Worker lifecycle changed before delivery; inspect the receipt');
    this.tree.workspace(worker.projectId,worker.nodeId,'write');
    value.retryable=false;this.saveSubmission(worker.id,value);
    try{
      await live.harness.message(sessionId,value.id,content,value.sender?{kind:'worker',workerId:value.sender.id}:{kind:'human'});
      if(this.submission(value.id).state==='pending')this.saveSubmission(worker.id,{...value,state:'admitted'});
    }catch(error){
      const code=error instanceof Error&&'code' in error?String(error.code):'';
      if(['MESSAGE_INVALID','IMAGE_UNSUPPORTED','IMAGE_ADMISSION_FAILED','MESSAGE_CANCELLED','SESSION_INACTIVE','WORKER_INTERRUPTING'].includes(code)){
        value.retryable=true;throw new Fault(code,(error as Error).message);
      }
      throw new Fault('EXECUTION_UNCERTAIN','Message acknowledgement was lost; inspect recorded history before retrying');
    }
  }
  permission(project: string, node: string, worker: string, id: string, option: string) {
    this.binding(project, node, worker);
    const pending = this.live.get(worker)?.pending.get(id);
    if (!pending || !pending.value.options.some(o => o.optionId === option)) throw new Fault('PERMISSION_STALE', 'Permission request is expired or already answered');
    pending.finish(option);
  }
  /** Local lifecycle facts complement DSH's authoritative execution observation. */
  private residencyBlockers(worker:Binding):string[]{
    if(!this.live.has(worker.id))return [];
    const blockers:string[]=this.residencyActivity.get(worker.id)?.blockers.map(value=>value.kind)??['unknown'];
    if(worker.state!=='idle'||worker.closeRequested||this.closing||this.starts.has(worker.id)||this.transitions.has(worker.id)||this.stopping.has(worker.id))blockers.push('lifecycle');
    if(this.live.get(worker.id)?.pending.size)blockers.push('approval');
    if(this.admissions.has(worker.id)||this.submissions(worker.id).some(value=>['pending','admitted'].includes(value.state)))blockers.push('admission');
    return [...new Set(blockers)];
  }
  private syncResidency(worker:Binding){
    const activity=this.residencyActivity.get(worker.id);
    this.idle.observe(worker.id,activity?.revision??0,!!activity?.eligible&&this.live.has(worker.id)&&!this.unloading.has(worker.id)&&this.residencyBlockers(worker).length===0);
    if(this.providers&&this.live.get(worker.id)?.providerRevision!==this.providers.currentRevision&&activity?.eligible&&!this.unloading.has(worker.id)&&this.live.has(worker.id)&&this.residencyBlockers(worker).length===0){
      void this.unload(worker.id,activity.revision).catch(()=>this.emit('failure',{workerId:worker.id,error:'Provider update could not settle; close and resume this worker'}));
    }
  }
  /** Reserve quiescence before closing. New submissions wait for this transition;
   * unlike explicit Close, no unadmitted input is cancelled or marked uncertain. */
  private async unload(id:string,revision:number){
    if(this.unloading.has(id))return this.unloading.get(id);
    const worker=this.bindings.get(id),live=this.live.get(id);
    if(!worker||!live||this.residencyBlockers(worker).length||this.residencyActivity.get(id)?.revision!==revision)return;
    const task=this.unloadReserved(worker,live,revision);
    this.unloading.set(id,task);this.idle.forget(id);this.emit('change');
    try{await task;}finally{this.unloading.delete(id);this.syncResidency(worker);this.emit('change');}
  }
  private async unloadReserved(worker:Binding,live:Live,revision:number){
    try{
      const result=await live.harness.suspend(worker.harnessSessionId!,revision,()=>this.residencyBlockers(worker).length===0);
      this.residencyActivity.set(worker.id,result.snapshot);
      if(!result.suspended)return;
      await this.retire(worker,live);await this.cleanup(worker);
      worker.lastUnloadedAt=Date.now();this.residencyActivity.delete(worker.id);
      this.status(worker,worker.closeRequested?'closed':'inactive');
      this.emit('unloaded',{workerId:worker.id,reason:'idle',at:worker.lastUnloadedAt});
    }catch(error){
      this.residencyActivity.delete(worker.id);
      if(live.closing||error instanceof Fault&&error.code==='RESERVATION_UNCERTAIN'){
        if(worker.activation)worker.activation.phase='cleanup';
        this.status(worker,'uncertain','Idle suspension did not settle; inspect and close this worker before resuming');
      }
      throw error;
    }
  }
  async closeWorker(project: string, node: string, id: string) {
    const existing=this.closes.get(id);if(existing)return existing;
    const worker=this.binding(project,node,id);worker.closeRequested=true;this.save(worker);
    // Explicit Close remains the recovery path even when automatic settlement failed.
    const task=(async()=>{const unloading=this.unloading.get(id);if(unloading)await unloading.catch(()=>{});await this.stopWorker(project,node,id);})();this.closes.set(id,task);
    try{await task;}finally{this.closes.delete(id);}
  }
  private async stopWorker(project:string,node:string,id:string,explicit=true){
    const worker = this.binding(project, node, id);
    this.stopping.add(id);
    try{
    await this.transitions.get(id)?.catch(()=>{});
    if(this.starts.has(id)){
      try{await this.launching.get(id)?.close();}catch{this.emit('failure',{workerId:id,error:'Process close requires activation reconciliation'});}
      await this.starts.get(id)?.catch(()=>{});
    }
    const live = this.live.get(id);
    if (live) {
      live.closing = true;
      for (const p of live.pending.values()) p.finish(null);
      try { await live.harness.closeSession(worker.harnessSessionId!); }
      catch{this.emit('failure',{workerId:id,error:'Session close was not acknowledged; stopping the supervised process'});}
      finally {
        await this.retire(worker,live);
        await Promise.allSettled([...this.jobs].filter(([,owner])=>owner===id).map(([job])=>job));
        this.live.delete(id);
        for(const receipt of this.submissions(id)) if(['pending','admitted'].includes(receipt.state)) this.saveSubmission(id,{...receipt,state:'uncertain',detail:'Worker closed before application was confirmed; inspect history'});
      }
    }
    await this.cleanup(worker);
    this.status(worker, explicit?'closed':'inactive');
    }finally{this.stopping.delete(id);}
  }
  /** Opens a finite authoritative cut without starting a process. Subscribe to observation before invoking this method. */
  async observe(project:string,node:string,id:string) {
    const worker=this.binding(project,node,id), live=this.live.get(id);
    if(live) {
      const result=await live.harness.observe(worker.harnessSessionId!);
      const cut=this.historyStore.retain(worker,result.events,result.metrics);
      const page=await this.history(project,node,id,cut);
      return {page,cursor:result.cursor,assistantStream:result.assistantStream,process:worker.processId};
    }
    if(!worker.harnessSessionId)return {page:null,cursor:-1,assistantStream:{revision:0},process:null};
    const page=await this.history(project,node,id);
    return {page,cursor:page.events.at(-1)?.seq??-1,assistantStream:{revision:0},process:null};
  }
  async history(project:string,node:string,id:string,cutId?:string,before?:number):Promise<HistoryPage>{
    const worker=this.binding(project,node,id),page=await this.historyStore.history(worker,cutId,before);
    const applied=new Set(this.historyStore.applied(worker,page.cut));
    for(const receipt of this.submissions(id))if(receipt.kind==='message'&&applied.has(receipt.id)&&(receipt.state!=='applied'||receipt.detail))this.saveSubmission(id,{...receipt,state:'applied',detail:undefined});
    return page;
  }
  async image(project:string,node:string,id:string,attachmentId:string){return this.historyStore.image(this.binding(project,node,id),attachmentId);}
  async attachment(project:string,node:string,id:string,cutId:string,seq:number,index:number){return this.historyStore.attachment(this.binding(project,node,id),cutId,seq,index);}
  async close() {
    this.closing = true;
    this.idle.close();
    await Promise.allSettled([...this.unloading.values()]);
    await Promise.allSettled([...this.transitions.values()]);
    await this.imageTail;
    await this.historyStore.close();
    await Promise.allSettled([...this.starts.values()]);
    const closures=await Promise.allSettled([...this.live.keys()].map(id => {
      const row = this.db.prepare('SELECT data FROM workers WHERE id=?').get(id) as {data:string};
      const worker = StoredWorker.parse(JSON.parse(row.data));
      return this.closes.get(id)??this.stopWorker(worker.projectId, worker.nodeId, id,false);
    }));
    await Promise.allSettled([...this.jobs.keys()]);
    await Promise.allSettled([...this.controls]);
    for(const worker of this.bindings.values())if(worker.activation?.accessId||worker.activation?.guardian)try{await this.cleanup(worker);}catch{this.emit('failure',{workerId:worker.id,error:'Environment cleanup remains pending at shutdown'});}
    if(this.catalog instanceof HarnessCatalog)await this.catalog.close();
    this.db.close();
    if(closures.some(result=>result.status==='rejected'))throw new Fault('PROCESS_CLOSE_FAILED','Worker cleanup remains pending after shutdown');
  }
}
