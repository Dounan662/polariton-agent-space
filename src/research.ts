import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, open, stat, readdir, realpath, lstat, rename, link, unlink } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { openSync, closeSync, fstatSync, statSync, constants } from 'node:fs';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { z } from 'zod';
import { Operations, type Actor } from './operations.ts';
import { Fault, Id, Text, Mutation, type Project, type Graph, Checkpoint, CheckpointPublication, type WorkspaceEntry, type FilePage, UploadPublication, type UploadReceipt } from './contracts.ts';
import { GitCheckpoints } from './git-checkpoints.ts';
import { CheckpointContent } from './checkpoint-content.ts';
import type { Config } from './config.ts';

const execute = promisify(execFile);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' });
const RecordSchema = z.object({ version: z.literal(1), seq: z.number().int().positive(), mutation: Mutation, checksum: z.string() }).strict();
type State = { graph: Graph; receipts: Map<string, string> };
type Journal = { id: string; project: string; node: string; kind: string; payload: string; state: string };

/** Owns graph authority and durable workspace publication. Publications exclude
 * other publishers, never worker execution or ordinary file edits. */
export class ResearchTree extends EventEmitter {
  private db: DatabaseSync;
  private states = new Map<string, State>();
  private tails = new Map<string, Promise<unknown>>();
  private publishing = new Set<string>();
  private publications = new AbortController();
  private pendingPublications = new Set<Promise<Checkpoint>>();
  private checkpointStore: GitCheckpoints;
  private checkpointContent: CheckpointContent;
  private closing?: Promise<void>;
  private config: Config;
  private lock: number | null = null;
  private relocated = new Set<string>();
  private roots = new Map<string, Project>();
  private projectLocks = new Map<string, number>();
  private clock: () => number;
  constructor(config: Config, clock: () => number = Date.now) {
    super();
    this.config = config;
    this.clock = clock;
    this.db = new DatabaseSync(join(config.stateRoot, 'research.sqlite'));
    this.checkpointStore = new GitCheckpoints(this.db, config, clock);
    this.checkpointContent = new CheckpointContent(config);
  }
  /** Open the current registry or create it atomically; no prior-build data is converted. */
  private initializeRegistry() {
    const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (version === 5) { this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); return; }
    if (version !== 0 || this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Fault('STORAGE_VERSION', 'Unsupported research storage; use a fresh state directory for this build');
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL,
          registration TEXT NOT NULL CHECK(registration IN ('creating','complete')),
          main_node_id TEXT, main_operation_id TEXT, creation_input TEXT NOT NULL);
        CREATE TABLE operations(id TEXT PRIMARY KEY, project TEXT NOT NULL, node TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
        CREATE TABLE checkpoints(id TEXT PRIMARY KEY, project TEXT NOT NULL, node TEXT NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE registry_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE uploads(id TEXT PRIMARY KEY, project TEXT NOT NULL, node TEXT NOT NULL, payload TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL);`);
      this.db.prepare('INSERT INTO registry_metadata VALUES (?,?)').run('stateRoot',this.config.stateRoot);
      Operations.create(this.db);
      this.db.exec('PRAGMA user_version=5; COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async initialize() {
    const lockPath = join(this.config.stateRoot, 'research.lock');
    const fd = openSync(lockPath, 'a', 0o600);
    try {
      await tryLockExclusive(fd);
      const held = fstatSync(fd), current = statSync(lockPath);
      if (held.ino !== current.ino || held.dev !== current.dev) throw new Fault('STATE_OWNED', 'State lock changed during acquisition');
      this.lock = fd;
    } catch (error) { closeSync(fd); throw new Fault('STATE_OWNED', 'Another MainDaemon owns this state directory'); }
    this.initializeRegistry();
    const registryOrigin=(this.db.prepare("SELECT value FROM registry_metadata WHERE key='stateRoot'").get() as {value:string}).value;
    for (const row of this.db.prepare('SELECT id,name,root,registration FROM projects').all() as (Project & {registration:string})[]) {
      const project: Project = {id:row.id,name:row.name,root:row.root,availability:'unavailable',detail:null};
      const copiedRegistry=registryOrigin!==this.config.stateRoot;
      // Historical authority survives temporary filesystem unavailability and later recovery.
      if (copiedRegistry) this.relocated.add(project.id);
      if(copiedRegistry&&project.root.startsWith(registryOrigin+'/'))project.root=join(this.config.stateRoot,relative(registryOrigin,project.root));
      this.roots.set(project.id,project);
      try {
        if(row.registration === 'creating' && !copiedRegistry) await this.provisionProject(project);
        const metadata = z.object({ id: Id, name: z.string(), root: z.string() }).parse(JSON.parse(await readFile(join(project.root, '.polariton/project.json'), 'utf8')));
        if(metadata.id !== project.id) throw new Fault('PROJECT_BINDING', 'Project identity differs from registry');
        if(copiedRegistry || metadata.root !== project.root || await realpath(project.root) !== project.root) {
          this.relocated.add(project.id); project.availability='historical'; project.detail='Workspace location changed; historical inspection only';
        } else { await this.ownProject(project); project.availability='available'; }
        await this.replay(project.id);
        this.db.prepare("UPDATE projects SET registration='complete' WHERE id=?").run(project.id);
      } catch(error) { project.availability='unavailable'; project.detail=error instanceof Error ? error.message : String(error); this.emit('recovery',{projectId:project.id,error:project.detail}); }
    }
    for(const row of this.db.prepare("SELECT * FROM uploads WHERE state='publishing'").all() as {id:string;project:string;node:string;payload:string}[]) {
      if(this.roots.get(row.project)?.availability !== 'available') continue;
      try { await this.publishUpload(row.project,row.node,UploadPublication.parse(JSON.parse(row.payload))); }
      catch(error) { this.emit('recovery',{operationId:row.id,error:String(error)}); }
    }
    for (const row of this.db.prepare("SELECT * FROM operations WHERE state != 'complete'").all() as Journal[]) {
      if (this.roots.get(row.project)?.availability !== 'available') { this.emit('recovery', { operationId: row.id, error: 'Relocated project is historical only' }); continue; }
      if (row.kind === 'node') {
        const state = this.states.get(row.project);
        if (!state?.graph.recovery) await this.mutate(row.project, Mutation.parse(JSON.parse(row.payload))).catch(error => {
          this.emit('recovery', { operationId: row.id, error: String(error) });
        });
      } else if (row.kind === 'checkpoint') {
        try { await this.checkpointStore.recover(row.project, row.node, this.workspace(row.project,row.node,'write'), row.id, this.publications.signal); }
        catch (error) { this.emit('recovery', { operationId: row.id, error: String(error) }); }
      }
    }
  }
  projects(): Project[] { return [...this.roots.values()].map(value=>({...value})); }
  /** The registry owns the display name. Workspace identity and original creation
   * receipts remain unchanged, so an earlier creation retry remains valid. */
  renameProject(id: string, name: string): Project {
    const project=this.roots.get(id);
    if(!project)throw new Fault('PROJECT_NOT_FOUND','Project does not exist',404);
    const title=Text.parse(name);
    this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(title,id);
    project.name=title;
    this.emit('change');
    return {...project};
  }
  /** Registers an explicit, empty host directory. A durable intent precedes filesystem publication. */
  async createProject(id: string, name: string, location?: string): Promise<Project> {
    return this.serial('registry',async()=>{
    Id.parse(id);
    if(location && !isAbsolute(location)) throw new Fault('PROJECT_PATH','Project directory must be absolute',400);
    const root = location ? resolve(location) : join(this.config.stateRoot,'projects',id);
    const input = JSON.stringify({name,root});
    const prior = this.db.prepare('SELECT creation_input FROM projects WHERE id=?').get(id) as {creation_input:string|null}|undefined;
    if (prior) {
      if (prior.creation_input !== input) throw new Fault('PROJECT_CONFLICT', 'Project identity was already used with different input');
      await this.recoverProject(id);
      return {...this.roots.get(id)!};
    }
    for(let ancestor=root;;ancestor=dirname(ancestor)) {
      try {if(await realpath(ancestor)!==ancestor)throw new Fault('PROJECT_PATH','Choose a canonical path without symlink components');break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    for(const value of this.roots.values()) {
      if(root===value.root || root.startsWith(value.root+'/') || value.root.startsWith(root+'/')) throw new Fault('PROJECT_OVERLAP','Project directories must not overlap');
    }
    // Interrupted pre-rename provisioning can leave only its metadata directory.
    // Reject that ownership marker without adopting or altering the old project.
    try { if((await readdir(root)).some(name=>name==='.polariton'||name==='.labra'||name==='nodes')) throw new Fault('PROJECT_COLLISION','Selected directory already contains project metadata or nodes; choose an unowned location'); }
    catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const project: Project = {id,name,root,availability:'unavailable',detail:'Project creation is pending'};
    this.db.prepare('INSERT INTO projects(id,name,root,registration,creation_input) VALUES (?,?,?,?,?)').run(id,name,root,'creating',input);
    this.roots.set(id,project);
    try { await this.provisionProject(project); await this.ownProject(project); await this.replay(id); this.db.prepare("UPDATE projects SET registration='complete' WHERE id=?").run(id); project.availability='available'; project.detail=null; }
    catch(error) { project.detail=String(error); this.emit('recovery',{projectId:id,error:project.detail}); throw error; }
    this.emit('change'); return {...project};
    });
  }

  /** Retry an unavailable original project without adopting relocated or conflicting files. */
  async recoverProject(id: string): Promise<void> {
    const project = this.roots.get(id);
    if (!project) throw new Fault('PROJECT_NOT_FOUND', 'Project does not exist', 404);
    if (this.relocated.has(id) || project.availability === 'historical') throw new Fault('WORKSPACE_RELOCATED', 'Copied projects are historical only');
    if (project.availability === 'available') return;
    const row = this.db.prepare('SELECT registration FROM projects WHERE id=?').get(id) as {registration:string};
    try {
      if (row.registration === 'creating') await this.provisionProject(project);
      const metadata = z.object({id:Id,root:z.string()}).parse(JSON.parse(await readFile(join(project.root,'.polariton/project.json'),'utf8')));
      if (metadata.id !== id || metadata.root !== project.root || await realpath(project.root) !== project.root) throw new Fault('PROJECT_BINDING','Original project ownership could not be established');
      if (!this.projectLocks.has(id)) await this.ownProject(project);
      await this.replay(id);
      this.db.prepare("UPDATE projects SET registration='complete' WHERE id=?").run(id);
      project.availability='available';project.detail=null;
    } catch(error) {project.detail=String(error);this.emit('recovery',{projectId:id,error:project.detail});throw error;}
  }

  /** The main designation survives title changes, archival and interrupted node publication. */
  mainNode(project: string): string | null {
    const row = this.db.prepare('SELECT main_node_id FROM projects WHERE id=?').get(project) as {main_node_id:string|null}|undefined;
    return row?.main_node_id ?? null;
  }

  /** Persist the intended identity before provisioning through the ordinary graph boundary. */
  async ensureMain(project: string): Promise<string> {
    await this.recoverProject(project);
    this.writable(project);
    return this.serial(project, async () => {
    const graph = this.graph(project);
    if (graph.recovery) throw new Fault('RECOVERY_REQUIRED',graph.recovery);
    let row = this.db.prepare('SELECT main_node_id,main_operation_id FROM projects WHERE id=?').get(project) as {main_node_id:string|null;main_operation_id:string|null};
    if (!row.main_node_id) {
      this.db.prepare('UPDATE projects SET main_node_id=?,main_operation_id=? WHERE id=? AND main_node_id IS NULL').run(randomUUID(),randomUUID(),project);
      row = this.db.prepare('SELECT main_node_id,main_operation_id FROM projects WHERE id=?').get(project) as typeof row;
    }
    if (!graph.nodes.some(node=>node.id===row.main_node_id)) {
      const saved = this.db.prepare('SELECT payload FROM operations WHERE id=?').get(row.main_operation_id!) as {payload:string}|undefined;
      const mutation = saved ? Mutation.parse(JSON.parse(saved.payload)) : {operationId:row.main_operation_id!,revision:graph.revision,command:{kind:'node.create' as const,id:row.main_node_id!,title:'main',description:'Initial project workspace'}};
      if (mutation.command.kind !== 'node.create' || mutation.command.id !== row.main_node_id) throw new Fault('MAIN_BINDING','Main node provisioning intent conflicts with its designation');
      // An unpublished intent can advance its precondition; the command and identities stay fixed.
      if (saved && mutation.revision !== graph.revision) {
        mutation.revision = graph.revision;
        this.db.prepare('UPDATE operations SET payload=? WHERE id=? AND state != ?').run(JSON.stringify(mutation),row.main_operation_id!,'complete');
      }
      await this.appendMutation(project,mutation);
    }
    // A retained graph identity never authorizes replacing a lost or redirected repository.
    const workspace = this.workspace(project,row.main_node_id!);
    try {
      if (await realpath(workspace) !== workspace || !(await lstat(join(workspace,'.git'))).isDirectory()) throw new Error('Independent repository is missing or redirected');
      if ((await this.git(workspace,['rev-parse','--show-toplevel'])).trim() !== workspace) throw new Error('Repository belongs to another workspace');
      await this.git(workspace,['rev-parse','--verify','HEAD']);
    } catch (error) { throw new Fault('MAIN_WORKSPACE_UNAVAILABLE', `Designated main workspace requires recovery: ${error instanceof Error ? error.message : String(error)}`); }
    return row.main_node_id!;
    });
  }
  private async provisionProject(project: Project) {
    await mkdir(project.root,{recursive:true});
    if(await realpath(project.root)!==project.root) throw new Fault('PROJECT_PATH','Choose a canonical directory without symlink components');
    const metadataDir=join(project.root,'.polariton'), metadataPath=join(metadataDir,'project.json');
    await mkdir(metadataDir,{recursive:true});
    const encoded=JSON.stringify({id:project.id,name:project.name,root:project.root});
    try { const file=await open(metadataPath,'wx',0o600); try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); } }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST' || await readFile(metadataPath,'utf8')!==encoded) throw new Fault('PROJECT_BINDING','Existing project metadata conflicts with pending creation'); }
    await mkdir(join(project.root,'nodes'),{recursive:true});
    for(const dir of [metadataDir,project.root,dirname(project.root)]) await this.syncDirectory(dir);
  }
  private async ownProject(project: Project) {
    const path=join(project.root,'.polariton/owner.lock'), fd=openSync(path,'a',0o600);
    try { await tryLockExclusive(fd); const held=fstatSync(fd),current=statSync(path); if(held.ino!==current.ino||held.dev!==current.dev) throw new Error('Project lock changed'); this.projectLocks.set(project.id,fd); }
    catch { closeSync(fd); throw new Fault('PROJECT_OWNED','Another MainDaemon owns this project'); }
  }
  private writable(project: string) {
    const value=this.roots.get(project);
    if(!value) throw new Fault('PROJECT_NOT_FOUND','Project does not exist',404);
    if(value.availability==='historical') throw new Fault('WORKSPACE_RELOCATED','This copied project is historical only');
    if(value.availability!=='available') throw new Fault('PROJECT_UNAVAILABLE',value.detail??'Project directory is unavailable');
  }
  private path(project: string, node?: string) { const root=this.roots.get(project)?.root; if(!root) throw new Fault('PROJECT_NOT_FOUND','Project does not exist',404); return node ? join(root,'nodes',node) : root; }
  private state(project: string) {
    const state = this.states.get(project); if (!state) throw new Fault('PROJECT_NOT_FOUND', 'Project does not exist', 404); return state;
  }
  /** Retained project metadata remains readable independently of graph/workspace availability. */
  projectInfo(id:string):Project {const value=this.roots.get(id);if(!value)throw new Fault('PROJECT_NOT_FOUND','Project does not exist',404);return {...value};}
  graph(project: string): Graph { return structuredClone(this.state(project).graph); }
  /** Public retained graph edits use logical sequence cursors, never physical log offsets. */
  history(project:string,after=0,limit=this.config.cliPageSize){
    const state=this.state(project);
    if(!Number.isSafeInteger(after)||after<0||after>state.graph.revision||!Number.isSafeInteger(limit)||limit<1||limit>this.config.cliPageSize)throw new Fault('INVALID_CURSOR','Use a valid graph sequence and configured page limit',400);
    const entries=[...state.receipts.values()].slice(after,after+limit).map(encoded=>{const mutation=Mutation.parse(JSON.parse(encoded));return {...mutation,seq:mutation.revision+1};});
    const end=entries.at(-1)?.seq??after;
    return {entries,revision:state.graph.revision,next:end<state.graph.revision?end:null,recovery:state.graph.recovery};
  }
  /** Resolve identity from authority; names, working directories and directory nesting are not identifiers. */
  resolveNode(id:string,project?:string){
    const matches=this.projects().filter(value=>!project||value.id===project).flatMap(value=>{const state=this.states.get(value.id);return state?.graph.nodes.filter(node=>node.id===id).map(node=>({projectId:value.id,node,...{workspace:this.path(value.id,node.id)}}))??[];});
    if(matches.length!==1)throw new Fault(matches.length?'AMBIGUOUS_TARGET':'NODE_NOT_FOUND','Supply an existing unambiguous node ID and project scope',404);
    return matches[0]!;
  }
  private requests(){return this.requestJournal??=new Operations(this.db,'main:research',this.config.cliMaxRecords);}
  private requestJournal?:Operations;
  operation(id:string){return this.requests().get(id);}
  /** Research mutations already journal stable graph/Git identities; replay recovers those exact effects. */
  executeRequest(id:string,actor:Actor,command:string,input:unknown,effect:()=>Promise<unknown>){
    return this.requests().run(id,actor,command,input,true,async()=>{
      if(command.startsWith('node.')||command.startsWith('relation.')){
        const {project}=z.object({project:Id}).parse(input);
        // The graph journal is already authoritative after append, even if the request acknowledgement was lost.
        if(this.state(project).receipts.has(id))return this.graph(project);
      }
      return effect();
    });
  }
  workspace(project: string, node: string, access: 'read' | 'write' = 'read'): string {
    if (!this.state(project).graph.nodes.some(value => value.id === node)) throw new Fault('NODE_NOT_FOUND', 'Node does not belong to project', 404);
    if (access === 'write') {
      this.writable(project);
      if (this.relocated.has(project)) throw new Fault('WORKSPACE_RELOCATED', 'This copied project is historical only; restore its original workspace location before resuming');
    }
    return this.path(project, node);
  }
  private serial<T>(project: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(project) ?? Promise.resolve()).then(task, task);
    this.tails.set(project, result.then(() => {}, () => {})); return result;
  }
  private apply(graph: Graph, mutation: Mutation) {
    const c = mutation.command;
    const node = graph.nodes.find(n => n.id === c.id), edge = graph.edges.find(e => e.id === c.id);
    if (c.kind === 'node.create') {
      if (node) throw new Fault('DUPLICATE_NODE', 'Node already exists');
      graph.nodes.push({ id: c.id, title: c.title, description: c.description, source: c.source, archived: false });
    } else if (c.kind === 'edge.create') {
      if (edge || !graph.nodes.some(n => n.id === c.from) || !graph.nodes.some(n => n.id === c.to)) throw new Fault('INVALID_EDGE', 'Edge already exists or an endpoint is missing');
      graph.edges.push({ id: c.id, from: c.from, to: c.to, relation: c.relation, explanation: c.explanation, retracted: false });
    } else if (c.kind === 'node.edit' || c.kind === 'node.archive') {
      if (!node) throw new Fault('NODE_NOT_FOUND', 'Node does not exist', 404);
      if (c.kind === 'node.edit') { node.title = c.title; node.description = c.description; } else node.archived = c.archived;
    } else {
      if (!edge) throw new Fault('EDGE_NOT_FOUND', 'Edge does not exist', 404);
      if (c.kind === 'edge.retract') edge.retracted = true;
      else { edge.relation = c.relation; edge.explanation = c.explanation; }
    }
    graph.revision++;
  }
  private async replay(project: string) {
    const state: State = { graph: { revision: 0, nodes: [], edges: [], recovery: null }, receipts: new Map() };
    const path = join(this.path(project), '.polariton/graph.jsonl');
    let bytes: Buffer;
    try { if ((await stat(path)).size > this.config.maxGraphBytes) throw new Fault('GRAPH_LIMIT', 'Graph exceeds configured read budget'); bytes = await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
    const text = bytes.toString('utf8');
    const rows = text.split('\n');
    if (rows.pop() !== '') state.graph.recovery = 'Incomplete graph suffix: explicit repair required';
    try {
      for (const line of rows) {
        const record = RecordSchema.parse(JSON.parse(line));
        const body = { version: record.version, seq: record.seq, mutation: record.mutation };
        if (digest(JSON.stringify(body)) !== record.checksum || record.seq !== state.graph.revision + 1 || record.mutation.revision !== state.graph.revision || state.receipts.has(record.mutation.operationId)) throw new Error('Invalid graph order or checksum');
        this.apply(state.graph, record.mutation);
        state.receipts.set(record.mutation.operationId, JSON.stringify(record.mutation));
      }
    } catch (error) { state.graph.recovery = `Graph corruption or incompatible record: ${String(error)}`; }
    this.states.set(project, state);
  }
  async repair(project: string) {
    this.writable(project);
    if (this.relocated.has(project)) throw new Fault('WORKSPACE_RELOCATED', 'This copied project is historical only');
    return this.serial(project, async () => {
      const current = this.state(project);
      if (!current.graph.recovery) return this.graph(project);
      if (!current.graph.recovery.startsWith('Incomplete')) throw new Fault('GRAPH_CORRUPT', 'Interior corruption requires restoring a verified backup');
      const path = join(this.path(project), '.polariton/graph.jsonl');
      const bytes = await readFile(path); const cut = bytes.lastIndexOf(10) + 1;
      const backup = `${path}.damaged-${randomUUID()}`;
      const copy = await open(backup, 'wx', 0o600); try { await copy.writeFile(bytes); await copy.sync(); } finally { await copy.close(); }
      await this.syncDirectory(dirname(path));
      const file = await open(path, 'r+'); try { await file.truncate(cut); await file.sync(); } finally { await file.close(); }
      await this.syncDirectory(dirname(path)); await this.replay(project); this.emit('change'); return this.graph(project);
    });
  }
  async mutate(project: string, raw: Mutation): Promise<Graph> {
    this.writable(project);
    if (this.relocated.has(project)) throw new Fault('WORKSPACE_RELOCATED', 'This copied project is historical only');
    const mutation = Mutation.parse(raw);
    return this.serial(project, () => this.appendMutation(project, mutation));
  }

  /** Publish one validated mutation while holding the project serialization boundary. */
  private async appendMutation(project: string, mutation: Mutation): Promise<Graph> {
      const state = this.state(project), encoded = JSON.stringify(mutation);
      const receipt = state.receipts.get(mutation.operationId);
      if (receipt) { if (receipt !== encoded) throw new Fault('OPERATION_CONFLICT', 'Operation identity was reused with different content'); return this.graph(project); }
      if (state.graph.recovery) throw new Fault('RECOVERY_REQUIRED', state.graph.recovery);
      if (mutation.revision !== state.graph.revision) throw new Fault('REVISION_CONFLICT', `Graph revision conflict: expected ${mutation.revision}, current ${state.graph.revision}; refresh the graph before editing`);
      const next = structuredClone(state.graph); this.apply(next, mutation);
      if (mutation.command.kind === 'node.create') {
        const c = mutation.command;
        const prior = this.db.prepare('SELECT project,payload FROM operations WHERE id=?').get(mutation.operationId) as { project: string; payload: string } | undefined;
        if (prior && (prior.project !== project || prior.payload !== encoded)) throw new Fault('OPERATION_CONFLICT', 'Provisioning operation has different content');
        this.db.prepare('INSERT OR IGNORE INTO operations VALUES (?,?,?,?,?,?)').run(mutation.operationId, project, c.id, 'node', encoded, 'pending');
        const workspace = this.path(project, c.id);
        await mkdir(workspace, { recursive: true });
        if (c.source) {
          const checkpoint = this.checkpoints(project, c.source.nodeId).find(value => value.id === c.source!.checkpointId);
          if (!checkpoint) throw new Fault('CHECKPOINT_NOT_FOUND', 'Select an existing published checkpoint');
          await this.checkpointContent.initializeFromCheckpoint(this.workspace(project,c.source.nodeId),checkpoint.commit,workspace,this.publications.signal);
        } else {
          await this.git(workspace, ['init', '--quiet']);
          let initialized = false;
          try { await this.git(workspace, ['rev-parse', '--verify', 'HEAD']); initialized = true; }
          catch { /* An interrupted initial publication can be completed from its files. */ }
          if (!initialized) {
            await this.git(workspace, ['add', '--all']);
            await this.git(workspace, ['-c', 'user.name=Polariton', '-c', 'user.email=polariton@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Initialize independent research workspace']);
          }
        }
        await this.syncDirectory(workspace); await this.syncDirectory(dirname(workspace));
      }
      const path = join(this.path(project), '.polariton/graph.jsonl');
      const body = { version: 1, seq: next.revision, mutation };
      const line = JSON.stringify({ ...body, checksum: digest(JSON.stringify(body)) }) + '\n';
      const file = await open(path, 'a', 0o600);
      try {
        if ((await file.stat()).size + Buffer.byteLength(line) > this.config.maxGraphBytes) throw new Fault('GRAPH_LIMIT', 'Graph write exceeds configured budget');
        await file.writeFile(line); await file.sync();
      } catch (error) { state.graph.recovery = 'Graph append failed: reopen and inspect recovery state'; throw error; }
      finally { await file.close(); }
      await this.syncDirectory(dirname(path));
      state.graph = next; state.receipts.set(mutation.operationId, encoded);
      this.db.prepare("UPDATE operations SET state='complete' WHERE id=?").run(mutation.operationId);
      this.emit('change'); return this.graph(project);
  }
  private contained(root: string, path: string) {
    const target = resolve(root, path), rel = relative(root, target);
    if (!rel || isAbsolute(path) || (rel === '..' || rel.startsWith('../')) || rel.split(/[\\/]/).some(part => part === '.git' || part === '.polariton')) throw new Fault('FILE_DENIED', 'File path is outside admitted workspace', 403);
    return target;
  }
  /** Admits read-only observation, including temporarily missing paths, without following links. */
  async observationPath(project: string, node: string, path = ''): Promise<string> {
    const root = this.workspace(project, node);
    if (await realpath(root) !== root) throw new Fault('FILE_DENIED', 'Workspace binding is no longer canonical', 403);
    const target = path ? this.contained(root, path) : root;
    let current = target;
    for (;;) {
      try {
        if (await realpath(current) !== current) throw new Fault('FILE_DENIED', 'Symlink observation is not admitted', 403);
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === root) throw error;
        // lstat distinguishes a dangling symlink from an ordinary missing entry.
        try { if ((await lstat(current)).isSymbolicLink()) throw new Fault('FILE_DENIED', 'Symlink observation is not admitted', 403); }
        catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError; }
        current = dirname(current);
      }
    }
  }
  async files(project: string, node: string, signal?: AbortSignal): Promise<string[]> {
    const root = this.workspace(project, node), result: string[] = []; let bytes = 0;
    const walk = async (dir: string) => {
      signal?.throwIfAborted();
      if (await realpath(dir) !== dir) throw new Fault('UNSUPPORTED_FILE', 'Symlink directories are not admitted');
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (entry.name === '.git' || entry.name === '.polariton') continue;
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Fault('UNSUPPORTED_FILE', 'Workspace upload inventory contains a symlink or special file');
        if (entry.isDirectory()) await walk(path);
        else {
          bytes += (await stat(path)).size; result.push(relative(root, path));
          if (bytes > this.config.maxWorkspaceBytes || result.length > this.config.maxWorkspaceFiles) throw new Fault('WORKSPACE_LIMIT', 'Workspace exceeds configured upload budget');
        }
      }
    };
    await walk(root); return result.sort();
  }
  async file(project: string, node: string, path: string): Promise<Buffer> {
    return (await this.readWorkspaceFile(project, node, path)).bytes;
  }
  /** Binds bounded preview bytes and change evidence to the same open file. */
  private async readWorkspaceFile(project: string, node: string, path: string, signal?: AbortSignal): Promise<{bytes:Buffer;version:string}> {
    try {
      signal?.throwIfAborted();
      const root = await this.observationPath(project, node), target = this.contained(root, path);
      const actual = await realpath(target);
      if (actual !== target || !actual.startsWith(root + '/')) throw new Fault('FILE_DENIED', 'Symlink file access is not admitted', 403);
      const expected = await lstat(target, { bigint: true });
      if (!expected.isFile()) throw new Fault('UNSUPPORTED_FILE', 'Only regular workspace files can be read');
      // A concurrent replacement with a FIFO must not leave capture blocked in open().
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (await realpath(target) !== target) throw new Fault('FILE_DENIED', 'File binding changed during read', 403);
        const info = await file.stat({ bigint: true }), current = await lstat(target, { bigint: true });
        if(info.ino!==expected.ino||info.dev!==expected.dev||info.ino!==current.ino||info.dev!==current.dev) throw new Fault('FILE_CHANGED','File binding changed during read',409);
        if (!info.isFile() || info.size > this.config.maxFileBytes) throw new Fault('FILE_LIMIT', 'File exceeds preview budget');
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of file.createReadStream({autoClose:false, signal})) {
          size+=chunk.length;if(size>this.config.maxFileBytes)throw new Fault('FILE_LIMIT','File grew beyond preview budget');chunks.push(Buffer.from(chunk));
        }
        const after = await file.stat({ bigint: true }), binding = await lstat(target, { bigint: true });
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs || after.mode !== info.mode || binding.ino !== info.ino || binding.dev !== info.dev)
          throw new Fault('FILE_CHANGED', 'File changed during read; retry its preview', 409);
        signal?.throwIfAborted();
        return { bytes: Buffer.concat(chunks),
          version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}` };
      }
      finally { await file.close(); }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Fault('FILE_NOT_FOUND', 'File is no longer available in the workspace', 404);
      throw error;
    }
  }
  /** Lists one directory without traversing links or reading file contents. */
  async directory(project: string, node: string, path = ''): Promise<WorkspaceEntry[]> {
    try {
      const root=await this.observationPath(project,node), target=path ? this.contained(root,path) : root;
      if(await realpath(target)!==target) throw new Fault('FILE_DENIED','Symlink directories are not admitted',403);
      const entries=await readdir(target,{withFileTypes:true});
      if(entries.length>this.config.maxDirectoryEntries) throw new Fault('DIRECTORY_LIMIT','Directory exceeds configured browsing limit');
      const result: WorkspaceEntry[]=[];
      for(const entry of entries) {
        if(entry.name==='.git'||entry.name==='.polariton'||(!entry.isFile()&&!entry.isDirectory())) continue;
        const name=join(target,entry.name);
        try {
          const info = await lstat(name);
          if (!info.isFile() && !info.isDirectory()) continue;
          result.push({name:entry.name,path:relative(root,name),kind:info.isDirectory()?'directory':'file',bytes:info.isFile()?info.size:null});
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return result.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name,undefined,{numeric:true}));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Fault('DIRECTORY_NOT_FOUND', 'Directory is no longer available in the workspace', 404);
      throw error;
    }
  }
  /** Each page belongs to the hash of the complete bounded file, preventing mixed-version previews. */
  async readPage(project: string,node: string,path: string,offset=0,version?:string,length=Math.min(this.config.filePageBytes,this.config.maxFileBytes)): Promise<FilePage> {
    if (!Number.isSafeInteger(length) || length < 1 || length > this.config.maxFileBytes) throw new Fault('FILE_LENGTH', 'Preview length exceeds configured file budget', 400);
    const bytes=await this.file(project,node,path), actual=digest(bytes);
    if(version && version!==actual) throw new Fault('FILE_CHANGED','File changed; reopen its preview');
    if(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length) throw new Fault('FILE_OFFSET','Invalid file offset',400);
    let end=Math.min(bytes.length,offset+length);
    // Avoid splitting a UTF-8 code point between pages; offsets are byte positions.
    while(end<bytes.length && (bytes[end]!&0xc0)===0x80) end++;
    return {path,version:actual,bytes:bytes.length,offset,next:end<bytes.length?end:null,text:bytes.subarray(offset,end).toString('utf8')};
  }
  /** Retains complete, bounded bytes independently of workspace publication and checkpoint capture. */
  async stageUpload(project:string,node:string,raw:UploadPublication,bytes:Buffer):Promise<UploadReceipt> {
    const input=UploadPublication.parse(raw); this.workspace(project,node); this.writable(project);
    this.contained(this.workspace(project,node),input.path);
    if(bytes.length>this.config.maxFileBytes) throw new Fault('FILE_LIMIT','Upload exceeds configured file limit',413);
    if(digest(bytes)!==input.digest) throw new Fault('UPLOAD_DIGEST','Uploaded bytes do not match their digest',400);
    return this.serial(project,async()=>{
      const payload=JSON.stringify(input), existing=this.db.prepare('SELECT * FROM uploads WHERE id=?').get(input.operationId) as {project:string;node:string;payload:string;state:string;bytes:number}|undefined;
      if(existing) {
        if(existing.project!==project||existing.node!==node||existing.payload!==payload||existing.bytes!==bytes.length) throw new Fault('OPERATION_CONFLICT','Upload identity was reused with different content');
        if(existing.state!=='receiving') return {operationId:input.operationId,path:input.path,version:input.digest,bytes:bytes.length,state:existing.state==='published'?'published':'staged'};
      }
      const staged=this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM uploads WHERE id!=?").get(input.operationId) as {bytes:number};
      if(staged.bytes+bytes.length>this.config.maxStagedBytes) throw new Fault('STAGING_LIMIT','Retained uploads exceed configured staging limit');
      this.db.prepare('INSERT OR IGNORE INTO uploads VALUES (?,?,?,?,?,?)').run(input.operationId,project,node,payload,bytes.length,'receiving');
      const dir=join(this.config.stateRoot,'uploads'); await mkdir(dir,{recursive:true,mode:0o700});
      const target=join(dir,input.operationId), temporary=target+'.receiving';
      const file=await open(temporary,'w',0o600);try {await file.writeFile(bytes);await file.sync();}finally {await file.close();}
      await rename(temporary,target);await this.syncDirectory(dir);
      this.db.prepare("UPDATE uploads SET state='staged' WHERE id=?").run(input.operationId);
      return {operationId:input.operationId,path:input.path,version:input.digest,bytes:bytes.length,state:'staged'};
    });
  }
  /** Publishes an admitted upload once. Checkpoint exclusion spans all file-system changes and receipt durability. */
  async publishUpload(project:string,node:string,raw:UploadPublication):Promise<UploadReceipt> {
    const input=UploadPublication.parse(raw); this.writable(project);
    const root=this.workspace(project,node), key=`${project}/${node}`;
    if(this.publishing.has(key)) throw new Fault('CHECKPOINT_BUSY','Workspace publication is in progress');
    this.publishing.add(key);
    try { return await this.serial(project,async()=>{
      const row=this.db.prepare('SELECT * FROM uploads WHERE id=?').get(input.operationId) as {project:string;node:string;payload:string;state:string;bytes:number}|undefined;
      if(!row || row.project!==project || row.node!==node) throw new Fault('UPLOAD_NOT_FOUND','No upload is staged for this node',404);
      if(row.payload!==JSON.stringify(input)) throw new Fault('OPERATION_CONFLICT','Upload publication differs from its staged operation');
      const receipt: UploadReceipt={operationId:input.operationId,path:input.path,version:input.digest,bytes:row.bytes,state:'published'};
      if(row.state==='published') return receipt;
      if(row.state==='receiving') throw new Fault('UPLOAD_INCOMPLETE','Upload bytes were not completely staged');
      const target=this.contained(root,input.path), parent=dirname(target);
      for(const part of relative(root,parent).split('/').filter(Boolean).reduce<string[]>((paths,part)=>[...paths,join(paths.at(-1)??root,part)],[])) {
        try {const info=await lstat(part);if(!info.isDirectory()||info.isSymbolicLink())throw new Fault('FILE_DENIED','Symlink publication is not admitted',403);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(part);await this.syncDirectory(dirname(part));}
      }
      if(await realpath(parent)!==parent) throw new Fault('FILE_DENIED','Symlink publication is not admitted',403);
      let current:string|undefined;
      try { current=digest(await this.file(project,node,input.path)); } catch(error) {if(!(error instanceof Fault && error.code==='FILE_NOT_FOUND')) throw error;}
      if(row.state==='publishing'&&current===input.digest) {
        await this.syncDirectory(parent); this.db.prepare("UPDATE uploads SET state='published' WHERE id=?").run(input.operationId);return receipt;
      }
      if(input.expectedVersion ? current!==input.expectedVersion : current!==undefined) throw new Fault('FILE_CONFLICT','File exists or changed; choose Rename or Replace with its current version');
      const existingFiles=await this.files(project,node);let workspaceBytes=0;
      for(const path of existingFiles)workspaceBytes+=(await stat(this.contained(root,path))).size;
      const previousBytes=current===undefined?0:(await stat(target)).size;
      if(workspaceBytes-previousBytes+row.bytes>this.config.maxWorkspaceBytes||existingFiles.length+(current===undefined?1:0)>this.config.maxWorkspaceFiles)throw new Fault('WORKSPACE_LIMIT','Upload exceeds configured workspace quota');
      const bytes=await readFile(join(this.config.stateRoot,'uploads',input.operationId));
      if(digest(bytes)!==input.digest||bytes.length!==row.bytes) throw new Fault('UPLOAD_CORRUPT','Staged bytes do not match the retained receipt');
      const stagingDir=join(this.path(project),'.polariton/uploads');await mkdir(stagingDir,{recursive:true,mode:0o700});
      const publication=join(stagingDir,input.operationId), file=await open(publication,'w',0o600);
      try {await file.writeFile(bytes);await file.sync();}finally{await file.close();}
      await this.syncDirectory(stagingDir);
      this.db.prepare("UPDATE uploads SET state='publishing' WHERE id=?").run(input.operationId);
      if(await realpath(parent)!==parent) throw new Fault('FILE_DENIED','Directory binding changed',403);
      if(input.expectedVersion) {
        if(digest(await this.file(project,node,input.path))!==input.expectedVersion) throw new Fault('FILE_CONFLICT','File changed before replacement');
        await rename(publication,target);
      } else {
        try {await link(publication,target);} catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST') throw new Fault('FILE_CONFLICT','File appeared before publication');throw error;}
        await unlink(publication);
      }
      await this.syncDirectory(parent);await this.syncDirectory(stagingDir);
      this.db.prepare("UPDATE uploads SET state='published' WHERE id=?").run(input.operationId);
      this.emit('change');return receipt;
    }); } finally {this.publishing.delete(key);}
  }
  checkpoints(project: string, node: string): Checkpoint[] {
    this.workspace(project, node);
    return (this.db.prepare('SELECT data FROM checkpoints WHERE project=? AND node=? ORDER BY created DESC,id').all(project, node) as {data:string}[])
      .map(row => Checkpoint.parse(JSON.parse(row.data)));
  }
  /** Publishes shared Git progress and retains its exact identity. Per-node
   * exclusion covers uploads and checkpoints while worker execution continues. */
  checkpoint(project: string, node: string, id: string, raw: CheckpointPublication): Promise<Checkpoint> {
    const operation = (async () => {
      Id.parse(id);
      const publication = CheckpointPublication.parse(raw);
      const workspace = this.workspace(project,node,'write');
      if (this.publications.signal.aborted) throw new Fault('CHECKPOINT_CANCELLED','Research storage is closing.',409);
      const key = `${project}/${node}`;
      if (this.publishing.has(key)) throw new Fault('CHECKPOINT_BUSY','Another workspace publication is in progress; retry this request.',409);
      this.publishing.add(key);
      try {
        const checkpoint = await this.checkpointStore.publish(project,node,workspace,id,publication,this.publications.signal);
        this.emit('change');
        return checkpoint;
      } finally { this.publishing.delete(key); }
    })();
    this.pendingPublications.add(operation);
    return operation.finally(() => this.pendingPublications.delete(operation));
  }
  private async syncDirectory(path: string) { const dir = await open(path, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  private async git(path: string, args: string[], signal?: AbortSignal) { return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', '-C', path, ...args], { env: gitEnv(), signal, timeout: this.config.requestTimeoutMs, maxBuffer: this.config.maxWorkspaceBytes })).stdout; }
  /** Stop accepting publications before transports drain their active requests. */
  stopPublications(): void { this.publications.abort(); }

  /** Cancel owned Git work and drain its processes before releasing storage locks. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopPublications();
      await Promise.allSettled([...this.pendingPublications, ...this.tails.values()]);
      for (const fd of this.projectLocks.values()) closeSync(fd);
      this.projectLocks.clear(); this.db.close();
      if (this.lock !== null) { closeSync(this.lock); this.lock = null; }
    })();
  }
}
