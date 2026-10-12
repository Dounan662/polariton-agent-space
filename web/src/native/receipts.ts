import type {Submission} from '../../../src/contracts.ts';
import type {Outgoing} from '../messages.ts';
import type {ChatNode} from './client/ui-chat/src/client/contract/chat-nodes.ts';
import type {RenderEntry} from './conversation.ts';
export type MessageRow={key:string;node?:ChatNode;submission?:Submission;outgoing?:Outgoing};
const key=(id:string)=>`submission:${id}`;

/** Only Polariton-admitted human or worker input can claim a delivery receipt. */
export function submissionId(node:ChatNode):string|undefined{
 if(node.kind!=='user'&&node.kind!=='steering')return;
 const source=node.data.source;
 if(source&&typeof source==='object'&&'kind' in source&&(source.kind==='user'||source.kind==='polariton-worker')&&'rpcId' in source&&typeof source.rpcId==='string')return source.rpcId;
}

/** Correlate local admission and native history by identity without adding fabricated DSH events.
 * Settled receipts outside the loaded history window do not become new transcript entries. */
export function messageRows(nodes:readonly ChatNode[],submissions:readonly Submission[],outgoing:readonly Outgoing[]):MessageRow[]{
 const receipts=new Map(submissions.filter(value=>value.kind!=='interrupt').map(value=>[value.id,value]));
 const local=new Map(outgoing.filter(value=>!('kind' in value.request)).map(value=>[value.request.id,value]));
 const recorded=new Set<string>();
 const rows:MessageRow[]=nodes.filter(node=>node.visibility==='visible').map(node=>{
  const id=submissionId(node);
  if(!id)return {key:node.key,node};
  recorded.add(id);
  return {key:key(id),node,submission:receipts.get(id)??local.get(id)?.receipt,outgoing:local.get(id)};
 });
 for(const id of new Set([...receipts.keys(),...local.keys()])){
  if(recorded.has(id))continue;
  const pending=local.get(id),submission=receipts.get(id)??pending?.receipt;
  if(!pending&&(!submission||['completed','applied','interrupted'].includes(submission.state)))continue;
  rows.push({key:key(id),submission,outgoing:pending});
 }
 return rows;
}

export type ConversationRow =
 | {key:string;kind:'message';message:MessageRow}
 | {key:string;kind:'native';entry:RenderEntry};

/** Merge delivery receipts into DSH's grouped flow. Groups never own user inputs;
 * native split-node references keep distinct positions, while an admitted input
 * keeps its original receipt key when history records it. */
export function conversationRows(entries:readonly RenderEntry[],nodes:readonly ChatNode[],submissions:readonly Submission[],outgoing:readonly Outgoing[]):ConversationRow[]{
 const messages=messageRows(nodes,submissions,outgoing);
 const users=new Map(messages.flatMap(row=>row.node&&(row.node.kind==='user'||row.node.kind==='steering')?[[row.node.key,row] as const]:[]));
 const rows:ConversationRow[]=entries.flatMap((entry):ConversationRow[]=>{
  if(entry.kind==='node'){
   const user=users.get(entry.key);
   if(user)return [{key:user.key,kind:'message',message:user}];
  }
  return [{key:JSON.stringify(entry.kind==='group'?['group',entry.key]:['node',entry.key,entry.groupPart??null]),kind:'native',entry}];
 });
 for(const message of messages)if(!message.node)rows.push({key:message.key,kind:'message',message});
 return rows;
}

/** Only delivery exceptions and admitted queue states need a label; ordinary pending
 * input is already visible as a message while it becomes recorded history. */
export function messageStatus(row:MessageRow):string|undefined{
 const receipt=row.submission;
 if(receipt?.state==='failed')return receipt.detail??'Message failed.';
 if(receipt?.state==='uncertain')return receipt.detail??'Delivery is unconfirmed. Inspect recorded history before retrying.';
 if(receipt?.state==='interrupted')return 'Interrupted.';
 if(row.node)return undefined;
 if(receipt?.state==='admitted')return 'Accepted · waiting for the next agent step';
 if(receipt?.state==='applied'||receipt?.state==='completed')return 'Synchronizing recorded message…';
 if(row.outgoing?.error)return row.outgoing.rejected?`Not sent: ${row.outgoing.error}`:`Delivery is unconfirmed: ${row.outgoing.error}`;
 return undefined;
}
