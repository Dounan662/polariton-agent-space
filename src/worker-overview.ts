import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {Fault,type ProjectView} from './contracts.ts';
import type {Actor} from './caller.ts';
import type {Config} from './config.ts';
import type {AgentManager} from './agents.ts';
import type {ResearchTree} from './research.ts';
import {WorkerOverview,overviewText,attentionRank,type WorkerOverviewInput,type OverviewAttention,type AttentionPosition} from './worker-overview-contracts.ts';

const Cursor=z.object({version:z.literal(1),target:z.string().uuid(),section:z.enum(['coworkers','attention']),ordering:z.literal('kind-id-v1'),rank:z.number().int().min(0).max(3),id:z.string()}).strict();
type Cursor=z.infer<typeof Cursor>;
type Owners={agents:Pick<AgentManager,'overviewWorker'|'overviewCoworkers'|'overviewAttention'>;projects:{get(id:string):ProjectView};tree:Pick<ResearchTree,'resolveNode'>};
type Observation={clock?:()=>number;signal?:AbortSignal;workspaceAvailable?:(path:string,signal:AbortSignal)=>Promise<boolean>};
const encode=(cursor:Cursor)=>Buffer.from(JSON.stringify(cursor)).toString('base64url');
/** One bounded application read joins retained owner facts. No activation, history,
 * receipt creation or external environment calls are needed to orient a worker. */
export async function workerOverview(config:Config,owners:Owners,input:WorkerOverviewInput,actor:Actor,observation:Observation={}):Promise<WorkerOverview> {
 const clock=observation.clock??Date.now,startedAt=clock();
 const target=input.target??(actor.kind==='worker'?actor.id:null);
 if(!target)throw new Fault('OVERVIEW_TARGET_REQUIRED','Administrative callers must supply WORKER_ID; discover IDs with harnessctl worker list --project PROJECT_ID',409);
 const limit=input.limit??config.workerOverviewPageSize;
 if(limit>config.cliPageSize)throw new Fault('INVALID_CURSOR','Overview limit exceeds the configured CLI page size',400);
 let cursor:Cursor={version:1,target,section:input.section??'attention',ordering:'kind-id-v1',rank:0,id:''};
 if(input.after){try{cursor=Cursor.parse(JSON.parse(Buffer.from(input.after,'base64url').toString('utf8')));}catch{throw new Fault('INVALID_CURSOR','Invalid overview continuation; reopen harnessctl worker overview',400);}if(cursor.target!==target||cursor.section!==input.section||(cursor.section==='coworkers'&&cursor.rank!==0))throw new Fault('INVALID_CURSOR','Continuation belongs to another target or section; reopen its overview',400);}
 const deadline=AbortSignal.timeout(config.requestTimeoutMs),signal=observation.signal?AbortSignal.any([deadline,observation.signal]):deadline;
 const check=()=>{if(signal.aborted)throw new Fault(signal.reason?.name==='TimeoutError'?'OVERVIEW_TIMEOUT':'OVERVIEW_CANCELLED','Worker overview observation was cancelled or exceeded the request deadline',503);};
 check();
 const w=owners.agents.overviewWorker(target),text=(value:string)=>overviewText(value,config.workerOverviewTextChars),inspect=`harnessctl worker get ${target}`;
 const empty=<T>()=>({availability:'available' as const,total:0,returned:0,coverage:'complete' as const,next:null,items:[] as T[]});
 const result:WorkerOverview={status:'complete',observed:{startedAt,finishedAt:startedAt,consistency:'live-owner-observation'},worker:{id:target,name:w.name,inspect},placement:{project:{id:w.projectId,name:null,availability:'unknown',initialization:'unknown',initialWorkerId:null,inspect:`harnessctl project get ${w.projectId}`},node:{id:w.nodeId,title:null,archived:null,availability:'unknown',inspect:`harnessctl node get ${w.nodeId} --project ${w.projectId}`},workspace:{path:null,availability:'unknown',omission:'source',inspect:`harnessctl node get ${w.nodeId} --project ${w.projectId}`}},execution:{state:w.state,model:w.model,error:w.error,residency:w.residency,cleanupPending:w.cleanupPending},environment:{selection:w.environment.selection?{...w.environment.selection,name:text(w.environment.selection.name)}:null,locked:w.environment.locked,observation:w.environment.selection===null?'none':w.connectionsKnown?'last-observed':'unknown',active:w.active,connections:{total:w.connectionsKnown?w.connectionTotal:null,returned:Math.min(w.connections.length,config.workerOverviewPageSize),coverage:w.connectionsKnown?(w.connectionTotal>w.connections.length?'page':'complete'):'unknown',next:w.connectionTotal>w.connections.length?inspect:null,items:w.connections.slice(0,config.workerOverviewPageSize).map(c=>({...c,serverName:text(c.serverName)}))},inspect:w.environment.selection?`harnessctl environment get ${w.environment.selection.environmentId} --revision ${w.environment.selection.revisionId}`:null},coworkers:empty(),attention:{...empty<OverviewAttention>(),totals:{currentIssues:0,permissions:null,pendingDelivery:null,historicalDelivery:null}},issues:[]};
 const failure=(source:WorkerOverview['issues'][number]['source'],error:unknown)=>{result.status='partial';result.issues.push({source,code:error instanceof Fault?error.code:'OVERVIEW_SOURCE_FAILED',detail:text(error instanceof Error?error.message:'Owner read failed')});};
 const issues:OverviewAttention[]=[];
 const issue=(id:string,title:string,detail:string|null,reference=inspect)=>issues.push({id,kind:'currentIssue',code:id,title:text(title),detail:detail?text(detail):null,sender:null,deliveryState:null,operation:null,inspect:reference});
 if(w.state==='failed'||w.state==='uncertain'){issue('WORKER_'+w.state.toUpperCase(),'Worker execution is '+w.state,null);issues.at(-1)!.detail=w.error;}
 if(w.cleanupPending)issue('CLEANUP_PENDING','Execution resource cleanup is pending',null);
 // Connection records are observations from the last activation. Cold workers are
 // not declared broken because no active connection can currently be observed.
 if(w.active){const unavailable=w.unavailableConnections;if(unavailable)issue('CONNECTION_UNAVAILABLE',`${unavailable} last-observed tool connections unavailable`,'Inspect worker connection records for component identities and failure codes.');}
 try{const project=owners.projects.get(w.projectId);Object.assign(result.placement.project,{name:text(project.name),availability:project.availability,initialization:project.initialization.state,initialWorkerId:project.initialWorkerId});if(project.availability!=='available')issue('PROJECT_UNAVAILABLE','Project workspace is '+project.availability,project.detail,result.placement.project.inspect);if(project.initialization.state!=='ready')issue('PROJECT_INITIALIZATION','Project initialization is '+project.initialization.state,project.initialization.detail,result.placement.project.inspect);}catch(error){failure('project',error);}
 check();
 try{const node=owners.tree.resolveNode(w.nodeId,w.projectId);Object.assign(result.placement.node,{title:text(node.node.title),archived:node.node.archived,availability:'available'});result.placement.workspace.path=node.workspace;result.placement.workspace.omission=null;
   try{const available=observation.workspaceAvailable??(async(path:string)=>{try{return (await stat(path)).isDirectory();}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}});
    let abort:()=>void=()=>{};
    try{const present=await Promise.race([available(node.workspace,signal),new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Fault('OVERVIEW_TIMEOUT','Workspace observation cancelled or timed out',503));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);result.placement.workspace.availability=present?'available':'unavailable';if(!present)issue('WORKSPACE_UNAVAILABLE','Workspace directory is unavailable',null,result.placement.workspace.inspect);}finally{signal.removeEventListener('abort',abort);}
   }catch(error){check();failure('workspace',error);}
 }catch(error){check();failure('node',error);}
 check();issues.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);result.attention.totals.currentIssues=issues.length;
 const coworkerAfter=input.section==='coworkers'?cursor.id:'',coworkerLimit=input.section==='coworkers'?limit:config.workerOverviewPageSize,attentionLimit=input.section==='attention'?limit:config.workerOverviewPageSize;
 try{const page=owners.agents.overviewCoworkers(w,coworkerAfter,coworkerLimit+1);result.coworkers={availability:'available',total:page.total,returned:page.items.length,coverage:'complete',next:null,items:page.items};}catch(error){failure('coworkers',error);result.coworkers={availability:'unavailable',total:null,returned:0,coverage:'unknown',next:null,items:[]};}
 const attentionAfter:AttentionPosition=input.section==='attention'?cursor:{rank:0,id:''};
 const current=issues.filter(item=>attentionAfter.rank===0&&item.id>attentionAfter.id);
 try{const page=owners.agents.overviewAttention(target,attentionAfter,attentionLimit+1);result.attention={availability:'available',total:issues.length+page.totals.permissions+page.totals.pendingDelivery+page.totals.historicalDelivery,returned:0,coverage:'complete',next:null,items:[...current,...page.items].slice(0,attentionLimit+1),totals:{currentIssues:issues.length,...page.totals}};}catch(error){failure('attention',error);result.attention.availability='unavailable';result.attention.total=null;result.attention.coverage='unknown';result.attention.items=current.slice(0,attentionLimit+1);}
 // Fetch one extra entry to prove continuation. Retain the original tail while
 // reducing pages to fit the shared byte budget; even a zero-entry page can resume.
 const coworkerMore=result.coworkers.items.length>coworkerLimit,attentionMore=result.attention.items.length>attentionLimit;
 result.coworkers.items=result.coworkers.items.slice(0,coworkerLimit);result.attention.items=result.attention.items.slice(0,attentionLimit);
 const update=(section:'coworkers'|'attention',more:boolean)=>{const page=result[section];page.returned=page.items.length;if(page.availability==='available')page.coverage=more||!!(input.section===section&&input.after)?'page':'complete';page.next=more?encode({version:1,target,section,ordering:'kind-id-v1',rank:section==='attention'?(page.items.length?attentionRank(page.items.at(-1)! as OverviewAttention):attentionAfter.rank):0,id:page.items.at(-1)?.id??(section==='coworkers'?coworkerAfter:attentionAfter.id)}):null;};
 let moreCoworkers=coworkerMore,moreAttention=attentionMore;
 update('coworkers',moreCoworkers);update('attention',moreAttention);
 result.observed.finishedAt=clock();check();
 const bytes=()=>Buffer.byteLength(JSON.stringify({version:1,data:result}))+1;
 if(bytes()>config.workerOverviewMaxBytes&&result.placement.workspace.path&&Buffer.byteLength(result.placement.workspace.path)>config.workerOverviewTextChars){result.placement.workspace.path=null;result.placement.workspace.omission='size';}
 while(bytes()>config.workerOverviewMaxBytes&&result.environment.connections.items.length){result.environment.connections.items.pop();result.environment.connections.returned=result.environment.connections.items.length;result.environment.connections.coverage='page';result.environment.connections.next=inspect;}
 while(bytes()>config.workerOverviewMaxBytes&&(result.coworkers.items.length||result.attention.items.length)){
   // Prioritize the selected expansion, and current attention over coworkers.
   if(result.coworkers.items.length&&(input.section!=='coworkers'||!result.attention.items.length)){result.coworkers.items.pop();moreCoworkers=true;update('coworkers',moreCoworkers);}else{result.attention.items.pop();moreAttention=true;update('attention',moreAttention);}
 }
 if(input.section&&result[input.section].next&&result[input.section].items.length===0)throw new Fault('OUTPUT_LIMIT','Overview page cannot fit one entry; increase workerOverviewMaxBytes',409);
 if(bytes()>config.workerOverviewMaxBytes)throw new Fault('OUTPUT_LIMIT','Minimum worker overview metadata exceeds workerOverviewMaxBytes; increase the configured limit',409);
 return WorkerOverview.parse(result);
}
