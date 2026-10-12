import {z} from 'zod';
import {Operation} from '../operations.ts';
import {WorkerEnvironment} from '../contracts.ts';
import {identity} from './identity.ts';

const text=z.string(),number=z.number(),flag=z.boolean();
const resource=z.object({id:text,title:text.optional(),name:text.optional(),state:text.optional(),status:text.optional(),revisionId:text.optional()});
/** Presentation retains actionable identity and outcomes, never request payloads or
 * copied conversations. Owners retain the complete evidence behind --details. */
export const ReceiptSummary=z.object({
 id:text.optional(),kind:text.optional(),name:text.optional(),title:text.optional(),root:text.optional(),
 projectId:text.optional(),nodeId:text.optional(),mainNodeId:text.nullable().optional(),initialWorkerId:text.nullable().optional(),workerId:text.optional(),permissionId:text.optional(),
 state:text.optional(),status:text.optional(),error:text.nullable().optional(),detail:text.nullable().optional(),retryable:flag.optional(),answered:flag.optional(),released:flag.optional(),
 model:text.nullable().optional(),environment:WorkerEnvironment.optional(),archived:flag.optional(),
 initialization:z.object({state:text,detail:text.nullable()}).optional(),
 revision:number.optional(),revisionId:text.optional(),baseRevisionId:text.nullable().optional(),environmentId:text.optional(),capabilityId:text.nullable().optional(),releaseId:text.nullable().optional(),bindingId:text.optional(),mountId:text.optional(),packageId:text.optional(),
 recipientWorkerId:text.nullable().optional(),fileCount:number.optional(),
 commit:text.optional(),createdAt:z.union([text,number]).optional(),
 capabilities:z.array(resource).optional(),
 components:z.array(z.object({id:text.optional(),componentId:text.optional(),errorCode:text.optional(),capabilityId:text.optional(),mountId:text.nullable().optional(),readiness:text.optional(),error:text.nullable().optional()})).optional(),
});
const graphSummary=z.object({revision:number,recovery:text.nullable(),id:text.optional(),title:text.optional(),archived:flag.optional(),from:text.optional(),to:text.optional(),relation:text.optional(),retracted:flag.optional(),nodeCount:number,relationCount:number}).strict();
const peer=z.object({state:text.optional(),error:text.optional(),reused:flag.optional(),status:z.object({state:text.optional(),pid:number.optional()}).optional()});
const peers=z.object({main:peer.optional(),environment:peer.optional()});
const lifecycleSummary=peers.extend({startup:peers.optional(),settlement:peers.optional()});
const receiptResult=z.union([graphSummary,lifecycleSummary.strict().refine(v=>Object.keys(v).length>0),ReceiptSummary]).nullable();
type ReceiptResult=z.infer<typeof receiptResult>;
export const CompactReceipt=Operation.pick({reference:true,requestId:true,command:true,state:true,error:true}).extend({
 view:z.literal('compact'),resultBasis:z.enum(['retained-command-result','delivery-observation']),
 result:receiptResult,note:text,inspect:z.object({operation:text,resource:text.optional()}).strict(),output:text.optional(),
}).strict();
const input=z.object({target:text.optional(),project:text.optional(),node:text.optional(),environmentId:text.optional(),id:text.optional(),entryId:text.optional()});
const graph=z.object({revision:number,nodes:z.array(z.object({id:text,title:text,archived:flag})),edges:z.array(z.object({id:text,from:text,to:text,relation:text,retracted:flag})),recovery:text.nullable()});
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;

/** The projection is observational: it neither refreshes resources nor changes
 * retained receipts. Delivery records are the owner's explicit live exception. */
export function compactReceipt(value:z.infer<typeof Operation>&{output?:string}){
 const args=input.parse(value.input),delivery=value.command==='worker.send'||value.command==='worker.interrupt';
 const resourceName=value.command.split('.')[0]!;
 let result:ReceiptResult=value.result===null?null:resourceName==='daemon'?lifecycleSummary.parse(value.result):ReceiptSummary.parse(value.result);
 const identified=result as z.infer<typeof ReceiptSummary>|null;
 let inspect:string|undefined;
 if(value.result!==null&&(resourceName==='node'||resourceName==='relation'||value.command==='graph.repair-tail')){
  const retained=graph.parse(value.result);
  const id=args.target??(value.command.endsWith('.create')?identity(value.requestId,resourceName):undefined);
  const affected=resourceName==='node'?retained.nodes.find(item=>item.id===id):retained.edges.find(item=>item.id===id);
  result={revision:retained.revision,recovery:retained.recovery,...(affected??{}),nodeCount:retained.nodes.length,relationCount:retained.edges.length};
  if(args.project)inspect=`harnessctl graph get --project ${quote(args.project)}`;
 }else if(delivery){
  result=result===null?null:{...result,recipientWorkerId:args.target??null};
  if(args.target)inspect=`harnessctl worker overview ${quote(args.target)}`;
 }else if(resourceName==='worker'){
  const id=identified?.id??args.target;if(typeof id==='string')inspect=`harnessctl worker overview ${quote(id)}`;
 }else if(resourceName==='checkpoint'){
  const id=identified?.id;if(typeof id==='string'&&args.node)inspect=`harnessctl checkpoint get ${quote(id)} --node ${quote(args.node)}`;
  if(value.result!==null){const files=z.object({files:z.array(text)}).parse(value.result).files;result={...result,fileCount:files.length};}
 }else if(resourceName==='daemon'){
  // Lifecycle results contain a small peer map; preserve peer outcome and PID,
  // but omit startup command/configuration and historical nested reports.
  result=value.result===null?null:lifecycleSummary.parse(value.result);inspect=`harnessctl daemon status ${quote(args.target??'all')}`;
 }else if(resourceName==='project'||resourceName==='capability'||resourceName==='release'||resourceName==='environment'||resourceName==='mount'||resourceName==='binding'||resourceName==='catalog'){
  const id=resourceName==='environment'?identified?.environmentId??args.environmentId??args.target:resourceName==='binding'?identified?.bindingId??args.id??args.target:resourceName==='catalog'?args.entryId??args.target:identified?.id??args.target??args.id;
  if(typeof id==='string')inspect=`harnessctl ${resourceName} get ${quote(id)}`;
 }
 return CompactReceipt.parse({reference:value.reference,requestId:value.requestId,command:value.command,state:value.state,error:value.error,view:'compact',resultBasis:delivery?'delivery-observation':'retained-command-result',result,
  note:delivery?'Command state is admission; result.state is delivery observed at this read, not recipient task completion. Replies require worker send.':'Result is a retained command snapshot, not current resource state.',
  inspect:{operation:`harnessctl operation get ${quote(value.reference)} --details`,...(inspect?{resource:inspect}:{})},...(value.output?{output:value.output}:{})});
}
