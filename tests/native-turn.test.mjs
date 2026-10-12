import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {nativeTurn} from '../scripts/native-turn.mjs';

function harness() {
  const h=new EventEmitter();h.config={requestTimeoutMs:1000};
  h.message=async(sessionId,requestId,content)=>{h.input={sessionId,requestId,content};return {messageId:requestId};};
  return h;
}
const ended=(h,turn,reason={kind:'completed'})=>h.emit('turn',{sessionId:'worker',phase:'ended',id:String(turn),reason});

test('verification completion follows the claimed turn, independently of admission and unrelated turns',async()=>{
  const h=harness();let completed=false;const result=nativeTurn(h,'worker','hello',h.config.requestTimeoutMs).then(value=>{completed=true;return value;});
  await Promise.resolve();assert.equal(completed,false);
  h.emit('turn',{sessionId:'worker',phase:'claimed',requestId:h.input.requestId,id:'3'});
  ended(h,2);await Promise.resolve();assert.equal(completed,false);
  ended(h,3);assert.deepEqual(await result,{reason:{kind:'completed'}});
});

test('verification preserves blocked outcomes and observes discarded input as failure',async()=>{
  const h=harness(),blocked=nativeTurn(h,'worker','blocked',h.config.requestTimeoutMs);
  h.emit('turn',{sessionId:'worker',phase:'claimed',requestId:h.input.requestId,id:'1'});ended(h,1,{kind:'blocked'});
  assert.equal((await blocked).reason.kind,'blocked');
  const discarded=nativeTurn(h,'worker','cancelled',h.config.requestTimeoutMs);h.emit('submission',{sessionId:'worker',requestId:h.input.requestId,state:'interrupted'});
  await assert.rejects(discarded,/discarded/);
});

test('verification transport failure and timeout release observers',async t=>{
  const h=harness(),lost=nativeTurn(h,'worker','lost',h.config.requestTimeoutMs);h.emit('transportError',new Error('closed'));
  await assert.rejects(lost,/closed/);assert.equal(h.eventNames().length,0);
  t.mock.timers.enable({apis:['setTimeout']});
  const timed=nativeTurn(h,'worker','timeout',h.config.requestTimeoutMs);t.mock.timers.tick(h.config.requestTimeoutMs);
  await assert.rejects(timed,/request budget/);assert.equal(h.eventNames().length,0);
});
