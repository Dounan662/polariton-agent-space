import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IdleWorkers,type IdleClock} from '../src/idle-workers.ts';

/** A monotonic scheduling neighbor: tests advance deadlines without wall time or sleeps. */
class Clock implements IdleClock {
 time=0;
 private sequence=0;
 private tasks=new Map<number,{at:number;run:()=>void}>();
 now(){return this.time;}
 schedule(run:()=>void,delayMs:number){const id=++this.sequence;this.tasks.set(id,{at:this.time+delayMs,run});return ()=>{this.tasks.delete(id);};}
 advance(ms:number){this.time+=ms;for(const [id,task] of this.tasks)if(task.at<=this.time){this.tasks.delete(id);task.run();}}
 fireEarly(){const first=this.tasks.entries().next().value;assert.ok(first);this.tasks.delete(first[0]);first[1].run();}
 get pending(){return this.tasks.size;}
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

test('idle attempts require one continuous eligible revision; reads do not reset its deadline',async()=>{
 const clock=new Clock(),attempts:{id:string;revision:number}[]=[];
 const idle=new IdleWorkers(100,async(id,revision)=>{attempts.push({id,revision});},()=>assert.fail('Unexpected timer failure'),clock);
 idle.observe('worker',1,true);clock.advance(60);idle.observe('worker',1,true);
 clock.advance(39);assert.deepEqual(attempts,[]);clock.advance(1);
 assert.deepEqual(attempts,[{id:'worker',revision:1}]);
 await settle();idle.close();assert.equal(clock.pending,0);
});

test('new activity generations and blockers invalidate prior inactivity without affecting other workers',async()=>{
 const clock=new Clock(),attempts:string[]=[];
 const idle=new IdleWorkers(100,async(id,revision)=>{attempts.push(`${id}:${revision}`);},()=>assert.fail('Unexpected timer failure'),clock);
 idle.observe('a',1,true);idle.observe('b',1,true);clock.advance(50);
 idle.observe('a',2,true);clock.advance(50);assert.deepEqual(attempts,['b:1']);
 idle.observe('a',2,false);clock.advance(50);assert.deepEqual(attempts,['b:1']);
 idle.observe('a',3,true);clock.advance(99);assert.deepEqual(attempts,['b:1']);clock.advance(1);assert.deepEqual(attempts,['b:1','a:3']);
 await settle();idle.close();
});

test('disabled policy schedules nothing and early timers recheck monotonic elapsed time',async()=>{
 const clock=new Clock();let attempts=0;
 const disabled=new IdleWorkers(null,async()=>{attempts++;},()=>assert.fail(),clock);
 disabled.observe('worker',1,true);clock.advance(1000);assert.equal(clock.pending,0);assert.equal(attempts,0);disabled.close();
 const idle=new IdleWorkers(100,async()=>{attempts++;},()=>assert.fail(),clock);
 idle.observe('worker',1,true);clock.advance(20);clock.fireEarly();assert.equal(attempts,0);assert.equal(clock.pending,1);
 clock.advance(79);assert.equal(attempts,0);clock.advance(1);assert.equal(attempts,1);
 await settle();idle.close();
});

test('failed attempts are observable and retry only after another full idle interval',async()=>{
 const clock=new Clock(),error=new Error('Reservation failed'),failures:{id:string;error:unknown}[]=[];let attempts=0;
 const idle=new IdleWorkers(100,async()=>{attempts++;throw error;},(id,error)=>{failures.push({id,error});},clock);
 idle.observe('worker',7,true);clock.advance(100);await settle();
 assert.equal(attempts,1);assert.deepEqual(failures,[{id:'worker',error}]);
 clock.advance(99);assert.equal(attempts,1);clock.advance(1);await settle();assert.equal(attempts,2);assert.equal(failures.length,2);
 idle.close();
});

test('closing or blocking an outstanding attempt prevents its completion from rearming a timer',async()=>{
 for(const stop of ['close','blocked'] as const){
  const clock=new Clock();let complete!:()=>void;let attempts=0;
  const idle=new IdleWorkers(100,()=>{attempts++;return new Promise<void>(resolve=>{complete=resolve;});},()=>assert.fail(),clock);
  idle.observe('worker',1,true);clock.advance(100);assert.equal(attempts,1);
  if(stop==='close')idle.close();else idle.observe('worker',2,false);
  complete();await settle();clock.advance(1000);assert.equal(attempts,1);assert.equal(clock.pending,0);idle.close();
 }
});

test('completion of an old attempt cannot move the newer inactivity deadline',async()=>{
 const clock=new Clock();let complete!:()=>void;const revisions:number[]=[];
 const idle=new IdleWorkers(100,(_id,revision)=>{revisions.push(revision);return revision===1?new Promise<void>(resolve=>{complete=resolve;}):Promise.resolve();},()=>assert.fail(),clock);
 idle.observe('worker',1,true);clock.advance(100);
 clock.advance(20);idle.observe('worker',2,true);clock.advance(30);complete();await settle();
 clock.advance(69);assert.deepEqual(revisions,[1]);clock.advance(1);assert.deepEqual(revisions,[1,2]);
 await settle();idle.close();
});
