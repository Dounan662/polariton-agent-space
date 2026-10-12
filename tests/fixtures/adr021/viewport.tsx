import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Conversation} from '../../../web/src/native/views.tsx';
import {SourceObservation} from '../../../web/src/native/observation.ts';
import type {HistoryEvent, HistoryPage} from '../../../src/contracts.ts';
import '../../../web/src/ui/design-platform.css';
import '../../../web/src/ui/shiki.css';
import '../../../web/src/style.css';

// Synthetic source-only qualification: no daemon, credentials, execution or
// private session files. The real presenter, source reader and CSS are exercised.
const total = Number(new URLSearchParams(location.search).get('events') ?? 2096);
const events: HistoryEvent[] = Array.from({length: total}, (_, seq) => {
 const turn = Math.floor(seq / 8) + 1, step = 1;
 const text = `Message ${seq}\n\n` + 'A retained research observation with variable length. '.repeat(1 + seq % 11);
 const variants = [
  {type:'turn/start',data:{turn}},
  {type:'step/start',data:{turn,step}},
  {type:'user/message',data:{id:`user-${seq}`,role:'user',source:{kind:'user'},content:[{type:'text',text}]},surfaceOp:'append'},
  {type:'tool/call',data:{turn,step,callId:`call-${turn}`,name:'inspect',arguments:'{}'}},
  {type:'tool/result',data:{turn,step,message:{role:'tool',source:{kind:'tool',callId:`call-${turn}`},toolCallId:`call-${turn}`,id:`result-${turn}`,content:[{type:'text',text:'Synthetic result'}],isError:false}},surfaceOp:'append'},
  {type:'assistant/message',data:{turn,step,stream:[],message:{id:`answer-${seq}`,role:'assistant',source:{kind:'model',provider:'synthetic',model:'fixture'},content:[{type:'text',text}]}},surfaceOp:'append'},
  {type:'step/end',data:{turn,step}},
  {type:'turn/end',data:{turn,reason:{kind:'completed'}}},
 ];
 return {seq,time:100000+seq,...variants[seq%8]!};
});
const page = (before=events.length): HistoryPage => ({kind:'persisted',formatVersion:4,sourceSessionId:'fixture',cut:'fixture-cut',before:Math.max(0,before-100)||null,events:events.slice(Math.max(0,before-100),before),attachments:[],coverage:'readable-persisted-prefix',total:events.length});
const source = new SourceObservation({project:'fixture',node:'fixture',workerId:'adr021'},()=>{fixture.repairs++;},100000);
const originalFetch = window.fetch;
const fixture = {
 source, requests:0, inFlight:0, maxInFlight:0, repairs:0, delay:30, fail:false, gate:null as null|(()=>void), hold:new URLSearchParams(location.search).has('hold'),
 all(){sequence=0;source.snapshot({generation:'fixture',assistantStream:{revision:0},page:{...page(),before:null,events}});},
 image(){const seq=events.length;const event:HistoryEvent={seq,time:100000+seq,type:'user/message',data:{id:`user-${seq}`,role:'user',source:{kind:'user'},content:[{type:'image',attachment:{attachmentId:'synthetic-image',name:'Late synthetic image',mediaType:'image/png'}}]},surfaceOp:'append'};events.push(event);source.accept({generation:'fixture',sequence:++sequence,kind:'event',event});},
 stream(text:string){
  const turn=Math.floor(events.length/8)+1;
  if(!streaming){
   streaming=true;
   for(const type of ['turn/start','step/start']){const event:HistoryEvent={seq:events.length,time:200000,type,data:{turn,step:1}};events.push(event);source.accept({generation:'fixture',sequence:++sequence,kind:'event',event});}
   source.accept({generation:'fixture',sequence:++sequence,kind:'assistant-stream',frame:{type:'start',revision:++revision,attemptId:'fixture-stream',startedAfterSeq:events.length-1,turn,step:1}});
  }
  source.accept({generation:'fixture',sequence:++sequence,kind:'assistant-stream',frame:{type:'chunk',revision:++revision,attemptId:'fixture-stream',index:chunkIndex++,time:200001,chunk:{type:'text-delta',index:0,text}}});
 },
 append(){const seq=events.length;const event:HistoryEvent={seq,time:100000+seq,type:'user/message',data:{id:`user-${seq}`,role:'user',source:{kind:'user'},content:[{type:'text',text:`New message ${seq}`} ]},surfaceOp:'append'};events.push(event);source.accept({generation:'fixture',sequence:++sequence,kind:'event',event});},
};
let sequence=0,revision=0,chunkIndex=0,streaming=false;
Object.assign(window,{fixture});
window.fetch = async (...args) => {
 const url = new URL(String(args[0]),location.href);
 if(!url.pathname.endsWith('/history')) return originalFetch(...args);
 fixture.requests++;fixture.inFlight++;fixture.maxInFlight=Math.max(fixture.maxInFlight,fixture.inFlight);
 await new Promise<void>(resolve=>{if(fixture.hold)fixture.gate=resolve;else setTimeout(resolve,fixture.delay);});
 fixture.inFlight--;
 return fixture.fail?Response.json({error:{code:'FIXTURE_READ_FAILURE',message:'Synthetic read failure'}},{status:503}):Response.json(page(Number(url.searchParams.get('before'))));
};
source.snapshot({generation:'fixture',assistantStream:{revision:0},page:page()});
const noop = () => {};
function App(){
 const [active,setActive]=useState(true),[mounted,setMounted]=useState(true);
 return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
  <div><button onClick={()=>setActive(value=>!value)}>Toggle tab</button><button onClick={()=>setMounted(value=>!value)}>Toggle mount</button><button onClick={()=>source.latest()}>Local send navigation</button></div>
  <div style={{display:active?'flex':'none',flex:1,minHeight:0}}>{mounted&&<Conversation active={active} observation={source} submissions={[]} outgoing={[]} busy={false} retry={noop} retrySetup={noop} dismiss={noop} edit={noop}/>}</div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
