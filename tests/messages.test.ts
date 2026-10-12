import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationRows,messageRows,messageStatus} from '../web/src/native/receipts.ts';
import {canSendMessage,saveOutgoing,restoreOutgoing,recoverOutgoing,type Outgoing,type MessageRequest} from '../web/src/messages.ts';
import {SourceObservation as WorkerObservation} from '../web/src/native/observation.ts';
import type {ChatSnapshot} from '../web/src/native/client/ui-chat/src/client/contract/snapshot.ts';
import type {ChatNode} from '../web/src/native/client/ui-chat/src/client/contract/chat-nodes.ts';
import type {HistoryEvent,Submission} from '../src/contracts.ts';
import {submissionContent} from '../src/contracts.ts';
const outgoing=(id='message-a'):Outgoing&{request:MessageRequest}=>({createdAt:1000,request:{id,text:'Same text',content:[{type:'text',text:'Same text'},{type:'image',attachmentId:'22222222-2222-4222-8222-222222222222'}]}});
const receipt=(state:Submission['state']='pending',id='message-a'):Submission=>({id,kind:'message',text:'Same text',state,attempts:[{at:1001,state}],content:outgoing(id).request.content});
const event=(seq:number,type:string,data:unknown):HistoryEvent=>({seq,time:1000+seq,type,data,...type==='user/message'?{surfaceOp:'append'}:{}});
const user=(seq:number,id:string,rpcId?:string)=>event(seq,'user/message',{id,role:'user',source:{kind:'user',...rpcId?{rpcId}:{}},content:[{type:'text',text:'Same text'}]});

test('ordinary conversation rows retain the worker header without receipts or a sender component',()=>{
 const admitted:Submission={...receipt('admitted'),sender:{id:'11111111-1111-4111-8111-111111111111',name:'Reviewer'}};
 const content=submissionContent(admitted),original=structuredClone(admitted.content);
 assert.deepEqual(content.slice(1),original);
 assert.deepEqual(submissionContent(admitted),content,'Repeated projection never duplicates the header');
 assert.deepEqual(admitted.content,original,'Original intent remains unchanged');
 assert.deepEqual(submissionContent(receipt()),original,'Human content remains unchanged');
 assert.deepEqual(submissionContent({text:'',content:[original![1]!],sender:admitted.sender}).map(part=>part.type),['text','image']);
 const source=event(1,'user/message',{id:'native',role:'user',source:{kind:'polariton-worker',workerId:admitted.sender!.id,rpcId:admitted.id},content});
 const pending=messageRows([],[admitted],[]),recorded=nodes([event(0,'turn/start',{turn:1}),source]);
 const rows=messageRows(recorded,[{...admitted,state:'applied'}],[]);
 assert.equal(rows.length,1);assert.equal(rows[0]!.key,pending[0]!.key);
 const restored=messageRows(nodes([event(0,'turn/start',{turn:1}),source]),[],[]);
 assert.equal(restored.length,1);assert.equal(restored[0]!.node?.kind,'user');
 const node=restored[0]!.node;assert.ok(node&&node.kind==='user');
 assert.deepEqual(node.data.content,content);
});
function nodes(events:HistoryEvent[]):ChatNode[]{
 const observation=new WorkerObservation({project:'project',node:'node',workerId:'worker'},()=>{},100);
 observation.snapshot({generation:'generation',assistantStream:{revision:0},page:{kind:'persisted',formatVersion:3,sourceSessionId:'session',attachments:[],events,cut:'cut',before:null,coverage:'readable-persisted-prefix',total:events.length}});
 const chat=observation.engine.snapshot('chat') as ChatSnapshot;
 return chat.order.map(key=>chat.nodes.get(key) as ChatNode);
}
test('one immediate message retains identity, content and images through admission into native history',()=>{
 const pending=outgoing();
 const local=messageRows([],[],[pending]);assert.equal(local.length,1);assert.equal(local[0]!.key,'submission:message-a');assert.deepEqual(local[0]!.outgoing?.request,pending.request);assert.equal(messageStatus(local[0]!),undefined);
 for(const state of ['pending','admitted'] as const){const rows=messageRows([],[receipt(state)],[pending]);assert.equal(rows.length,1);assert.equal(rows[0]!.key,local[0]!.key);assert.deepEqual(rows[0]!.submission?.content,pending.request.content);if(state==='pending')assert.equal(messageStatus(rows[0]!),undefined);}
 const recorded=nodes([event(0,'turn/start',{turn:1}),user(1,'native-id','message-a')]);
 const rows=messageRows(recorded,[receipt('completed')],[pending]);assert.equal(rows.length,1);assert.equal(rows[0]!.key,local[0]!.key);assert.ok(rows[0]!.node);assert.equal(messageStatus(rows[0]!),undefined);
});
test('accepted steering stays visible at the inbox boundary and reconciles after its durable claim',()=>{
 const opening=[event(0,'turn/start',{turn:1}),user(1,'opening'),event(2,'step/start',{turn:1,step:1})];
 const insert=event(3,'agent/inbox/spliced',{target:'next-step',start:0,inserted:[{id:'native-steer',role:'user',source:{kind:'user',rpcId:'message-a'},content:[{type:'text',text:'Same text'}]}]});
 const admitted={...receipt('admitted'),kind:'message' as const};
 const before=messageRows(nodes([...opening,insert]),[admitted],[]);
 assert.equal(before.length,2);assert.match(messageStatus(before[1]!)! ,/next agent step/);
 const claim=event(4,'agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[]});
 const after=messageRows(nodes([...opening,insert,claim,user(5,'native-steer','message-a')]),[{...admitted,state:'applied'}],[]);
 assert.equal(after.length,2);assert.equal(after[1]!.key,before[1]!.key);assert.equal(after[1]!.node?.kind,'steering');assert.equal(messageStatus(after[1]!),undefined);
});
test('identical message text cannot claim another send and unloaded settled history is not fabricated',()=>{
 const recorded=nodes([event(0,'turn/start',{turn:1}),user(1,'first','message-a'),user(2,'second','message-b')]);
 const rows=messageRows(recorded,[receipt('completed','message-a'),receipt('completed','old-message')],[outgoing('message-b'),outgoing('message-c')]);
 assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.key),['submission:message-a','submission:message-b','submission:message-c']);
});
test('source-before-receipt and receipt-before-source preserve one row; delivery failures preserve content',()=>{
 const local=outgoing();
 const recorded=nodes([event(0,'turn/start',{turn:1}),user(1,'native','message-a')]);
 assert.equal(messageRows(recorded,[],[local]).length,1);
 assert.equal(messageRows([],[receipt('completed')],[{...local,receipt:receipt('completed')}]).length,1);
 const error=messageRows([],[],[{...local,error:'Network lost'}])[0]!;assert.match(messageStatus(error)!,/unconfirmed/);assert.deepEqual(error.outgoing?.request,local.request);
 const pendingFailure=messageRows([],[receipt('pending')],[{...local,error:'Connection lost'}])[0]!;assert.match(messageStatus(pendingFailure)!,/unconfirmed.*Connection lost/);
 const failed=messageRows([],[{...receipt('failed'),retryable:true,detail:'Setup failed'}],[local])[0]!;assert.equal(messageStatus(failed),'Setup failed');assert.equal(failed.submission?.retryable,true);
 const uncertain=messageRows(recorded,[{...receipt('uncertain'),detail:'Acknowledgement lost'}],[])[0]!;assert.equal(messageStatus(uncertain),'Acknowledgement lost');assert.ok(uncertain.node);
});
test('all send gestures share lifecycle, image, empty-input and outstanding-request guards',()=>{
 const valid={busy:false,storageBlocked:false,text:'Hello',imageCount:0,state:'idle' as const,cleanupPending:false};
 assert.equal(canSendMessage(valid),true);assert.equal(canSendMessage({...valid,state:'running'}),true);assert.equal(canSendMessage({...valid,state:'starting'}),true);
 for(const state of ['interrupting','closed','uncertain'] as const)assert.equal(canSendMessage({...valid,state}),false);
 for(const change of [{busy:true},{storageBlocked:true},{cleanupPending:true},{text:'  '}])assert.equal(canSendMessage({...valid,...change}),false);
 assert.equal(canSendMessage({...valid,text:'',imageCount:1}),true);
 for(const state of ['running','starting'] as const)assert.equal(canSendMessage({...valid,state,imageCount:1}),true);
});

test('browser restart retains exact request identity and images without trusting a cached acknowledgement',()=>{
 const pending=outgoing('11111111-1111-4111-8111-111111111111');
 const restored=restoreOutgoing(saveOutgoing([{...pending,receipt:receipt('admitted')}]));
 assert.deepEqual(restored[0]!.request,pending.request);assert.equal(restored[0]!.createdAt,pending.createdAt);assert.equal(restored[0]!.receipt,undefined);assert.match(restored[0]!.error!,/Checking retained/);
 assert.throws(()=>restoreOutgoing('{broken'));assert.throws(()=>restoreOutgoing('[{"request":{"id":"bad"}}]'));
});

test('interrupt receipts remain controls and never become fabricated user messages',()=>{
 const control:Outgoing={createdAt:1000,request:{id:'interrupt-a',kind:'interrupt',text:''},error:'Network lost'};
 assert.deepEqual(messageRows([],[{id:'interrupt-a',kind:'interrupt',text:'',state:'pending'}],[control]),[]);
});

test('confirmed admission rejection stays distinguishable from lost response across browser restart',()=>{
 const request=outgoing('11111111-1111-4111-8111-111111111111');
 const restored=restoreOutgoing(saveOutgoing([{...request,error:'Worker is closed',rejected:true}]));
 assert.equal(restored[0]!.rejected,true);assert.equal(messageStatus(messageRows([],[],restored)[0]!),'Not sent: Worker is closed');
});


test('restored receipts recover by exact identity when their history and receipt pages are unloaded',async()=>{
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 const restored=restoreOutgoing(saveOutgoing(ids.map(id=>outgoing(id)))),reads:string[]=[];
 const recovered=await recoverOutgoing(restored,[],async id=>{reads.push(id);return {...receipt(id===ids[0]?'applied':id===ids[1]?'admitted':'failed',id),retryable:id===ids[2]};});
 assert.deepEqual(reads,ids);assert.deepEqual(recovered.map(value=>value.request.id),ids.slice(1));
 assert.deepEqual(messageRows([],[],recovered).map(row=>row.submission?.state),['admitted','failed']);
 assert.equal(canSendMessage({busy:false,storageBlocked:false,text:'Independent message',imageCount:0,state:'running',cleanupPending:false}),true);
 const settled=await recoverOutgoing(recovered,[receipt('applied',ids[1])],async id=>receipt('failed',id));
 assert.deepEqual(settled.map(value=>value.request.id),[ids[2]]);
});
test('recovery retains unknown outcomes and failed controls, retires completed controls, and never resubmits',async()=>{
 const message={...outgoing(),recovering:true as const},control:Outgoing={request:{id:'interrupt',kind:'interrupt',text:''},createdAt:1000,recovering:true};
 const unknown=await recoverOutgoing([message],[],async()=>{throw new Error('Not found');});
 assert.deepEqual(unknown[0]!.request,message.request);assert.match(unknown[0]!.error!,/Not found/);
 const failed={id:'interrupt',kind:'interrupt' as const,text:'',state:'uncertain' as const,detail:'Cancellation unconfirmed'};
 const retained=await recoverOutgoing([control],[failed],async()=>{throw new Error('Unexpected lookup');});assert.equal(retained[0]!.receipt?.state,'uncertain');
 assert.deepEqual(await recoverOutgoing(retained,[{...failed,state:'completed'}],async()=>{throw new Error('Unexpected lookup');}),[]);
 const fresh={...outgoing(),receipt:receipt('admitted')};
 assert.equal((await recoverOutgoing([fresh],[receipt('applied')],async()=>{throw new Error('Unexpected lookup');}))[0],fresh,'Live optimistic row survives acknowledgement before native source');
});

/** Exercise receipt reconciliation against the live native grouping publication. */
function groupedConversation(events:HistoryEvent[]=[],before:number|null=null){
 const paints=new Set<()=>void>();
 const observation=new WorkerObservation({project:'project',node:'node',workerId:'worker'},()=>{throw new Error('Unexpected source repair');},100,publish=>{paints.add(publish);return()=>{paints.delete(publish);};});
 observation.snapshot({generation:'generation',assistantStream:{revision:0},page:{kind:'persisted',formatVersion:3,sourceSessionId:'session',attachments:[],events,cut:'cut',before,coverage:'readable-persisted-prefix',total:(events.at(-1)?.seq??-1)+1}});
 const read=()=>{
  for(const paint of [...paints]){paints.delete(paint);paint();}
  const chat=observation.engine.get('chat'),grouped=observation.engine.grouped('chat');assert.ok(chat);assert.ok(grouped);
  return {chat,grouped};
 };
 return {observation,read,rows(submissions:readonly Submission[]=[],outgoing:readonly Outgoing[]=[]){
  const {chat,grouped}=read();return conversationRows(grouped.entries,chat.nodes.values() as readonly ChatNode[],submissions,outgoing);
 }};
}
const tool=(seq:number,callId:string)=>event(seq,'tool/call',{turn:1,step:1,callId,name:'read',arguments:'{"path":"notes.txt"}'});
const reply=(seq:number):HistoryEvent=>({...event(seq,'assistant/message',{turn:1,step:1,stream:[],message:{id:'answer',role:'assistant',source:{kind:'model',provider:'synthetic',model:'fixture'},content:[{type:'reasoning',text:'Inspect the notes.'},{type:'text',text:'Here is the answer.'}]}}),surfaceOp:'append'});

test('grouped conversation preserves the pending receipt key when durable input arrives beside process groups',t=>{
 const f=groupedConversation([event(0,'turn/start',{turn:1})]);t.after(()=>f.observation.dispose());
 const pending=outgoing(),initial=f.rows([], [pending]);assert.equal(initial.length,1);
 const key=initial[0]!.key;
 f.observation.accept({generation:'generation',sequence:1,kind:'event',event:user(1,'native-input','message-a')});
 f.observation.accept({generation:'generation',sequence:2,kind:'event',event:event(2,'step/start',{turn:1,step:1})});
 f.observation.accept({generation:'generation',sequence:3,kind:'event',event:tool(3,'call-1')});
 const rows=f.rows([receipt('completed')],[pending]);
 const messages=rows.filter(row=>row.kind==='message');
 assert.equal(messages.length,1);assert.equal(messages[0]!.key,key);assert.equal(messages[0]!.message.node?.kind,'user');
 assert.equal(messageStatus(messages[0]!.message),undefined);
 assert.equal(rows[0],messages[0]);assert.ok(rows.some(row=>row.kind==='native'&&row.entry.kind==='group'));
});

test('grouped reasoning and reply keep distinct render positions while retaining one native assistant identity',t=>{
 const f=groupedConversation([event(0,'turn/start',{turn:1}),user(1,'native-input','message-a'),event(2,'step/start',{turn:1,step:1}),reply(3)]);t.after(()=>f.observation.dispose());
 const {chat,grouped}=f.read(),rows=f.rows([receipt('completed')]);
 const response=rows.find(row=>row.kind==='native'&&row.entry.kind==='node'&&row.entry.groupPart==='response');
 assert.ok(response&&response.kind==='native'&&response.entry.kind==='node');
 const reasoningGroup=rows.find(row=>row.kind==='native'&&row.entry.kind==='group'&&grouped.groupSource(row.entry.key).getSnapshot()?.members.some(member=>member.key===response.entry.key&&member.groupPart==='reasoning'));
 assert.ok(reasoningGroup);assert.notEqual(reasoningGroup.key,response.key);
 assert.equal(rows.filter(row=>row.key===response.key).length,1);
 assert.equal(new Set(rows.map(row=>row.key)).size,rows.length);
 assert.equal(chat.nodes.values().filter(node=>node.kind==='assistant-step').length,1);
 assert.equal(rows.filter(row=>row.kind==='message').length,1);
});

test('grouped receipt merge excludes hidden failed attempts even when all loaded nodes are supplied',t=>{
 const f=groupedConversation([event(0,'turn/start',{turn:1}),user(1,'native-input','message-a'),event(2,'step/start',{turn:1,step:1})]);t.after(()=>f.observation.dispose());
 f.observation.accept({generation:'generation',sequence:1,kind:'assistant-stream',frame:{type:'start',attemptId:'attempt',revision:1,startedAfterSeq:2,turn:1,step:1}});
 f.observation.accept({generation:'generation',sequence:2,kind:'assistant-stream',frame:{type:'chunk',attemptId:'attempt',revision:2,index:0,time:2000,chunk:{type:'reasoning-delta',index:0,text:'Unfinished reasoning'}}});
 const before=f.read(),assistant=before.chat.nodes.values().find(node=>node.kind==='assistant-step');assert.ok(assistant);
 assert.ok(f.rows().some(row=>row.kind==='native'&&row.entry.kind==='group'));
 f.observation.accept({generation:'generation',sequence:3,kind:'event',event:event(3,'assistant/attempt',{turn:1,step:1,stream:[]})});
 f.observation.accept({generation:'generation',sequence:4,kind:'assistant-stream',frame:{type:'end',attemptId:'attempt',revision:3,index:1,outcome:{kind:'committed',eventType:'assistant/attempt',seq:3}}});
 const {chat}=f.read();assert.equal(chat.nodes.get(assistant.key)?.visibility,'hidden');
 const rows=f.rows([receipt('completed')]);
 assert.deepEqual(rows.map(row=>row.key),['submission:message-a']);
 assert.equal(rows[0]!.kind,'message');assert.equal(f.observation.error,'');
});

test('prepending members expands the existing process group without duplicating or moving a loaded receipt',async t=>{
 const prefix=[event(0,'turn/start',{turn:1}),user(1,'older-input','older-receipt'),event(2,'step/start',{turn:1,step:1}),tool(3,'early')];
 const suffix=[tool(4,'late'),event(5,'step/end',{turn:1,step:1}),event(6,'turn/end',{turn:1,reason:{kind:'completed'}}),event(7,'turn/start',{turn:2}),user(8,'native-input','message-a')];
 const f=groupedConversation(suffix,4);t.after(()=>f.observation.dispose());
 const before=f.rows([receipt('completed')],[outgoing()]);
 const group=before.find(row=>row.kind==='native'&&row.entry.kind==='group');assert.ok(group&&group.kind==='native'&&group.entry.kind==='group');
 const source=f.read().grouped.groupSource(group.entry.key),members=source.getSnapshot()!.members.length;
 t.mock.method(globalThis,'fetch',async()=>Response.json({kind:'persisted',formatVersion:3,sourceSessionId:'session',attachments:[],events:prefix,cut:'cut',before:null,coverage:'readable-persisted-prefix',total:9}));
 assert.equal(await f.observation.older(),true);
 const after=f.rows([receipt('completed')],[outgoing()]);
 assert.equal(source.getSnapshot()!.members.length,members+1);
 assert.deepEqual(after.filter(row=>before.some(previous=>previous.key===row.key)).map(row=>row.key),before.map(row=>row.key));
 assert.equal(after.filter(row=>row.key==='submission:message-a').length,1);
 assert.equal(after.at(-1)?.key,'submission:message-a');
 assert.equal(after.filter(row=>row.key===group.key).length,1);
});
