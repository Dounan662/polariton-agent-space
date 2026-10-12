/** Time is injected as one scheduling boundary so elapsed inactivity never depends
 * on wall-clock adjustments or on how often a client reads worker state. */
export interface IdleClock {
 now():number;
 schedule(task:()=>void,delayMs:number):()=>void;
}
export const idleClock:IdleClock={now:()=>performance.now(),schedule(task,delay){const timer=setTimeout(task,delay);timer.unref();return ()=>clearTimeout(timer);}};

/** Watches continuous inactivity generations. Execution reservations belong to the
 * harness; this owner only schedules an attempt after an unchanged eligible interval. */
export class IdleWorkers {
 private entries=new Map<string,{revision:number;since:number;cancel:()=>void}>();
 private timeout:number|null;
 private attempt:(id:string,revision:number)=>Promise<void>;
 private failure:(id:string,error:unknown)=>void;
 private clock:IdleClock;
 constructor(timeout:number|null,attempt:(id:string,revision:number)=>Promise<void>,failure:(id:string,error:unknown)=>void,clock:IdleClock=idleClock){this.timeout=timeout;this.attempt=attempt;this.failure=failure;this.clock=clock;}
 observe(id:string,revision:number,eligible:boolean){
  const prior=this.entries.get(id);
  if(this.timeout===null||!eligible){this.forget(id);return;}
  if(prior?.revision===revision)return;
  this.forget(id);
  const entry={revision,since:this.clock.now(),cancel:()=>{}};
  this.entries.set(id,entry);
  const fire=()=>{
   if(this.entries.get(id)!==entry)return;
   const remaining=this.timeout!-(this.clock.now()-entry.since);
   if(remaining>0){entry.cancel=this.clock.schedule(fire,remaining);return;}
   void this.attempt(id,revision).catch(error=>this.failure(id,error)).finally(()=>{
    if(this.entries.get(id)===entry){this.entries.delete(id);this.observe(id,revision,true);}
   });
  };
  entry.cancel=this.clock.schedule(fire,this.timeout);
 }
 forget(id:string){const entry=this.entries.get(id);entry?.cancel();this.entries.delete(id);}
 close(){for(const id of this.entries.keys())this.forget(id);}
}
