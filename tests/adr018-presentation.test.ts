import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ToolCallId} from '@deepseek-ai/dsh-llm/brand';
import {createToolResultMessage} from '@deepseek-ai/dsh-llm';
import {compactCheckpointSource,CompactionId} from '@deepseek-ai/dsh-compaction';
import {observeWorker} from '../web/src/native/presentation.ts';
import {SourceObservation} from '../web/src/native/observation.ts';
import type {HistoryEvent,HistoryPage} from '../src/contracts.ts';
import type {ChatSnapshot} from '../web/src/native/client/ui-chat/src/client/contract/snapshot.ts';
import type {ChatNode} from '../web/src/native/client/ui-chat/src/client/contract/chat-nodes.ts';
import type {TrajectorySnapshot} from '../web/src/native/client/ui-trajectory/src/client/trajectory-contract.ts';
const scope={project:'project',node:'node',workerId:'worker'};
const event=(seq:number,type:string,data:unknown,surfaceOp?:unknown):HistoryEvent=>({seq,time:1000+seq,type,data,...surfaceOp?{surfaceOp}:{}});
const page=(events:HistoryEvent[]):HistoryPage=>({kind:'persisted',formatVersion:4,sourceSessionId:'format-four',events,attachments:[],cut:'cut',before:null,coverage:'readable-persisted-prefix',total:events.length});
test('public presenter preserves unknown non-surface evidence and recognizes only user submission identities',()=>{
 const observation=observeWorker(scope,()=>assert.fail('No repair needed'),100);
 const events=[event(0,'turn/start',{turn:1}),event(1,'user/message',{id:'user',role:'user',source:{kind:'user',rpcId:'submission'},content:[{type:'text',text:'Question'}]},'append'),event(2,'extension/future-record',{nested:{complete:['payload',42]},rpcId:'not-a-user'})];
 observation.snapshot({generation:'first',page:page(events),assistantStream:{revision:0}});
 assert.deepEqual(observation.inspectSource(),page(events));
 assert.deepEqual([...observation.recordedSubmissions()],['submission']);
 observation.accept({generation:'retired',sequence:1,kind:'event',event:event(3,'extension/late',{ignored:true})});
 assert.deepEqual(observation.inspectSource()!.events,events);
});
test('format 4 flattened tool results retain complete contents and failure state in chat and trajectory',()=>{
 const observation=new SourceObservation(scope,()=>assert.fail('No repair needed'),100);
 const content=[{type:'text' as const,text:'Full tool failure detail'}];
 const message=createToolResultMessage({callId:ToolCallId('tool'),content,isError:true});
 observation.snapshot({generation:'first',assistantStream:{revision:0},page:page([event(0,'turn/start',{turn:1}),event(1,'step/start',{turn:1,step:1}),event(2,'tool/call',{turn:1,step:1,callId:'tool',name:'inspect',arguments:'{}'}),event(3,'tool/result',{turn:1,step:1,message},'append')])});
 const chat=observation.engine.snapshot('chat') as ChatSnapshot;
 const tool=[...chat.nodes.values()].find(node=>(node as ChatNode).kind==='tool-call') as ChatNode<'tool-call'>;
 assert.ok('kind' in tool.data.root&&tool.data.root.kind==='tool-result');
 assert.deepEqual(tool.data.root.content,content);assert.equal(tool.data.root.isError,true);
 const trajectory=observation.engine.snapshot('trajectory') as TrajectorySnapshot;
 const result=trajectory.eventNodes.find(node=>node.kind==='tool-result');assert.ok(result);assert.deepEqual(result.content,content);assert.equal(result.isError,true);
});
test('format 4 checkpoint source correlates automatic compaction without a synthetic user message',()=>{
 const observation=new SourceObservation(scope,()=>assert.fail('No repair needed'),100),compactionId=CompactionId('compact-fixture');
 const events=[event(0,'turn/start',{turn:1}),event(1,'compaction/start',{compactionId,turn:1}),event(2,'compaction/summary',{compactionId,summary:[{type:'text',text:'Summary'}],shadowedSeqs:[],shadowedTokenCount:0}),event(3,'user/message',{id:'checkpoint',role:'user',source:compactCheckpointSource(compactionId),content:[{type:'text',text:'Summary'}]},{op:'replace',startSeq:0,endSeq:0}),event(4,'compaction/end',{compactionId,turn:1})];
 observation.snapshot({generation:'first',assistantStream:{revision:0},page:page(events)});
 const chat=observation.engine.snapshot('chat') as ChatSnapshot;
 assert.ok([...chat.nodes.values()].some(node=>(node as ChatNode).kind==='compaction'));
 assert.equal([...chat.nodes.values()].some(node=>(node as ChatNode).kind==='user'),false);
 assert.deepEqual(observation.inspectSource()!.events,events);
});

// The public transport accepts opaque bytes, but invalid current-generation
// source grammar cannot reach the projection or replace readable evidence.
test('opaque stream envelopes are decoded inside the presenter boundary',()=>{
 const observation=observeWorker(scope,()=>assert.fail('No repair needed'),100),events=[event(0,'turn/start',{turn:1})];
 observation.snapshot({generation:'first',page:page(events),assistantStream:{revision:0}});
 assert.doesNotThrow(()=>observation.accept({generation:'retired',sequence:1,kind:'stream',frame:{type:'unknown'}}));
 assert.throws(()=>observation.accept({generation:'first',sequence:1,kind:'stream',frame:{type:'chunk',revision:1,attemptId:'a',index:-1,time:1,chunk:null}}));
 assert.deepEqual(observation.inspectSource()!.events,events);
 assert.throws(()=>observation.snapshot({generation:'next',page:page([]),assistantStream:{revision:'invalid'}}));
 assert.deepEqual(observation.inspectSource()!.events,events);
});

// Resolving a replacement's older endpoints can either dismiss a provisional
// prompt header or confirm a real removal. Pagination must agree with full replay.
for (const removesSystem of [false, true]) {
  test(`trajectory pagination resolves provisional prompt headers (removesSystem=${removesSystem})`, async t => {
    const observation = new SourceObservation(scope, () => assert.fail('No repair needed'), 100);
    const fresh = new SourceObservation(scope, () => assert.fail('No repair needed'), 100);
    t.after(() => { observation.dispose(); fresh.dispose(); });
    const config = { provider: 'synthetic', model: 'fixture' };
    const tools = [{ name: 'inspect', description: 'Inspect a value', parameters: { type: 'object' } }];
    const result = (callId: string) => createToolResultMessage({
      callId: ToolCallId(callId), content: [{ type: 'text', text: 'Inspected value' }], isError: false,
    });
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'step/start', { turn: 1, step: 1 }),
      event(2, 'system/message', { turn: 1, step: 1, message: { id: 'system', role: 'system',
        source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Retained system instructions' }] } }, 'append'),
      event(3, 'request/header', { reason: 'initial', header: { config, tools } }),
      event(4, 'tool/call', { turn: 1, step: 1, callId: 'first', name: 'inspect', arguments: '{}' }),
      event(5, 'tool/result', { turn: 1, step: 1, message: result('first') }, 'append'),
      event(6, 'step/end', { turn: 1, step: 1 }),
      event(7, 'step/start', { turn: 1, step: 2 }),
      event(8, 'request/header', { reason: 'config-changed', header: { config, tools } }),
      removesSystem
        ? event(9, 'user/message', { id: 'checkpoint', role: 'user', source: compactCheckpointSource(CompactionId('pagination')),
          content: [{ type: 'text', text: 'Earlier context summary' }] }, { op: 'replace', startSeq: 2, endSeq: 5 })
        : event(9, 'tool/result', { turn: 1, step: 1, message: result('first') }, { op: 'replace', startSeq: 5, endSeq: 5 }),
      event(10, 'tool/call', { turn: 1, step: 2, callId: 'second', name: 'inspect', arguments: '{}' }),
      event(11, 'tool/result', { turn: 1, step: 2, message: result('second') }, 'append'),
      event(12, 'assistant/message', { turn: 1, step: 2, stream: [], message: { id: 'answer', role: 'assistant',
        source: { kind: 'model', ...config }, content: [{ type: 'text', text: 'Finished inspection' }] } }, 'append'),
      event(13, 'step/end', { turn: 1, step: 2 }),
      event(14, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ];
    const cut = (start: number, end: number): HistoryPage => ({
      ...page(events.slice(start, end)), before: start || null, total: events.length,
    });
    observation.snapshot({ generation: 'paged', page: cut(7, events.length), assistantStream: { revision: 0 } });
    const initial = observation.engine.snapshot('trajectory') as TrajectorySnapshot;
    const initialRequest = initial.requests.find(request => request.purpose === 'assistant' && request.step === 2);
    assert.ok(initialRequest?.purpose === 'assistant');
    assert.equal(initialRequest.prompt?.system, '');
    const pages = [cut(2, 7), cut(0, 2)];
    t.mock.method(globalThis, 'fetch', async () => { const next = pages.shift(); assert.ok(next); return Response.json(next); });
    for (let remaining = pages.length; remaining > 0; remaining--) {
      assert.equal(await observation.older(), true, observation.error);
      assert.equal(observation.error, '');
    }
    assert.equal(observation.hasMore, false);
    assert.deepEqual(observation.inspectSource()!.events, events);
    const trajectory = observation.engine.snapshot('trajectory') as TrajectorySnapshot;
    const request = trajectory.requests.find(request => request.purpose === 'assistant' && request.step === 2);
    assert.ok(request?.purpose === 'assistant');
    assert.equal(request.prompt?.system, removesSystem ? '' : 'Retained system instructions');
    assert.equal(request.promptChange?.seq === 9, removesSystem, 'only a real prompt removal remains a change');
    assert.deepEqual(trajectory.callSchemas.get('second'), tools[0]);
    fresh.snapshot({ generation: 'full', page: cut(0, events.length), assistantStream: { revision: 0 } });
    // Location handles own subscriptions; compare the public ledger and request facts.
    const { eventLocations: pagedLocations, ...pagedFacts } = trajectory;
    const { eventLocations: fullLocations, ...fullFacts } = fresh.engine.snapshot('trajectory') as TrajectorySnapshot;
    assert.deepEqual(pagedFacts, fullFacts);
    assert.deepEqual([...pagedLocations.keys()], [...fullLocations.keys()]);
  });
}
