import {workerOverview} from '../worker-overview.ts';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import type {ResearchTree} from '../research.ts';
import type {AgentManager} from '../agents.ts';
import type {EnvironmentClient} from '../environment/daemon.ts';
import {Fault,type ProjectView,type PromptPart} from '../contracts.ts';
import type {Actor} from '../operations.ts';
import type {Config} from '../config.ts';
import {type Request,environmentCommand,isMutation} from './contracts.ts';

import {identity} from './identity.ts';
import type {CanvasBridge} from '../canvas.ts';
import type {CanvasSnapshots} from '../canvas-snapshots.ts';
import {CanvasSnapshot} from '../canvas-contracts.ts';

/** Composes recoverable default provisioning. Transports do not own project initialization state. */
export class Projects {
 private tree:ResearchTree;private agents:AgentManager;
 private states=new Map<string,ProjectView['initialization']>();private pending=new Map<string,Promise<void>>();
 constructor(tree:ResearchTree,agents:AgentManager){this.tree=tree;this.agents=agents;}
 async initialize(id:string){
  const existing=this.pending.get(id);if(existing)return existing;
  this.states.set(id,{state:'pending',detail:null});
  const task=(async()=>{try{const node=await this.tree.ensureMain(id);this.agents.ensureInitialWorker(id,node);this.states.set(id,{state:'ready',detail:null});}catch(error){const detail=error instanceof Error?error.message:'Project initialization failed';this.states.set(id,{state:'blocked',detail});this.tree.emit('recovery',{projectId:id,error:detail});}finally{this.pending.delete(id);this.tree.emit('change');}})();
  this.pending.set(id,task);return task;
 }
 list():ProjectView[]{return this.tree.projects().map(project=>({...project,mainNodeId:this.tree.mainNode(project.id),initialWorkerId:this.agents.initialWorkerId(project.id),initialization:this.states.get(project.id)??{state:'pending',detail:null}}));}
 get(id:string){const project=this.tree.projectInfo(id);return {...project,mainNodeId:this.tree.mainNode(id),initialWorkerId:this.agents.initialWorkerId(id),initialization:this.states.get(id)??{state:'pending' as const,detail:null}};}
 async create(id:string,name:string,root?:string){await this.tree.createProject(id,name,root);await this.initialize(id);const result=this.get(id);if(result.initialization.state!=='ready')throw new Fault('PROJECT_BLOCKED',result.initialization.detail??'Project initialization requires recovery');return result;}
}

/** Application operations resolve identity and compose owners. Canvas requests route to their browser presentation owner. */
export class MainOperations {
 private config:Config;private tree:ResearchTree;private agents:AgentManager;private projects:Projects;private environment:EnvironmentClient;
 private canvas:CanvasBridge;
 private snapshots:CanvasSnapshots;
 constructor(config:Config,tree:ResearchTree,agents:AgentManager,projects:Projects,environment:EnvironmentClient,canvas:CanvasBridge,snapshots:CanvasSnapshots){this.config=config;this.tree=tree;this.agents=agents;this.projects=projects;this.environment=environment;this.canvas=canvas;this.snapshots=snapshots;}
 private page<T>(items:T[],after:number,limit=this.config.cliPageSize){if(limit>this.config.cliPageSize||after>items.length)throw new Fault('INVALID_CURSOR','Page exceeds configured bounds',400);return {items:items.slice(after,after+limit),next:after+limit<items.length?after+limit:null};}
 async execute(request:Request,actor:Actor,signal?:AbortSignal):Promise<unknown>{
  const c=request.command,i=c.input,id=request.requestId!;
  if(c.kind==='canvas.get'||c.kind==='canvas.move'||c.kind==='canvas.snapshot'||c.kind==='canvas.finish'){
   this.projects.get(c.input.project);
   if(actor.kind==='worker'&&this.agents.get(actor.id).projectId!==c.input.project)throw new Fault('GRANT_DENIED','Workers may operate canvas presentation only in their own project',403);
   const identity=`${actor.kind}:${actor.id}`,scope={actor:identity,project:c.input.project};
   if(c.kind==='canvas.finish')return this.snapshots.finish(scope);
   const render=(signal?:AbortSignal)=>this.canvas.execute(c,this.tree.graph(c.input.project),this.agents.activity(c.input.project),identity,request.requestId,signal);
   if(c.kind==='canvas.snapshot')return this.snapshots.capture(scope,async signal=>CanvasSnapshot.parse(await render(signal)),signal);
   return render(signal);
  }
  if(environmentCommand(c.kind))return this.environment.callAs('/v1/cli',{request,actor});
  if(c.kind==='operation.get'){
   const [owner,scope,requestId]=c.input.target.split(':');
   if(owner==='environment')return this.environment.callAs('/v1/cli',{request,actor});
   if(owner!=='main')throw new Fault('OPERATION_OWNER','Use lifecycle control for daemon receipts',400);
   const result=scope==='research'?this.tree.operation(requestId!):this.agents.operation(requestId!);
   // Command acceptance and delivery progress have independent lifetimes.
   if(result.command==='worker.send'||result.command==='worker.interrupt'){
    try{const submission=this.agents.submission(requestId!);return {...result,result:submission};}catch(error){if(!(error instanceof Fault)||error.code!=='SUBMISSION_NOT_FOUND')throw error;}
   }return result;
  }
  if(c.kind==='worker.create')return this.createWorker(id,actor,c.input);
  let prepared:Awaited<ReturnType<typeof this.images>>|undefined;
  if(c.kind==='worker.send')prepared=await this.images(c.input);
  const effect=async():Promise<unknown>=>{
   switch(c.kind){
    case 'project.list':return this.page(this.projects.list(),c.input.after,c.input.limit);
    case 'project.get':return this.projects.get(c.input.target);
    case 'project.create':return this.projects.create(identity(id,'project'),c.input.name,c.input.root);
    case 'graph.get':return this.tree.graph(c.input.project);
    case 'graph.history':return this.tree.history(c.input.project,c.input.after,c.input.limit);
    case 'graph.repair-tail':return this.tree.repair(c.input.project);
    case 'node.get':return this.tree.resolveNode(c.input.target,c.input.project);
    case 'node.create':{
     let source:{nodeId:string;checkpointId:string}|undefined;
     if(c.input.fromCheckpoint){const matches=this.tree.graph(c.input.project).nodes.flatMap(n=>this.tree.checkpoints(c.input.project,n.id).filter(p=>p.id===c.input.fromCheckpoint).map(p=>({nodeId:n.id,checkpointId:p.id})));if(matches.length!==1)throw new Fault('CHECKPOINT_NOT_FOUND','Select a retained checkpoint in this project');source=matches[0];}
     return this.tree.mutate(c.input.project,{operationId:id,revision:c.input.expectRevision,command:{kind:'node.create',id:identity(id,'node'),title:c.input.title,description:c.input.description,...source?{source}:{}}});
    }
    case 'node.update':{const {node}=this.tree.resolveNode(c.input.target,c.input.project);return this.tree.mutate(c.input.project,{operationId:id,revision:c.input.expectRevision,command:c.input.archived!==undefined?{kind:'node.archive',id:node.id,archived:c.input.archived}:{kind:'node.edit',id:node.id,title:c.input.title??node.title,description:c.input.description??node.description}});}
    case 'relation.create':return this.tree.mutate(c.input.project,{operationId:id,revision:c.input.expectRevision,command:{kind:'edge.create',id:identity(id,'relation'),from:c.input.from,to:c.input.to,relation:c.input.label,explanation:c.input.explanation}});
    case 'relation.update':{const edge=this.tree.graph(c.input.project).edges.find(value=>value.id===c.input.target);if(!edge)throw new Fault('RELATION_NOT_FOUND','Relation does not exist',404);return this.tree.mutate(c.input.project,{operationId:id,revision:c.input.expectRevision,command:{kind:'edge.edit',id:edge.id,relation:c.input.label??edge.relation,explanation:c.input.explanation??edge.explanation}});}
    case 'relation.retract':return this.tree.mutate(c.input.project,{operationId:id,revision:c.input.expectRevision,command:{kind:'edge.retract',id:c.input.target}});
    case 'worker.overview':return workerOverview(this.config,{agents:this.agents,tree:this.tree,projects:this.projects},c.input,actor,{signal});
    case 'worker.list':this.projects.get(c.input.project);return this.page(this.agents.workers(c.input.project,c.input.node),c.input.after,c.input.limit);
    case 'worker.get':{const w=this.agents.get(c.input.target);return c.input.options?{worker:w,options:await this.agents.setup(w.projectId,w.nodeId,w.id)}:w;}
    case 'worker.update':return this.update(c.input);
    case 'worker.send':{
     const w=this.agents.get(c.input.target),content:PromptPart[]=[];
     for(const [index,part] of (prepared?.parts??[]).entries())if(part.type==='text')content.push(part);else {
      const image=await this.agents.stageImage(w.projectId,w.nodeId,w.id,identity(id,`image:${index}`),part.name,part.mediaType,part.bytes);content.push({type:'image',attachmentId:image.id});
     }
     // Admission checks original content and sender even when a failed submission
     // was created through another transport and has no CLI operation receipt yet.
     const submission=await this.agents.submit(w.projectId,w.nodeId,w.id,{id,text:c.input.text,...content.length?{content}:{}},actor);
     return submission.retryable&&submission.state==='failed'?this.agents.retry(w.projectId,w.nodeId,w.id,id):submission;
    }
    case 'worker.interrupt':{const w=this.agents.get(c.input.target);return this.agents.submit(w.projectId,w.nodeId,w.id,{id,kind:'interrupt',text:''});}
    case 'worker.resume':{const w=this.agents.get(c.input.target);await this.agents.resume(w.projectId,w.nodeId,w.id);return this.agents.get(w.id);}
    case 'worker.close':{const w=this.agents.get(c.input.target);await this.agents.closeWorker(w.projectId,w.nodeId,w.id);return this.agents.get(w.id);}
    case 'worker.respond':{const w=this.agents.get(c.input.target);this.agents.permission(w.projectId,w.nodeId,w.id,c.input.request,c.input.option);return {answered:true,workerId:w.id,permissionId:c.input.request};}
    case 'worker.history':{const w=this.agents.get(c.input.target);return this.agents.history(w.projectId,w.nodeId,w.id,c.input.cut,c.input.before);}
    case 'worker.evidence':{const w=this.agents.get(c.input.target),evidence=await this.agents.evidence(w.projectId,w.nodeId,w.id,c.input.reference);return {mediaType:evidence.mediaType,bytes:evidence.bytes.length,sha256:createHash('sha256').update(evidence.bytes).digest('hex'),data:evidence.bytes.toString('base64')};}
    case 'checkpoint.list':{const n=this.tree.resolveNode(c.input.node);return this.page(this.tree.checkpoints(n.projectId,n.node.id),c.input.after,c.input.limit);}
    case 'checkpoint.get':{const n=this.tree.resolveNode(c.input.node),value=this.tree.checkpoints(n.projectId,n.node.id).find(p=>p.id===c.input.target);if(!value)throw new Fault('CHECKPOINT_NOT_FOUND','Published checkpoint not found',404);return value;}
    case 'checkpoint.publish':{const n=this.tree.resolveNode(c.input.node);return this.tree.checkpoint(n.projectId,n.node.id,identity(id,'checkpoint'),{publisher:actor,...c.input.note?{note:c.input.note}:{}});}
    default:throw new Fault('OPERATION_OWNER','Command belongs to another owner',400);
   }
  };
  if(!isMutation(c))return effect();
  const normalized=prepared?{...i,content:prepared.identity}:i;
  if(c.kind==='worker.update'&&(c.input.title!==undefined||c.input.archived!==undefined)){
   return this.agents.editRequest(id,actor,c.kind,normalized,()=>{
    const w=this.agents.get(c.input.target);return c.input.title!==undefined?this.agents.rename(w.projectId,w.nodeId,w.id,c.input.title):this.agents.archive(w.projectId,w.nodeId,w.id,c.input.archived!);
   });
  }
  if(c.kind.startsWith('worker.')){const result=await this.agents.executeRequest(id,actor,c.kind,normalized,effect,['worker.send','worker.interrupt'].includes(c.kind));if(result.state==='succeeded'&&['worker.send','worker.interrupt'].includes(c.kind))return this.execute({version:1,command:{kind:'operation.get',input:{target:result.reference}}},actor);return result;}
  return this.tree.executeRequest(id,actor,c.kind,normalized,effect);
 }
 /** Capture all initial choices through one owner transaction, shared by HTTP and CLI.
  * Existing receipts are compared before current availability can affect a retry. */
 async createWorker(id:string,actor:Actor,input:Extract<Request['command'],{kind:'worker.create'}>['input'],workerId=identity(id,'worker')){
  let prior=false;
  try{this.agents.operation(id);prior=true;}catch(error){if(!(error instanceof Fault)||error.code!=='OPERATION_NOT_FOUND')throw error;}
  let environment=null;
  if(!prior&&input.environment&&input.environment!=='none'){
   const choices=await this.environment.choices();
   environment=choices.find(choice=>choice.environment.environmentId===input.environment&&choice.environment.revisionId===input.revision)?.environment??null;
   if(!environment)throw new Fault('ENVIRONMENT_UNAVAILABLE','Choose an applied available exact revision');
  }
  return this.agents.editRequest(id,actor,'worker.create',input,()=>{
   const node=this.tree.resolveNode(input.node);
   return this.agents.create(node.projectId,node.node.id,workerId,{title:input.title,...input.model!==undefined?{model:input.model}:{},...input.systemPrompt?{systemPrompt:input.systemPrompt}:{},environment},{requestId:id,creator:actor});
  });
 }
 async observe(id:string){const w=this.agents.get(id);return {worker:w,...await this.agents.observe(w.projectId,w.nodeId,w.id)};}
 private async update(input:Extract<Request['command'],{kind:'worker.update'}>['input']){
  const w=this.agents.get(input.target);
  if(input.model!==undefined)return this.agents.configure(w.projectId,w.nodeId,w.id,'model',input.model);
  if(input.environment!==undefined){let selection=null;if(input.environment!=='none'){const choices=await this.environment.choices();selection=choices.find(c=>c.environment.environmentId===input.environment&&c.environment.revisionId===input.revision)?.environment;if(!selection)throw new Fault('ENVIRONMENT_UNAVAILABLE','Choose an applied available exact revision');}return this.agents.selectEnvironment(w.projectId,w.nodeId,w.id,selection);}
  throw new Fault('INVALID_INPUT','Unsupported setting',400);
 }
 private async images(input:Extract<Request['command'],{kind:'worker.send'}>['input']){
  const parts:Array<{type:'text';text:string}|{type:'image';name:string;mediaType:string;bytes:Buffer}>=[];
  if(input.text)parts.push({type:'text',text:input.text});
  let total=0;
  // Nonblocking open lets the regular-file check reject FIFOs without occupying a filesystem thread.
  for(const part of input.content??[])if(part.type==='text')parts.push(part);else {const path=resolve(part.path),file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const chunks:Buffer[]=[];let size=0;
   try{const info=await file.stat();if(!info.isFile())throw new Fault('INVALID_IMAGE','Image input must be a regular file',400);if(info.size>this.config.maxFileBytes)throw new Fault('IMAGE_LIMIT','Image exceeds configured file limit',400);
    for await(const chunk of file.createReadStream({highWaterMark:this.config.filePageBytes,autoClose:false})){const bytes=Buffer.from(chunk);size+=bytes.length;total+=bytes.length;if(size>this.config.maxFileBytes||total>this.config.maxStagedBytes)throw new Fault('IMAGE_LIMIT','Image input exceeds configured staging budget',400);chunks.push(bytes);}
   }finally{await file.close();}
   parts.push({type:'image',name:basename(path),mediaType:part.mediaType,bytes:Buffer.concat(chunks)});}
  return {parts,identity:parts.map(p=>p.type==='text'?p:{type:'image',mediaType:p.mediaType,sha256:createHash('sha256').update(p.bytes).digest('hex')})};
 }
}
