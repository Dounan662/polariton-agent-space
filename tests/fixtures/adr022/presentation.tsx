import React,{useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {Conversation,Trajectory} from '../../../web/src/native/views.tsx';
import {SourceObservation} from '../../../web/src/native/observation.ts';
import type {HistoryEvent,HistoryPage} from '../../../src/contracts.ts';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '../../../web/src/ui/design-platform.css';
import '../../../web/src/ui/shiki.css';
import '../../../web/src/style.css';
import './qualification.css';

// Entirely synthetic recorded history; no daemon, provider, or private workspace.
const parameters=new URLSearchParams(location.search);
const turns=Number(parameters.get('turns')??175),largeGroup=Number(parameters.get('tools')??16);
const image={attachmentId:`sha256:${'a'.repeat(64)}`,name:'synthetic-signal.png',mediaType:'image/png',bytes:4337,width:640,height:360};
const events:HistoryEvent[]=[];
const add=(type:string,data:unknown,surfaceOp?:unknown)=>{
 const seq=events.length,event={seq,time:1791388800000+seq*100,type,data,...surfaceOp?{surfaceOp}:{}};
 events.push(event);return event;
};
for(let turn=1;turn<=turns;turn++){
 add('turn/start',{turn});
 add('user/message',{id:`user-${turn}`,role:'user',source:{kind:'user'},content:[{type:'text',text:`Research observation ${turn}: inspect the saved experiment and summarize the result.`},...(turn===turns?[{type:'image',attachment:image}]:[])]},'append');
 add('step/start',{turn,step:1});
 const count=turn===turns?largeGroup:1;
 const calls=Array.from({length:count},(_,index)=>({type:'tool-call',id:`call-${turn}-${index}`,name:'bash',arguments:JSON.stringify({command:`printf 'observation ${index}'`,description:`Read experiment record ${index+1}`})}));
 if(turn===turns)calls.push({type:'tool-call',id:`call-${turn}-image`,name:'read_image',arguments:JSON.stringify({file_path:'synthetic-signal.png'})});
 // A real model response owns the call heads before tool dispatch/result events.
 // Omitting them creates orphan results, which native trajectory places in Turn 1.
 add('assistant/message',{turn,step:1,stream:[],message:{id:`analysis-${turn}`,role:'assistant',source:{kind:'model',provider:'synthetic',model:'fixture'},content:[{type:'reasoning',text:'Compare the retained evidence before drawing a conclusion.'},{type:'text',text:"I'll inspect the experiment records."},...calls]}},'append');
 for(const [index,call] of calls.entries()){
  const callId=call.id,isImage=call.name==='read_image';
  add('tool/call',{turn,step:1,callId,name:call.name,arguments:call.arguments});
  const content=isImage?[{type:'text',text:'<path>synthetic-signal.png</path>\n<type>image</type>\n<content>\nSynthetic retained signal fixture.\n</content>'},{type:'image',attachment:image}]:[{type:'text',text:parameters.has('overflow')&&index===0?Array.from({length:40},(_,line)=>`Record ${line+1}: ${'Signal: 42 ± 0.5; '.repeat(12)}`).join('\n'):`Observation ${index+1}:\nSignal: 42 ± 0.5\n\u001b[32mMeasurement complete\u001b[0m`}];
  add('tool/result',{turn,step:1,...isImage?{meta:{path:'synthetic-signal.png'}}:{},message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,id:`result-${turn}-${index}`,content,isError:false}},'append');
 }
 add('step/end',{turn,step:1});add('step/start',{turn,step:2});
 add('assistant/message',{turn,step:2,stream:[],usage:{inputTokens:100,outputTokens:50,totalTokens:150,cacheReadTokens:20},message:{id:`answer-${turn}`,role:'assistant',source:{kind:'model',provider:'synthetic',model:'fixture'},content:[{type:'text',text:`## Result ${turn}\n\nThe retained measurements agree within uncertainty. `+'A repeatable observation supports the comparison. '.repeat(1+turn%5)+'\n\nThe model uses $E=mc^2$.\n\n```python\nsignal = 42\nprint(signal)\n```'}]}},'append');
 add('step/end',{turn,step:2});add('turn/end',{turn,reason:{kind:'completed'}});
}
const pageSize=100;
const page=(before=events.length):HistoryPage=>({kind:'persisted',formatVersion:4,sourceSessionId:'native-fixture',cut:'native-cut',before:Math.max(0,before-pageSize)||null,events:events.slice(Math.max(0,before-pageSize),before),attachments:[],coverage:'readable-persisted-prefix',total:events.length});
let requests=0,inFlight=0,maxInFlight=0,sequence=0,revision=0,chunkIndex=0,streaming=false,hold=false,gate:(()=>void)|null=null,fail=false;
const source=new SourceObservation({project:'fixture',node:'fixture',workerId:`native-${turns}-${largeGroup}`},()=>{throw new Error('Unexpected fixture rebaseline');},100000);
const fetchOriginal=window.fetch;
window.fetch=async(...args)=>{
 const url=new URL(String(args[0]),location.href);
 if(!url.pathname.endsWith('/history'))return fetchOriginal(...args);
 requests++;inFlight++;maxInFlight=Math.max(inFlight,maxInFlight);
 await new Promise<void>(resolve=>{if(hold)gate=resolve;else setTimeout(resolve,30);});inFlight--;
 return fail?Response.json({error:{code:'FIXTURE_READ_FAILURE',message:'Synthetic read failure'}},{status:503}):Response.json(page(Number(url.searchParams.get('before'))));
};
source.snapshot({generation:'fixture',assistantStream:{revision:0},page:page()});
const emit=(type:string,data:unknown,surfaceOp?:unknown)=>source.accept({generation:'fixture',sequence:++sequence,kind:'event',event:add(type,data,surfaceOp)});
const stream=()=>{
 if(!streaming){streaming=true;emit('turn/start',{turn:turns+1});emit('step/start',{turn:turns+1,step:1});source.accept({generation:'fixture',sequence:++sequence,kind:'stream',frame:{type:'start',revision:++revision,attemptId:'stream',startedAfterSeq:events.length-1,turn:turns+1,step:1}});}
 source.accept({generation:'fixture',sequence:++sequence,kind:'stream',frame:{type:'chunk',revision:++revision,attemptId:'stream',index:chunkIndex++,time:1791389000000,chunk:{type:'text-delta',index:0,text:' A streamed observation with **native Markdown** and $x^2$.\n\n'}}});
};
const noop=()=>{};
function App(){
 const [active,setActive]=useState(true),[mounted,setMounted]=useState(true),[details,setDetails]=useState<HTMLDivElement|null>(null),[focus,setFocus]=useState<string|null>(null),[report,setReport]=useState('Ready'),[held,setHeld]=useState(false);
 useSyncExternalStore(source.subscribe,source.getSnapshot);
 const measure=()=>{
  const history=document.querySelector<HTMLElement>('.history'),body=document.querySelector<HTMLElement>('[data-step-process-body]:not([hidden])');
  setReport(JSON.stringify({events:events.length,requests,maxInFlight,sourceError:source.error,mountedRows:document.querySelectorAll('[data-chat-row]').length,nativeNodes:document.querySelectorAll('[data-chat-node-key]').length,scroll:history?.scrollTop,tailGap:history?history.scrollHeight-history.scrollTop-history.clientHeight:null,process:body?{height:body.clientHeight,content:body.scrollHeight,top:body.scrollTop}:null},null,2));
 };
 return <div className="qualification-shell"><header className="qualification-header"><b>Native conversation qualification</b><span>Synthetic history · {events.length.toLocaleString()} records</span></header>
  <nav className="qualification-controls" aria-label="Qualification controls">
   <button onClick={()=>setActive(true)}>Conversation</button><button onClick={()=>setActive(false)}>Trajectory</button><button onClick={()=>setMounted(v=>!v)}>Toggle mount</button><button onClick={()=>source.latest()}>Local send navigation</button>
   <button onClick={stream}>Stream chunk</button><button onClick={()=>{const start=performance.now();source.snapshot({generation:'fixture',assistantStream:{revision:0},page:{...page(),before:null,events:[...events]}});setReport(`Full projection: ${(performance.now()-start).toFixed(1)} ms`);}}>Load all source</button>
   <button onClick={()=>{hold=!hold;setHeld(hold);}}>Hold reads: {held?'on':'off'}</button><button onClick={()=>{gate?.();gate=null;}}>Release read</button><button onClick={()=>{fail=!fail;setReport(`Read failure: ${fail}`);}}>Toggle read failure</button><button onClick={measure}>Measure</button>
  </nav>
  <main className="qualification-main"><section className="worker-pane"><div className="conversation-body" hidden={!active}>{mounted&&<Conversation active={active} observation={source} submissions={[]} outgoing={[]} busy={false} retry={noop} retrySetup={noop} dismiss={noop} edit={noop} onInspectCall={callId=>{setFocus(callId);setActive(false);}}/>}</div><div className="trajectory-host" hidden={active}><Trajectory observation={source} details={details} onDetails={noop} focus={focus} onFocusComplete={()=>setFocus(null)}/></div><div className="qualification-composer">Source-only fixture · no model or tools can run</div></section><aside className="qualification-inspector"><b>Details</b><div className="native-details" ref={setDetails}/></aside></main>
  <details className="qualification-report"><summary>Measurement report</summary><pre role="status">{report}</pre></details>
 </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
