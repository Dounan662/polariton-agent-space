import {z} from 'zod';
import {CanvasState,CanvasMoveResult,CanvasSnapshotFile} from '../canvas-contracts.ts';
import {CompactReceipt} from './receipts.ts';
import {WorkerOverview} from '../worker-overview-contracts.ts';
import {SessionMetrics} from '../metrics.ts';
import {Id,Checkpoint,WorkerResidency,WorkerCreation,WorkerEnvironment,WorkerMcpStatus,Submission,GraphCommand} from '../contracts.ts';
import {Operation} from '../operations.ts';
import {OfficialPage,OfficialDetail,Capability,Revision,EnvironmentDocument,ImportPreview,RecordSchemas,EnvironmentChoice} from '../environment/contracts.ts';

/** Version-one wire results. Domain data remains owned by its module; native DSH
 * event bodies and release provenance are explicitly extensible JSON payloads. */
const nullableId=Id.nullable(),number=z.number().int().nonnegative();
const node=z.object({id:Id,title:z.string(),description:z.string(),archived:z.boolean(),source:z.object({nodeId:Id,checkpointId:Id}).optional()}).strict();
const edge=z.object({id:Id,from:Id,to:Id,relation:z.string(),explanation:z.string(),retracted:z.boolean()}).strict();
const graph=z.object({revision:number,nodes:z.array(node),edges:z.array(edge),recovery:z.string().nullable()}).strict();
const project=z.object({id:Id,name:z.string(),root:z.string(),availability:z.enum(['available','historical','unavailable']),detail:z.string().nullable(),mainNodeId:nullableId,initialWorkerId:nullableId,initialization:z.object({state:z.enum(['pending','ready','blocked']),detail:z.string().nullable()}).strict()}).strict();
const model=z.object({id:z.string(),name:z.string(),currentValue:z.string(),options:z.array(z.object({value:z.string(),name:z.string(),group:z.string().optional()}).strict())}).strict();
const permission=z.object({id:Id,toolCallId:z.string(),title:z.string(),detail:z.string(),options:z.array(z.object({optionId:z.string(),name:z.string(),kind:z.string()}).strict())}).strict();
const worker=z.object({residency:WorkerResidency,creation:WorkerCreation,mcp:z.array(WorkerMcpStatus),environment:WorkerEnvironment,cleanupPending:z.boolean(),id:Id,nodeId:Id,projectId:Id,agentId:Id,assignmentId:Id,processId:nullableId,harnessSessionId:z.string().nullable(),title:z.string(),state:z.enum(['inactive','closed','starting','idle','running','interrupting','uncertain','failed']),error:z.string().nullable(),archived:z.boolean(),model:z.string().nullable(),configOptions:z.array(model),imageCapability:z.boolean(),submissions:z.array(Submission),permissions:z.array(permission)}).strict();
const history=z.object({kind:z.literal('persisted'),formatVersion:number,sourceSessionId:z.string(),attachments:z.array(z.object({reference:z.string().optional(),seq:number,index:number,name:z.string(),mediaType:z.string(),bytes:number}).strict()),events:z.array(z.object({type:z.string(),seq:number,time:z.number(),data:z.json(),surfaceOp:z.json().optional(),sourceEventSeqs:z.array(number).optional()}).passthrough()),cut:z.string(),before:number.nullable(),coverage:z.literal('readable-persisted-prefix'),total:number,metrics:SessionMetrics.optional()}).strict();
const page=<T extends z.ZodType>(item:T)=>z.object({items:z.array(item),next:number.nullable()}).strict();
export const ErrorResult=z.object({code:z.string(),message:z.string(),operation:z.string().optional(),action:z.string().optional()}).strict();
export const Receipt=Operation.extend({requestId:z.string(),connection:z.json().optional(),output:z.string().optional()});
export const Result=z.object({version:z.literal(1),data:z.json().optional(),error:ErrorResult.optional()}).strict().refine(value=>value.data!==undefined||value.error!==undefined);
export const FollowRecord=z.discriminatedUnion('kind',[
 z.object({version:z.literal(1),kind:z.literal('snapshot'),sequence:number,data:z.object({worker,page:history.nullable(),cursor:z.number().int(),assistantStream:z.object({revision:number}).passthrough(),process:z.string().nullable()}).strict()}).strict(),
 z.object({version:z.literal(1),kind:z.literal('end'),reason:z.literal('deadline'),workCancelled:z.literal(false)}).strict(),
]);
const read:Record<string,z.ZodType>={
 'canvas.get':CanvasState,'canvas.move':CanvasMoveResult,'canvas.snapshot':CanvasSnapshotFile,'canvas.finish':z.object({removed:z.number().int().nonnegative()}).strict(),
 'project.list':page(project),'project.get':project,'graph.get':graph,
 'graph.history':z.object({entries:z.array(z.object({operationId:Id,revision:number,command:GraphCommand,seq:number}).passthrough()),revision:number,next:number.nullable(),recovery:z.string().nullable()}).strict(),
 'node.get':z.object({projectId:Id,node,workspace:z.string()}).strict(),
 'worker.overview':WorkerOverview,
 'worker.list':page(worker),'worker.get':z.union([worker,z.object({worker,options:z.object({models:z.array(model),environments:z.array(EnvironmentChoice),environmentError:z.string().nullable()}).strict()}).strict()]),
 'worker.history':history,'worker.evidence':z.object({mediaType:z.string(),bytes:number,sha256:z.string(),data:z.string().optional(),output:z.string().optional()}).strict(),
 'checkpoint.list':page(Checkpoint),'checkpoint.get':Checkpoint,'capability.preview':ImportPreview,'capability.list':page(Capability),'capability.get':Capability,
 'catalog.list':OfficialPage,'catalog.get':OfficialDetail,
 'release.get':z.object({release:RecordSchemas.release!,provenance:z.json()}).strict(),
 'environment.list':page(z.object({id:z.string(),head:Revision,applied:z.json().nullable()}).strict()),'environment.get':Revision,
 'environment.preview':z.object({valid:z.literal(true),base:Revision.nullable(),document:EnvironmentDocument,changed:z.boolean(),reserved:z.literal(false)}).strict(),
 'mount.list':page(RecordSchemas.mount!),'mount.get':RecordSchemas.mount!,'mount.observe':RecordSchemas.observation!,
 'binding.list':page(z.object({id:z.string(),mountId:z.string(),generation:z.string(),principal:z.string(),access:z.enum(['observe','call']),released:z.boolean()}).strict()),
 'binding.get':z.object({id:z.string(),mountId:z.string(),generation:z.string(),principal:z.string(),access:z.enum(['observe','call']),released:z.boolean()}).strict(),
 'daemon.status':z.record(z.string(),z.object({state:z.string(),ready:z.boolean().optional(),pid:z.number().optional(),daemon:z.string().optional(),stateRoot:z.string().optional()}).strict()),
};
export function resultSchema(command:string){return read[command]??Receipt;}
export function parseResult(command:string,value:unknown){return resultSchema(command).parse(value);}
export const responseSchemas=()=>({envelope:z.toJSONSchema(Result),error:z.toJSONSchema(ErrorResult),receipt:z.toJSONSchema(Receipt),compactReceipt:z.toJSONSchema(CompactReceipt),follow:z.toJSONSchema(FollowRecord)});
