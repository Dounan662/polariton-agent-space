import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import {Session,SessionId,SESSION_FORMAT_VERSION,type SessionEvent} from '@deepseek-ai/dsh-session';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {TokenMeter} from '@deepseek-ai/dsh-token-meter';
import * as SessionStats from '@deepseek-ai/dsh-session-stats';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {AssistantStreamAccumulator} from '@deepseek-ai/dsh-llm';
import {sessionMetrics} from '../harness/metrics.ts';
import {HarnessHistory} from '../harness/history.ts';
import {loadConfig} from '../src/config.ts';
import type {HistoryEvent,HistoryPage} from '../src/contracts.ts';
import {SourceObservation} from '../web/src/native/observation.ts';
import {SessionMetrics} from '../src/metrics.ts';
import {contextOccupancy} from '../web/src/native/client/ui-conversation/src/client/context-occupancy.ts';

const id=SessionId('metrics-fixture');
/** A reported request followed by an unbilled transport failure. */
function recorded():SessionEvent[]{
 const stream=new AssistantStreamAccumulator();
 stream.push({time:1200,chunk:{type:'text-delta',index:0,text:'Answer'}});
 return [
  {type:'turn/start',time:900,data:{turn:1}},
  {type:'request/context',time:950,data:{contextWindow:1000000}},
  {type:'step/start',time:1000,data:{turn:1,step:1}},
  {type:'assistant/message',time:2200,surfaceOp:'append',data:{turn:1,step:1,stream:stream.snapshot(),usage:{inputTokens:20,cacheReadTokens:80,cacheWriteTokens:0,outputTokens:50,totalTokens:150},message:{id:'answer',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Answer'}]}}},
  {type:'step/end',time:2300,data:{turn:1,step:1}},
  {type:'turn/end',time:2400,data:{turn:1,reason:{kind:'completed'}}},
  {type:'turn/start',time:3000,data:{turn:2}},
  {type:'step/start',time:3100,data:{turn:2,step:1}},
  {type:'assistant/attempt',time:3200,data:{turn:2,step:1,stream:[]}},
  {type:'step/end',time:3300,data:{turn:2,step:1}},
  {type:'turn/end',time:3400,data:{turn:2,reason:{kind:'failed'}}},
 ].map((event,seq)=>({...event,seq})) as SessionEvent[];
}
async function projections(events:SessionEvent[]){
 const ctx=new Context();try{
  await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(TokenMeter,{});await ctx.plugin(SessionStats);
  return sessionMetrics(ctx,Session.create(id,events));
 }finally{await ctx.fiber.dispose();}
}

test('DSH whole-session metrics retain reported usage across failed attempts and measure decode time',async()=>{
 const metrics=await projections(recorded());
 assert.deepEqual(metrics.tokenUsage,{uncachedInputTokens:20,cacheReadTokens:80,cacheWriteTokens:0,outputTokens:50});
 assert.deepEqual(metrics.sessionStats,{turns:2,steps:2,llmMs:1200,toolMs:0,ttftMs:200,ttftSteps:1,decodeMs:1000,decodeTokens:50});
 assert.equal(metrics.contextPressure.contextWindow,1000000);
 assert.equal(metrics.contextPressure.pressureTokens,100);
 assert.ok(metrics.contextBreakdown.messageTokens>0);
 assert.equal(contextOccupancy({projectedTokens:22000,contextWindow:1000000})?.percent,2);
 assert.equal(contextOccupancy({pressureTokens:22000}),null,'missing route capacity is not invented');
});

test('DSH retry accounting adds separately billed attempts without counting one sample twice',async()=>{
 const events=recorded().slice(0,3),stream=new AssistantStreamAccumulator();
 stream.push({time:1100,chunk:{type:'usage',usage:{inputTokens:5,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0}}});
 const retried=[...events,{type:'assistant/attempt',time:1150,data:{turn:1,step:1,stream:stream.snapshot()}},{type:'llm/retry-started',time:1160,data:{turn:1,step:1}},...recorded().slice(3)].map((e,seq)=>({...e,seq})) as SessionEvent[];
 assert.deepEqual((await projections(retried)).tokenUsage,{uncachedInputTokens:25,cacheReadTokens:80,cacheWriteTokens:0,outputTokens:52});
});

test('saved metrics use the complete read-only source cut, independent of page size and reader lifetime',async t=>{
 const root=await mkdtemp(join(tmpdir(),'polariton-metrics-')),worker={id:'worker',harnessSessionId:id};
 const config={...await loadConfig(),stateRoot:root,historyPageSize:2};const history=new HarnessHistory(config);
 t.after(async()=>{await history.close();await rm(root,{recursive:true,force:true});});
 const storage=join(root,'harness',worker.id,'sessions'),ctx=new Context();
 await ctx.plugin(JsonlSessionPersistence,{root:storage});
 const writer=await ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id,createdAt:900,isSeeded:false});
 await writer.append(recorded());await writer.flush();await writer.close();await ctx.fiber.dispose();
 const files=await readdir(storage,{recursive:true});const stored=files.filter(f=>f.endsWith('.zstd'));
 const before=await Promise.all(stored.map(f=>readFile(join(storage,f))));
 const page=await history.history(worker);assert.ok(page.before);assert.equal(page.metrics?.sessionStats.steps,2);
 assert.deepEqual(page.metrics,await projections(recorded()));
 const earlier=await history.history(worker,page.cut,page.before);assert.deepEqual(earlier.metrics,page.metrics);
 earlier.metrics!.tokenUsage.outputTokens=999;assert.equal((await history.history(worker,page.cut)).metrics!.tokenUsage.outputTokens,50);
 assert.deepEqual(await readdir(storage,{recursive:true}),files);
 assert.deepEqual(await Promise.all(stored.map(f=>readFile(join(storage,f)))),before,'reading metrics must never rewrite the source');
});

test('live metrics ignore replayed frames and older pages, replace on reconnect, and clear on session change',async()=>{
 const events=recorded() as HistoryEvent[],metrics=await projections(recorded());
 const page:HistoryPage={kind:'persisted',formatVersion:4,sourceSessionId:id,cut:'cut',events:events.slice(-2),attachments:[],before:9,coverage:'readable-persisted-prefix',total:events.length,metrics};
 const observation=new SourceObservation({project:'p',node:'n',workerId:'w'},()=>assert.fail('Unexpected repair'),100);
 observation.snapshot({generation:'first',page,assistantStream:{revision:0}});
 assert.deepEqual(observation.metrics,metrics);
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({...page,events:events.slice(0,-2),before:null});
 try{assert.equal(await observation.older(),true);}finally{globalThis.fetch=original;}
 assert.deepEqual(observation.metrics,metrics);
 const newer=structuredClone(metrics);newer.tokenUsage.outputTokens=75;
 const event:HistoryEvent={type:'session/end-seed',seq:events.length,time:4000,data:{}};
 const frame={generation:'first',sequence:1,kind:'event',event,metrics:newer};observation.accept(frame);observation.accept(frame);
 assert.equal(observation.metrics?.tokenUsage.outputTokens,75);
 observation.snapshot({generation:'second',page:{...page,metrics:newer},assistantStream:{revision:0}});
 observation.accept({...frame,metrics,sequence:2});assert.equal(observation.metrics?.tokenUsage.outputTokens,75);
 assert.throws(()=>observation.snapshot({generation:'invalid',page:{...page,metrics:{...newer,tokenUsage:{...newer.tokenUsage,outputTokens:-1}}},assistantStream:{revision:0}}));
 assert.equal(observation.metrics?.tokenUsage.outputTokens,75,'invalid input cannot damage the last readable metrics');
 observation.snapshot({generation:'empty',page:null,assistantStream:{revision:0}});assert.equal(observation.metrics,undefined);
 observation.dispose();
});

test('wire metrics reject non-finite durations and unsafe counts',async()=>{
 const metrics=await projections(recorded());
 assert.equal(SessionMetrics.safeParse({...metrics,sessionStats:{...metrics.sessionStats,llmMs:Infinity}}).success,false);
 assert.equal(SessionMetrics.safeParse({...metrics,tokenUsage:{...metrics.tokenUsage,outputTokens:Number.MAX_SAFE_INTEGER+1}}).success,false);
});
