import {z} from 'zod';
import {PromptPart, type Submission,type WorkerState} from '../../src/contracts.ts';

export type MessageRequest={id:string;text:string;content:PromptPart[]};
export type Outgoing={request:MessageRequest|{id:string;kind:'interrupt';text:''};createdAt:number;receipt?:Submission;error?:string;rejected?:boolean;recovering?:true};
const savedMessages=z.array(z.object({request:z.union([z.object({id:z.string().uuid(),text:z.string(),content:z.array(PromptPart)}).strict(),z.object({id:z.string().uuid(),kind:z.literal('interrupt'),text:z.literal('')}).strict()]),createdAt:z.number().finite().nonnegative(),error:z.string().optional(),rejected:z.literal(true).optional()}).strict());
/** Retain only immutable request identity and content; server receipts are refreshed on reconnect. */
export function saveOutgoing(values:readonly Outgoing[]):string{return JSON.stringify(values.map(({request,createdAt,error,rejected})=>({request,createdAt,...rejected?{error,rejected}:{}})));}
export function restoreOutgoing(value:string|null):Outgoing[]{return savedMessages.parse(JSON.parse(value??'[]')).map(item=>({...item,...item.rejected?{error:item.error}:{error:'Checking retained message receipt…',recovering:true as const}}));}
/** Recover retained identities through reads only. Applied content belongs to native
 * history even when its page is unloaded; unresolved inputs and failures stay visible.
 * Fresh sends keep their optimistic row until native source arrives. */
export async function recoverOutgoing(values:readonly Outgoing[],recent:readonly Submission[],lookup:(id:string)=>Promise<Submission>):Promise<Outgoing[]>{
 const current=new Map(recent.map(receipt=>[receipt.id,receipt]));
 const recovered=await Promise.all(values.map(async value=>{
  if(value.rejected||(!value.recovering&&(!value.receipt||current.has(value.request.id))))return value;
  try{
   const receipt=current.get(value.request.id)??await lookup(value.request.id);
   if(receipt.id!==value.request.id)throw new Error('Receipt identity did not match this request.');
   if(receipt.state==='applied'||(receipt.kind==='interrupt'&&receipt.state==='completed'))return null;
   return {...value,receipt,error:undefined,rejected:undefined,recovering:true as const};
  }catch(error){return {...value,error:`Receipt lookup failed: ${(error as Error).message}`,recovering:true as const};}
 }));
 return recovered.filter((value):value is Outgoing=>value!==null);
}
/** Button, keyboard, paste and drop paths share the same admission constraints. */
export function canSendMessage(input:{busy:boolean;storageBlocked:boolean;text:string;imageCount:number;state:WorkerState;cleanupPending:boolean}):boolean{
 return !input.busy&&!input.storageBlocked&&!input.cleanupPending&&Boolean(input.text.trim()||input.imageCount)&&!['interrupting','closed','uncertain'].includes(input.state);
}
