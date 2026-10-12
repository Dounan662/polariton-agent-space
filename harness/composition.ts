import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {HarnessSettings} from './contracts.ts';
import {z} from 'zod';
import {JobObservationSettings} from './settings.ts';
import {loadPolaritonPrompt} from './prompt.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
type Plugin={id:string;name?:string;disabled?:boolean;config?:Record<string,unknown>};
type Patch=Plugin|{insert:Plugin[]};

/** Compose the one qualified ACP host. Upstream owns every execution service;
 * Polariton supplies instructions and observation policies without another listener.
 * Schedule starts only after the bridge confirms a fully configured activation.
 * Its controller dependencies expose no independent management transport. */
export async function compose(config:HarnessSettings,workspace:string):Promise<Patch[]> {
 const [provider,model]=config.selectedModel?z.tuple([z.string().min(1),z.string().min(1)]).parse(JSON.parse(config.selectedModel)):[config.provider,config.model];
 const prompt=await loadPolaritonPrompt();
 const placement=config.workerIdentity?`\nPolariton launch identity (JSON; placement, not authorization):\n${JSON.stringify({...config.workerIdentity,workspace})}`:'\nNo Polariton launch identity was supplied to this harness; do not infer one.';
 const jobObservation=JobObservationSettings.parse(config.jobObservation??{});
 // Catalog capacities become adapter request defaults; bound every explicit
 // model as well as fallback defaults by the installation's output budget.
 return [
  {id:'llm-deepseek',disabled:config.providerRuntime?!config.providerRuntime.deepseek:false,config:{apiKeyEnv:'DEEPSEEK_API_KEY',...config.providerRuntime?.deepseekConfig,...(config.providerRuntime?.deepseekConfig?.models?{models:config.providerRuntime.deepseekConfig.models.map(model=>({...model,maxTokens:Math.min(model.maxTokens??config.maxOutputTokens,config.maxOutputTokens)}))}:{}),reasoningEffort:'low',maxTokens:config.maxOutputTokens,retryPolicy:{mode:'normal',maxRetries:0}}},
  ...(config.providerRuntime?[
   {id:'credentials',config:{path:config.providerRuntime.credentialPath,watch:false}},
   {id:'llm-pi-ai',config:{providers:Object.fromEntries(Object.entries(config.providerRuntime.providers).map(([id,profile])=>[id,{...profile,...(profile.models?{models:profile.models.map(model=>({...model,maxTokens:Math.min(model.maxTokens??config.maxOutputTokens,config.maxOutputTokens)}))}:{}),defaultMaxTokens:config.maxOutputTokens,timeoutMs:config.requestTimeoutMs}]))}},
  ]:[]),
  ...['llm-deepseek-account','session-log-deepseek','plugin-package-inventory-deepseek','session-telemetry-otel','session-title-llm','plugin-manager','tool-plugin-manager','config-editor','settings'].map(id=>({id,disabled:true})),
  ...(config.verification!==false?['agent-instructions','skill-filesystem']:[]).map(id=>({id,disabled:true})),
  {id:'acp',config:{provider,model}},
  {id:'subprocess',disabled:true},
  {id:'system-prompt',config:{includeHarnessIdentity:false,personaPrefix:prompt.identity,personaSuffix:prompt.shared}},
  ...(config.verification===false?[{id:'skill-filesystem',config:{customSkillDirs:[config.sharedSkillsDir??resolve(config.stateRoot,'skills')]}}]:[]),
  {id:'tool-jobs',config:jobObservation},
  {insert:[
   {id:'polariton-native-execution',name:resolve(root,'harness/execution.mjs')},
   {id:'connection',name:'@deepseek-ai/dsh-client-connection'},
   {id:'file-upload',name:'@deepseek-ai/dsh-client-file-upload'},
   {id:'workspace',name:'@deepseek-ai/dsh-workspace'},
   {id:'session-controller',name:'@deepseek-ai/dsh-api-session-controller',config:{nativeOpen:false}},
   {id:'time-context',name:'@deepseek-ai/dsh-time-context'},
   {id:'polariton-worker-instructions',name:resolve(root,'harness/instructions.mjs'),config:{placement,...(config.workerInstructions!==undefined?{text:config.workerInstructions}:{})}},
   ...(config.verification===false?[{id:'polariton-skills',name:resolve(root,'harness/skills.mjs')}]:[]),
   {id:'polariton-control',name:resolve(root,'harness/bridge.mjs')},
   {id:'polariton-job-guidance',name:resolve(root,'harness/job-guidance.mjs'),config:jobObservation},
  ]},
 ];
}
