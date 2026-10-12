import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HarnessHistory} from '../harness/history.ts';
import {loadConfig} from '../src/config.ts';
import {persistHistory} from './fixtures/history.mjs';

const first={id:'first',harnessSessionId:'first-session'};
const second={id:'second',harnessSessionId:'second-session'};
const events=(text='original')=>[
  {type:'user/message',seq:0,time:1,data:{source:{rpcId:'request'},content:[{type:'text',text}]}},
  {type:'turn/end',seq:1,time:2,data:{reason:'completed'}},
];
const expired=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='HISTORY_CUT_EXPIRED';

test('unchanged observations share an immutable source without evicting another worker',async t=>{
  const history=new HarnessHistory({...await loadConfig(),maxHistoryCuts:2,historyPageSize:1});
  t.after(()=>history.close());
  const source=events(),cut=history.retain(first,source),other=history.retain(second,events());
  for(let i=0;i<6;i++)assert.equal(history.retain(second,events()),other);
  source[0]!.data.content![0]!.text='caller mutation';
  const older=await history.history(first,cut,1);
  assert.deepEqual(older.events,events().slice(0,1));
  (older.events[0]!.data as {content:{text:string}[]}).content[0]!.text='page mutation';
  assert.deepEqual((await history.history(first,cut,1)).events,events().slice(0,1));
  assert.equal(history.retain(first,events()),cut);
});

test('complete source content and worker session identity determine cut reuse',async t=>{
  const history=new HarnessHistory({...await loadConfig(),maxHistoryCuts:4});
  t.after(()=>history.close());
  const original=history.retain(first,events()),replacement=history.retain(first,events('replacement'));
  assert.notEqual(replacement,original,'same event count and sequence can carry a source replacement');
  assert.deepEqual((await history.history(first,original)).events,events());
  const otherSession={...first,harnessSessionId:'new-session'};
  assert.notEqual(history.retain(otherSession,events()),original);
  await assert.rejects(history.history(second,original),expired);
  await assert.rejects(history.history(otherSession,original),expired);
  assert.throws(()=>history.applied(otherSession,original),expired);
  await assert.rejects(history.attachment(otherSession,original,0,0),expired);
});

test('capacity evicts the least recently used source and expired cursors recover with a new cut',async t=>{
  const history=new HarnessHistory({...await loadConfig(),maxHistoryCuts:2});
  t.after(()=>history.close());
  const original=history.retain(first,events()),idle=history.retain(second,events());
  await history.history(first,original,1);
  history.retain(second,events('new source'));
  assert.deepEqual((await history.history(first,original)).events,events());
  await assert.rejects(history.history(second,idle),expired);
  const recovered=history.retain(second,events());
  assert.notEqual(recovered,idle);
  assert.deepEqual((await history.history(second,recovered)).events,events());
});

test('cut reuse preserves fixed expiry and retention removes expired sources before valid ones',async t=>{
  const history=new HarnessHistory({...await loadConfig(),maxHistoryCuts:2,historyCutTtlMs:10});
  t.after(()=>history.close());
  t.mock.timers.enable({apis:['Date'],now:100});
  const old=history.retain(first,events());
  t.mock.timers.setTime(105);
  const current=history.retain(second,events());
  assert.equal(history.retain(first,events()),old);
  t.mock.timers.setTime(110);
  await assert.rejects(history.history(first,old),expired);
  assert.throws(()=>history.applied(first,old),expired);
  const renewed=history.retain(first,events());
  assert.notEqual(renewed,old);
  assert.deepEqual((await history.history(second,current)).events,events());
});

test('fresh cold reads reuse unchanged persisted cuts and preserve another worker cursor',async t=>{
  const root=await mkdtemp(join(tmpdir(),'polariton-history-cuts-'));
  const history=new HarnessHistory({...await loadConfig(),stateRoot:root,maxHistoryCuts:2,historyPageSize:2});
  t.after(async()=>{await history.close();await rm(root,{recursive:true,force:true});});
  const fixture=await persistHistory(join(root,'harness',first.id,'sessions'),first.harnessSessionId);
  const initial=await history.history(first),other=history.retain(second,events());
  for(let i=0;i<4;i++)assert.equal((await history.history(first)).cut,initial.cut);
  assert.deepEqual((await history.history(second,other)).events,events());
  assert.deepEqual((await history.history(first,initial.cut,initial.before!)).events,fixture.events.slice(-4,-2));
});
