import {mkdir,readFile,readdir} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tryLockExclusive} from '@deepseek-ai/node-addon-system/flock';
import {z} from 'zod';
import type {Config} from '../config.ts';
import {Fault} from '../contracts.ts';
import {owner,Actor} from '../caller.ts';
import {runSystem} from '../system.ts';
import {durable} from '../environment/storage.ts';
import {socketRequest} from '../environment/daemon.ts';
import {applicationSocket} from './server.ts';
import {canonical,Operation} from '../operations.ts';
import type {Request} from './contracts.ts';

/** Lifecycle receipts live with peer control metadata, independently of domain storage.
 * A stopped peer remains inspectable; the launcher never interprets research or harness records. */
export async function runLifecycle(request:Request,config:Config,emit:(value:unknown)=>Promise<void>):Promise<number>{
 const root=join(config.stateRoot,'lifecycle'),command=request.command;
 if(command.kind==='operation.get'){const id=command.input.target.split(':').at(-1)!;const result=Operation.parse(JSON.parse(await readFile(join(root,`${id}.json`),'utf8')));if(result.reference!==command.input.target)throw new Fault('OPERATION_NOT_FOUND','Lifecycle receipt belongs to another peer',404);await emit({version:1,data:result});return result.state==='failed'?6:0;}
 if(!['daemon.start','daemon.stop','daemon.status'].includes(command.kind))throw new Fault('OPERATION_OWNER','Not a lifecycle operation',400);
 const input=command.input as {target:'main'|'environment'|'all';detach?:boolean};
 let actor:Actor=owner;
 const credential=process.env.DSH_HARNESSCTL_TOKEN??process.env.HARNESSCTL_TOKEN;
 if(process.env.DSH_SHELL&&!credential)throw new Fault('AUTH_REQUIRED','Worker shell has no provisioned application credential',401);
 if(credential)actor=Actor.parse(await socketRequest(applicationSocket(config.stateRoot),credential,'/v1/caller',undefined,config.requestTimeoutMs,config.maxBodyBytes));
 if(command.kind==='daemon.status'){await runSystem(['status',config.configPath!],{target:input.target,report:async value=>emit({version:1,data:value})});return 0;}
 await mkdir(root,{recursive:true,mode:0o700});
 const path=join(root,`${request.requestId}.json`),lock=openSync(join(root,'installation.lock'),'a',0o600);
 let locked=true;const release=()=>{if(locked){locked=false;closeSync(lock);}};
 try{
  try{await tryLockExclusive(lock);}catch{throw new Fault('LIFECYCLE_BUSY','Another lifecycle operation owns this peer; inspect its receipt');}
  let value:Operation;
  try{value=Operation.parse(JSON.parse(await readFile(path,'utf8')));if(value.actor.kind!==actor.kind||value.actor.id!==actor.id||value.command!==command.kind||canonical(value.input)!==canonical(input))throw new Fault('REQUEST_CONFLICT','Lifecycle request is bound to different input');if(value.state==='succeeded'){await emit({version:1,data:value});return 0;}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if((await readdir(root)).filter(n=>n.endsWith('.json')).length>=config.cliMaxRecords)throw new Fault('REQUEST_CAPACITY','Lifecycle receipt retention is full');value={reference:`daemon:${input.target==='environment'?'environment':'main'}:${request.requestId}`,requestId:request.requestId!,actor,command:command.kind,input,state:'accepted',result:null,error:null,attempts:[]};}
  value.state='running';value.attempts.push({at:Date.now(),state:'running'});await durable(path,value);
  let failed=false,reported=false;
  await runSystem([command.kind==='daemon.start'?'start':'stop',config.configPath!,'--no-open',...(input.detach?['--detach']:[])],{target:input.target,report:async result=>{const normalized=z.json().parse(JSON.parse(JSON.stringify(result)));failed=Object.values(result as Record<string,{state:string}>).some(v=>v.state==='failed');value.result=reported?{startup:value.result,settlement:normalized}:normalized;value.state=failed?'failed':'succeeded';if(reported)value.attempts.push({at:Date.now(),state:value.state});else value.attempts[value.attempts.length-1]={at:Date.now(),state:value.state};await durable(path,value);if(!reported){reported=true;release();await emit({version:1,data:value});}}});
  return failed?6:0;
 }finally{release();}
}
