import type {SessionMetrics} from '../src/metrics.ts';
import {EventEmitter} from 'node:events';
import {z} from 'zod';
import type {Config} from '../src/config.ts';
import type {HistoryEvent,ModelOption} from '../src/contracts.ts';
import type {AccessGrant} from '../src/environment/contracts.ts';
import {GuardianIdentity} from './settings.ts';
import {ResidencySnapshot} from './settings.ts';
import type {ProviderRuntime} from './providers.ts';

export type Activity=z.infer<typeof ResidencySnapshot>;
export type HarnessSettings=Pick<Config,
  'provider'|'model'|'stateRoot'|'runtimeDirectory'|'guardian'|'maxFrameBytes'|'maxHistoryEvents'|
  'startupTimeoutMs'|'requestTimeoutMs'|'mcpStartupTimeoutMs'|'mcpCleanupTimeoutMs'|'maxOutputTokens'|
  'workerCredential'|'workerIdentity'|'workerInstructions'|'sharedSkillsDir'|'jobObservation'|'verification'
>&{selectedModel?:string|null;providerRuntime?:ProviderRuntime};
export type InputPart={type:'text';text:string}|{type:'image';data:string;mimeType:'image/png'|'image/jpeg'|'image/webp'|'image/gif'};
/** Authenticated input origin is independent of visible text and cannot default to human authority. */
export const MessageOrigin=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('human')}).strict(),
  z.object({kind:z.literal('worker'),workerId:z.string().uuid()}).strict(),
]);
export type MessageOrigin=z.infer<typeof MessageOrigin>;
export type ModelChoice={value:string;name:string;image:boolean};
export type McpObservation={serverName:string;status:'connected'|'unavailable';code:'MCP_STARTUP_FAILED'|'MCP_STARTUP_TIMEOUT'|null};
export type UnavailableServer={serverName:string;status:'unavailable';code:string|null};
export type PermissionRequest={sessionId:string;toolCall:{toolCallId:string;title:string;rawInput:unknown};options:Array<{optionId:string;name:string;kind:string}>};
export type PermissionAnswer={outcome:string;optionId?:string};
export type SourceSnapshot={events:HistoryEvent[];metrics?:SessionMetrics;cursor:number;assistantStream:{revision:number;[key:string]:unknown}};
export type HarnessEvents={
  ready:[];
  permission:[PermissionRequest];
  turn:[{sessionId:string;id:string;phase:'claimed';requestId:string}|{sessionId:string;id:string;phase:'ended';reason:{kind:string;[key:string]:unknown}}];
  source:[{sessionId:string;seq:number;type:string;event:HistoryEvent;metrics?:SessionMetrics}];
  submission:[{sessionId:string;requestId:string;state:'applied'|'interrupted'|'failed';detail?:string}];
  status:[{sessionId:string;status:'idle'|'running'}];
  residency:[Activity&{sessionId:string}];
  assistantStream:[{sessionId:string;frame:unknown}];
  suspending:[];
  exit:[{code:number|null;signal:string|null}?];
  transportError:[Error];
  diagnostic:[{code:string;message:string}];
};

/** One supervised execution owner. The caller owns durable identities and admission policy;
 * this port owns provider protocol, execution interpretation and cleanup confirmation. */
export interface HarnessPort extends EventEmitter<HarnessEvents> {
  readonly recoveryIdentity?:z.infer<typeof GuardianIdentity>;
  start():Promise<{image:boolean}>;
  locate():Promise<string|null>;
  activate(sessionId:string|null,servers:AccessGrant['servers'],unavailable?:UnavailableServer[]):Promise<{sessionId:string;options:ModelOption[];mcp:McpObservation[]}>;
  models():Promise<ModelChoice[]>;
  configure(sessionId:string,id:string,value:string):Promise<ModelOption[]>;
  message(sessionId:string,requestId:string,content:InputPart[],origin:MessageOrigin):Promise<{messageId:string}>;
  interrupt(sessionId:string):Promise<void>;
  observe(sessionId:string):Promise<SourceSnapshot>;
  activity(sessionId:string):Promise<Activity>;
  suspend(sessionId:string,revision:number,canCommit:()=>boolean):Promise<{suspended:boolean;snapshot:Activity}>;
  closeSession(sessionId:string):Promise<void>;
  close():Promise<void>;
}
export type HarnessFactory=(config:HarnessSettings,home:string,workspace:string,budget:()=>Promise<boolean>,permission:(request:PermissionRequest)=>Promise<PermissionAnswer>)=>HarnessPort;
