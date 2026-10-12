import type {SessionMetrics} from '../../../src/metrics.ts';
export type {SessionMetrics};
export type MetricsTranslate=(key:string,values?:Record<string,string|number>)=>string;
const labels:Record<string,string>={
 'stats.counts':'{turns} turns {steps} steps',
 'stats.cacheHit':'Cache hit {percent}%',
 'stats.dialog.title':'Session statistics',
 'stats.dialog.llmTime':'LLM time',
 'stats.dialog.toolTime':'Tool time',
 'stats.dialog.ttft':'Avg time to first token (TTFT)',
 'stats.dialog.speed':'Tokens per second (TPS)',
 'stats.dialog.usageTitle':'Token usage',
 'message.tokensPerSecond':'{tps} tok/s',
 'message.turnUsage.count':'{count} tok',
 'message.turnUsage.cacheHit':'Cache hit',
 'message.turnUsage.input':'Uncached input',
 'message.turnUsage.cacheRead':'Cached input',
 'message.turnUsage.cacheWrite':'Cache write',
 'message.turnUsage.output':'Output',
 'duration.compactSeconds':'{seconds}s',
 'duration.compactMinutes':'{minutes}m{seconds}s',
 'number.thousand':'{value}K','number.million':'{value}M','number.groupSeparator':',',
 'context.aria':'{percent} of context used','context.used':'Context usage',
 'context.system':'System prompt','context.tools':'Tool definitions','context.messages':'Messages',
};
/** Locale seat shared by the native metric components in Polariton's English UI. */
export const metricsTranslate:MetricsTranslate=(key,values)=>{
 const label=labels[key];if(label===undefined)throw new Error(`Unknown metric label: ${key}`);
 return label.replace(/\{(\w+)\}/g,(_,name)=>String(values?.[name]??''));
};
