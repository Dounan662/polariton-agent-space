import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Fault} from './contracts.ts';
import type {CanvasPolicy,CanvasSnapshot,CanvasSnapshotFile} from './canvas-contracts.ts';

type Scope={actor:string;project:string};
type File={scope:string;expiresAt:number};
type Capture={scope:string;controller:AbortController};
type Policy=Pick<CanvasPolicy,'snapshotTtlMs'|'maxSnapshots'|'maxImageBytes'>;
const filename=/^([a-f0-9]{64})-(\d+)-[a-f0-9-]{36}\.png$/;
const key=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Owns disposable inspection images, including interrupted captures and restart expiry.
 * Callers receive local paths, never choose cache locations or manage leases. Finish is
 * caller/project scoped and prevents an already-running capture from recreating files. */
export class CanvasSnapshots {
 private files=new Map<string,File>();
 private captures=new Set<Capture>();
 private queue:Promise<unknown>=Promise.resolve();
 private timer:NodeJS.Timeout|undefined;
 private closed=false;
 private root:string;private policy:Policy;private report:(error:unknown)=>void;private now:()=>number;
 private constructor(root:string,policy:Policy,report:(error:unknown)=>void,now:()=>number){this.root=root;this.policy=policy;this.report=report;this.now=now;}

 static async open(stateRoot:string,policy:Policy,report:(error:unknown)=>void,dependencies:{now?:()=>number;temporaryRoot?:string}={}):Promise<CanvasSnapshots>{
  const root=join(await realpath(dependencies.temporaryRoot??tmpdir()),`polariton-canvas-${key(await realpath(stateRoot))}`);
  try{await mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const stat=await lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Fault('CANVAS_STORAGE','Snapshot cache must be a private directory owned by this user',503);
  const cache=new CanvasSnapshots(root,policy,report,dependencies.now??Date.now);
  for(const name of await readdir(root)){
   const match=filename.exec(name);if(match&&Number.isSafeInteger(Number(match[2])))cache.files.set(join(root,name),{scope:match[1],expiresAt:Number(match[2])});
  }
  await cache.expire();cache.schedule();return cache;
 }

 async capture(scope:Scope,render:(signal:AbortSignal)=>Promise<CanvasSnapshot>,signal?:AbortSignal):Promise<CanvasSnapshotFile>{
  const capture:Capture={scope:key([scope.actor,scope.project]),controller:new AbortController()};
  const cancelled=AbortSignal.any([capture.controller.signal,...signal?[signal]:[]]);
  await this.serialize(async()=>{
   this.available(cancelled);await this.expire();
   if(this.files.size+this.captures.size>=this.policy.maxSnapshots)throw new Fault('CANVAS_LIMIT','Temporary snapshot capacity is full; run canvas finish for completed adjustments or wait for expiry',409);
   this.captures.add(capture);
  });
  try{
   const snapshot=await render(cancelled);
   return await this.serialize(async()=>{
    this.available(cancelled);
    const {data,...metadata}=snapshot,bytes=Buffer.from(data,'base64');
    if(bytes.length>this.policy.maxImageBytes)throw new Fault('CANVAS_LIMIT','Snapshot exceeds the configured image budget',413);
    const expiresAt=this.now()+this.policy.snapshotTtlMs,output=join(this.root,`${capture.scope}-${expiresAt}-${randomUUID()}.png`);
    const file=await open(output,'wx',0o600);this.files.set(output,{scope:capture.scope,expiresAt});
    try{await file.writeFile(bytes);}catch(error){await rm(output,{force:true});this.files.delete(output);throw error;}finally{await file.close();}
    // Finish queues behind publication; cancellation may arrive during the file write.
    if(cancelled.aborted||this.closed){await rm(output,{force:true});this.files.delete(output);this.available(cancelled);}
    return {...metadata,output,expiresAt};
   });
  }finally{this.captures.delete(capture);this.schedule();}
 }

 /** No browser or request receipt is needed to repeat cleanup after an interrupted workflow. */
 async finish(scope:Scope):Promise<{removed:number}>{
  return this.serialize(async()=>{
   const owner=key([scope.actor,scope.project]);for(const capture of this.captures)if(capture.scope===owner)capture.controller.abort();
   let removed=0;
   for(const [path,file] of this.files)if(file.scope===owner){await rm(path,{force:true});this.files.delete(path);removed++;}
   this.schedule();return {removed};
  });
 }

 async close():Promise<void>{
  this.closed=true;if(this.timer)clearTimeout(this.timer);
  for(const capture of this.captures)capture.controller.abort();
  await this.serialize(async()=>{for(const path of this.files.keys()){await rm(path,{force:true});this.files.delete(path);}});
 }

 private available(signal:AbortSignal){if(this.closed||signal.aborted)throw new Fault('CANVAS_CANCELLED','Snapshot capture was cancelled or its adjustment workflow has finished',408);}
 private serialize<T>(work:()=>Promise<T>):Promise<T>{
  const result=this.queue.then(work).catch(error=>{if(error instanceof Fault)throw error;throw new Fault('CANVAS_STORAGE',`Temporary snapshot storage failed: ${error instanceof Error?error.message:String(error)}`,503);});
  // The caller observes failures; later cleanup must still be able to enter the owner.
  this.queue=result.catch(()=>{});return result;
 }
 private async expire(){for(const [path,file] of this.files)if(file.expiresAt<=this.now()){await rm(path,{force:true});this.files.delete(path);}}
 private schedule(retry=false){
  if(this.timer)clearTimeout(this.timer);
  if(this.closed||!this.files.size)return;
  const delay=retry?this.policy.snapshotTtlMs:Math.max(1,Math.min(this.policy.snapshotTtlMs,Math.min(...[...this.files.values()].map(file=>file.expiresAt))-this.now()));
  this.timer=setTimeout(()=>{void this.serialize(()=>this.expire()).then(()=>this.schedule(),error=>{this.report(error);this.schedule(true);});},delay);
  this.timer.unref();
 }
}
