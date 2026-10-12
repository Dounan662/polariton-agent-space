import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HistoryDemand, readingPosition} from '../web/src/native/conversation-history.ts';
function fixture(limit=3) {
 const work=new Set<()=>void>();
 let finish:(value:boolean)=>void=()=>{},requests=0;
 const reader={status:'ready' as 'ready'|'connecting'|'error',error:'',hasMore:true,loadingOlder:false,
  older:()=>{requests++;reader.loadingOlder=true;return new Promise<boolean>(resolve=>{finish=value=>{reader.loadingOlder=false;resolve(value);};});}};
 const demand=new HistoryDemand(reader,limit,callback=>{work.add(callback);return()=>{work.delete(callback);};});
 return {reader,demand,get requests(){return requests;},get queued(){return work.size;},run(){for(const callback of [...work]){work.delete(callback);callback();}},async finish(value=true){finish(value);await Promise.resolve();}};
}
test('viewport demand serializes pages, yields between hidden-only pages and latches its budget',async()=>{
 const f=fixture();f.demand.update(true,true);assert.equal(f.requests,0);f.run();assert.equal(f.requests,1);
 f.demand.update(true,true);f.run();assert.equal(f.requests,1);
 await f.finish();assert.equal(f.requests,1);f.run();await f.finish();f.run();await f.finish();
 assert.equal(f.requests,3);assert.match(f.demand.getSnapshot()!,/budget/);
 for(let i=0;i<10;i++)f.demand.update(true,true);
 f.run();assert.equal(f.requests,3);
 f.demand.retry();f.run();assert.equal(f.requests,4);f.demand.dispose();await f.finish();assert.equal(f.queued,0);
});
test('hidden, disposed and satisfied viewports cannot continue a pagination chain',async()=>{
 for(const stop of ['hidden','disposed','satisfied']){
  const f=fixture();f.demand.update(true,true);f.run();
  if(stop==='disposed')f.demand.dispose();else f.demand.update(stop!=='hidden',stop!=='satisfied');
  await f.finish();f.run();assert.equal(f.requests,1,stop);
 }
});
test('read failures and no-progress results need explicit retry, while cut rebaseline waits for readiness',async()=>{
 const f=fixture();f.demand.update(true,true);f.run();f.reader.error='Read failed';await f.finish(false);
 assert.match(f.demand.getSnapshot()!,/Read failed/);f.demand.update(true,true);f.run();assert.equal(f.requests,1);
 f.demand.retry();f.run();assert.equal(f.requests,2);f.reader.error='';await f.finish();
 f.run();f.reader.status='connecting';await f.finish(false);assert.equal(f.demand.getSnapshot(),null);assert.equal(f.queued,0);
 f.reader.status='ready';f.demand.update(true,true);assert.equal(f.queued,1);
 f.run();await f.finish(false);assert.match(f.demand.getSnapshot()!,/progress/);
});
test('an exception is visible and cannot become a background retry loop',async()=>{
 const jobs:Array<()=>void>=[];
 const demand=new HistoryDemand({status:'ready',error:'',hasMore:true,loadingOlder:false,older:async()=>{throw new Error('offline');}},3,job=>{jobs.push(job);return()=>{};});
 demand.update(true,true);jobs.shift()!();await Promise.resolve();await Promise.resolve();
 assert.match(demand.getSnapshot()!,/offline/);demand.update(true,true);assert.equal(jobs.length,0);demand.dispose();
});
test('bookmarks accept semantic identity and reject malformed browser storage',()=>{
 const value={key:'submission:one',offset:-23.5,atBottom:false};assert.deepEqual(readingPosition(JSON.stringify(value)),value);
 for(const text of [null,'','null','{}','{"key":"x","offset":"0","atBottom":false}','{"key":"x","offset":1e999,"atBottom":false}'])assert.equal(readingPosition(text),null);
});

test('another source reader can take admission before a queued viewport request',()=>{
 const f=fixture();f.demand.update(true,true);f.reader.loadingOlder=true;f.run();
 assert.equal(f.requests,0);assert.equal(f.demand.getSnapshot(),null);
 f.reader.loadingOlder=false;f.demand.update(true,true);f.run();assert.equal(f.requests,1);f.demand.dispose();
});
