import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionStatistics} from '../../../web/src/native/views.tsx';
import {SourceObservation} from '../../../web/src/native/observation.ts';
import type {SessionMetrics} from '../../../src/metrics.ts';
import type {HistoryPage} from '../../../src/contracts.ts';
import '../../../web/src/ui/design-platform.css';
import '../../../web/src/style.css';
// Synthetic screenshots' readings exercise the real transport decoder and native UI.
const metrics:SessionMetrics={
 tokenUsage:{uncachedInputTokens:11211,cacheReadTokens:145024,cacheWriteTokens:0,outputTokens:5066},
 sessionStats:{turns:1,steps:11,llmMs:28700,toolMs:600,ttftMs:11000,ttftSteps:11,decodeMs:18092.85714285714,decodeTokens:5066},
 contextPressure:{pressureTokens:22000,projectedTokens:22000,contextWindow:1000000},
 contextBreakdown:{systemTokens:1500,toolsTokens:5300,messageTokens:13100},
};
const source=new SourceObservation({project:'fixture',node:'fixture',workerId:'metrics'},()=>{},100);
const page:HistoryPage={kind:'persisted',formatVersion:4,sourceSessionId:'metrics',cut:'fixture',events:[],attachments:[],before:null,coverage:'readable-persisted-prefix',total:0,metrics};
source.snapshot({generation:'fixture',page,assistantStream:{revision:0}});
Object.assign(window,{fixture:{source,replace(metrics:SessionMetrics){source.snapshot({generation:'fixture',page:{...page,metrics},assistantStream:{revision:0}});},metrics}});
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh',display:'flex',flexDirection:'column'}}><main style={{flex:1,padding:32}}>Recorded conversation</main><div className="composer"><textarea aria-label="Message" placeholder="Send a message…"/><div className="composer-footer">DeepSeek</div></div><SessionStatistics observation={source}/></div>);
