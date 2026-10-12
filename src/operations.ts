import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { Fault, Id } from './contracts.ts';

import {Actor} from './caller.ts';
export {Actor,owner} from './caller.ts';
export const Operation = z.object({
  reference:z.string(),requestId:Id,actor:Actor,command:z.string(),input:z.json(),
  state:z.enum(['accepted','running','waiting','succeeded','partial','failed','uncertain']),
  result:z.json().nullable(),error:z.object({code:z.string(),message:z.string()}).nullable(),
  attempts:z.array(z.object({at:z.number(),state:z.string(),code:z.string().optional()})),
}).strict();
export type Operation=z.infer<typeof Operation>;
export const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export function faultInfo(error:unknown){
  if(error instanceof Error&&'code' in error&&typeof error.code==='string')return {code:error.code,message:error.message};
  return {code:'OPERATION_FAILED',message:'Operation failed; inspect owner diagnostics and retained receipt'};
}

/** Durable request identity inside an owner's existing transaction boundary. Async recovery is
 * opt-in: only an owner with retained effect identity can repeat an interrupted effect. */
export class Operations {
  private pending=new Map<string,Promise<Operation>>();
  private db:DatabaseSync;private scope:string;private limit:number;private clock:()=>number;
  constructor(db:DatabaseSync,scope:string,limit:number,clock:()=>number=Date.now){this.db=db;this.scope=scope;this.limit=limit;this.clock=clock;}
  static create(db:DatabaseSync){db.exec('CREATE TABLE requests(id TEXT PRIMARY KEY,data TEXT NOT NULL)');}
  get(id:string):Operation{
    const row=this.db.prepare('SELECT data FROM requests WHERE id=?').get(Id.parse(id)) as {data:string}|undefined;
    if(!row)throw new Fault('OPERATION_NOT_FOUND','No operation with this request identity was admitted',404);
    return Operation.parse(JSON.parse(row.data));
  }
  private put(value:Operation){this.db.prepare('INSERT INTO requests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.requestId,JSON.stringify(Operation.parse(value)));}
  private admission(id:string,actor:Actor,command:string,input:unknown):Operation{
    const parsed=z.json().parse(JSON.parse(JSON.stringify(input))),prior=this.db.prepare('SELECT data FROM requests WHERE id=?').get(Id.parse(id)) as {data:string}|undefined;
    if(prior){const value=Operation.parse(JSON.parse(prior.data));if(value.actor.kind!==actor.kind||value.actor.id!==actor.id||value.command!==command||canonical(value.input)!==canonical(parsed))throw new Fault('REQUEST_CONFLICT','Request ID is already bound to different input or caller');return value;}
    if((this.db.prepare('SELECT count(*) n FROM requests').get() as {n:number}).n>=this.limit)throw new Fault('REQUEST_CAPACITY','Owner request retention is full; no operation was admitted');
    return {reference:`${this.scope}:${id}`,requestId:id,actor,command,input:parsed,state:'accepted',result:null,error:null,attempts:[]};
  }
  /** Synchronous state changes and their terminal receipt commit together. */
  sync(id:string,actor:Actor,command:string,input:unknown,effect:()=>unknown):Operation{
    this.db.exec('BEGIN IMMEDIATE');
    try{const value=this.admission(id,actor,command,input);if(value.state==='accepted'){value.result=z.json().parse(JSON.parse(JSON.stringify(effect())));value.state='succeeded';value.attempts.push({at:this.clock(),state:value.state});this.put(value);}this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async run(id:string,actor:Actor,command:string,input:unknown,recoverable:boolean,effect:()=>Promise<unknown>):Promise<Operation>{
    const value=this.admission(id,actor,command,input);
    const pending=this.pending.get(id);if(pending)return pending;
    if(value.state==='succeeded'||value.state==='uncertain'||(value.state==='failed'&&!recoverable))return value;
    if(value.state!=='accepted'&&!recoverable){value.state='uncertain';value.error={code:'EXECUTION_UNCERTAIN',message:'Owner stopped before settlement; inspect the target before issuing further work'};this.put(value);return value;}
    if(value.attempts.length>=this.limit)throw new Fault('REQUEST_CAPACITY','Request attempt retention is full');
    value.state='running';value.attempts.push({at:this.clock(),state:'running'});this.put(value);
    const task=(async()=>{
      try{value.result=z.json().parse(JSON.parse(JSON.stringify(await effect())));value.state='succeeded';value.error=null;}
      catch(error){value.error=faultInfo(error);if(value.error.code==='OPERATION_FAILED')console.error(JSON.stringify({event:'operation.failure',owner:this.scope,requestId:id,command,error:error instanceof Error?error.stack:'Unknown owner failure'}));value.state=value.error.code.includes('UNCERTAIN')?'uncertain':'failed';}
      value.attempts[value.attempts.length-1]={at:this.clock(),state:value.state,...value.error?{code:value.error.code}:{}};this.put(value);return value;
    })();this.pending.set(id,task);try{return await task;}finally{this.pending.delete(id);}
  }
}
