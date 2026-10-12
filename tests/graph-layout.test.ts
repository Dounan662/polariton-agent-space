import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GraphLayout,type LayoutLocks} from '../web/src/graph-layout.ts';

function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},clear:()=>values.clear()};}
function locks():LayoutLocks {
  const held=new Map<string,Promise<void>>();
  return {async request(name,options,callback){
    const previous=held.get(name);
    if(previous){if(options.ifAvailable)return callback(false);await previous;return this.request(name,options,callback);}
    let release!:()=>void;held.set(name,new Promise<void>(resolve=>{release=resolve;}));
    try{return await callback(true);}finally{held.delete(name);release();}
  }};
}
const placement=(id:string,x:number,y:number)=>({id,position:{x,y}});
function fixture(){const saved=storage(),mutex=locks();let revision=0;const owner=(project='project-a')=>new GraphLayout(saved,project,mutex,()=>`revision-${++revision}`);return {saved,owner};}

test('worker and human positions persist together without changing the saved camera',async()=>{
  const {owner}=fixture(),first=owner();
  const before=await first.inspect(['first','second']);
  await first.move([placement('first',-120,42),placement('second',350,96)],before.revision,'worker-request',4);
  await first.setViewport({x:75,y:-38,zoom:0.7});
  const drag=first.beginDrag();first.endDrag([placement('first',30,60)]);await drag;
  const reopened=owner();
  assert.deepEqual(reopened.positions(['first']).first,{x:30,y:60});
  assert.deepEqual(reopened.positions(['second']).second,{x:350,y:96});
  assert.deepEqual(reopened.viewport,{x:75,y:-38,zoom:0.7});
  assert.notDeepEqual(owner('other').positions(['first']).first,{x:30,y:60});
  assert.equal(owner('other').viewport,undefined);
});

test('existing local positions and viewport are preserved when worker access initializes its revision',async()=>{
  const {saved,owner}=fixture();
  saved.setItem('polariton.graph.project-a',JSON.stringify({positions:{a:{x:8,y:9}},viewport:{x:1,y:2,zoom:0.7}}));
  const view=await owner().inspect(['a']);
  assert.deepEqual(view.positions.a,{x:8,y:9});assert.notEqual(view.revision,'0');
  assert.deepEqual(owner().viewport,{x:1,y:2,zoom:0.7});
});

test('human dragging excludes worker reads and moves in every tab then makes prior edits stale',async()=>{
  const {owner}=fixture(),human=owner(),worker=owner(),before=await worker.inspect(['a','b']);
  const drag=human.beginDrag();
  await assert.rejects(worker.move([placement('a',100,100)],before.revision,'r',4),{code:'CANVAS_BUSY'});
  await assert.rejects(human.inspect(['a']),{code:'CANVAS_BUSY'});
  await assert.rejects(worker.inspect(['a']),{code:'CANVAS_BUSY'});
  human.endDrag([placement('b',20,30)]);await drag;
  await assert.rejects(worker.move([placement('a',100,100)],before.revision,'r',4),{code:'CANVAS_STALE'});
  assert.deepEqual(worker.positions(['b']).b,{x:20,y:30});
  const now=await worker.inspect(['a','b']);await worker.move([placement('a',100,100)],now.revision,'r',4);
  assert.deepEqual(human.positions(['a']).a,{x:100,y:100});
});

test('atomic batch retries never undo subsequent human edits and changed retries fail',async()=>{
  const {owner}=fixture(),layout=owner(),before=await layout.inspect(['a','b']);
  const positions=[placement('a',10,20),placement('b',30,40)];
  const accepted=await layout.move(positions,before.revision,'r',4);
  const drag=layout.beginDrag();layout.endDrag([placement('a',90,90)]);await drag;
  assert.equal(await owner().move(positions,before.revision,'r',4),accepted);
  assert.deepEqual(layout.positions(['a']).a,{x:90,y:90});
  await assert.rejects(layout.move([placement('a',1,2)],before.revision,'r',4),{code:'REQUEST_ID_CONFLICT'});
  await assert.rejects(layout.move([placement('a',1,2),placement('b',NaN,2)],layout.revision,'invalid',4));
  assert.deepEqual(layout.positions(['a']).a,{x:90,y:90});
});

test('viewport updates neither invalidate worker edits nor overwrite positions from another tab',async()=>{
  const {owner}=fixture(),first=owner(),second=owner(),before=await first.inspect(['a']);
  await second.setViewport({x:1,y:2,zoom:0.8});assert.equal(first.revision,before.revision);
  await first.move([placement('a',50,70)],before.revision,'r',4);
  await second.setViewport({x:3,y:4,zoom:0.9});
  assert.deepEqual(first.positions(['a']).a,{x:50,y:70});assert.deepEqual(first.viewport,{x:3,y:4,zoom:0.9});
});

test('storage reset and receipt eviction cannot admit stale retries',async()=>{
  const {saved,owner}=fixture(),layout=owner(),initial=await layout.inspect(['a']);
  saved.clear();
  await assert.rejects(layout.move([placement('a',1,1)],initial.revision,'r',1),{code:'CANVAS_STALE'});
  const fresh=await layout.inspect(['a']);const next=await layout.move([placement('a',1,1)],fresh.revision,'r1',1);
  await layout.move([placement('a',2,2)],next,'r2',1);
  await assert.rejects(layout.move([placement('a',1,1)],fresh.revision,'r1',1),{code:'CANVAS_STALE'});
});

test('cancelled drag releases exclusion, and an expired worker operation cannot mutate',async()=>{
  const {owner}=fixture(),layout=owner(),before=await layout.inspect(['a']);
  const drag=layout.beginDrag();layout.endDrag(null);await drag;
  assert.equal(layout.revision,before.revision);
  await assert.rejects(layout.move([placement('a',1,1)],before.revision,'r',4,()=>{throw new Error('expired');}),/expired/);
  assert.equal(layout.revision,before.revision);
  await layout.move([placement('a',2,2)],before.revision,'valid',4);
});

test('malformed presentation resets without contaminating other projects',async()=>{
  const {saved,owner}=fixture();
  for(const value of ['broken JSON','null','{"positions":{"a":{"x":null,"y":4}}}','{"positions":{},"viewport":{"x":0,"y":0,"zoom":0}}']){
    saved.setItem('polariton.graph.project-a',value);const graph=owner();
    assert.equal(graph.viewport,undefined);const state=await graph.inspect(['a']);
    await graph.move([placement('a',1,2)],state.revision,'r',4);
    assert.deepEqual(owner().positions(['a']).a,{x:1,y:2});
  }
});

test('storage failures remain observable and never return a successful receipt',async()=>{
  const layout=new GraphLayout({getItem:()=>null,setItem:()=>{throw new Error('Storage unavailable');}},'project',locks());
  await assert.rejects(layout.inspect(['node']),/Storage unavailable/);
  await assert.rejects(layout.move([placement('node',1,2)],'0','r',4),/Storage unavailable/);
  await assert.rejects(layout.setViewport({x:0,y:0,zoom:1}),/Storage unavailable/);
});
