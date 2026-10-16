import type {SessionMetrics} from './metrics.ts';
import { z } from 'zod';
import { EnvironmentRef } from './environment/contracts.ts';
import {Actor} from './caller.ts';

export const Id = z.string().uuid();
export const Text = z.string().trim().min(1).max(10000);
export const GraphCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node.create'), id: Id, title: Text, description: z.string().max(10000), source: z.object({ nodeId: Id, checkpointId: Id }).optional() }),
  z.object({ kind: z.literal('node.edit'), id: Id, title: Text, description: z.string().max(10000) }),
  z.object({ kind: z.literal('node.archive'), id: Id, archived: z.boolean() }),
  z.object({ kind: z.literal('edge.create'), id: Id, from: Id, to: Id, relation: Text, explanation: z.string().max(10000) }),
  z.object({ kind: z.literal('edge.edit'), id: Id, relation: Text, explanation: z.string().max(10000) }),
  z.object({ kind: z.literal('edge.retract'), id: Id }),
]);
export const Mutation = z.object({ operationId: Id, revision: z.number().int().nonnegative(), command: GraphCommand }).strict();
export type Mutation = z.infer<typeof Mutation>;
export type NodeRecord = { id: string; title: string; description: string; archived: boolean; source?: { nodeId: string; checkpointId: string } };
export type EdgeRecord = { id: string; from: string; to: string; relation: string; explanation: string; retracted: boolean };
export type Graph = { revision: number; nodes: NodeRecord[]; edges: EdgeRecord[]; recovery: string | null };
export type Project = { id: string; name: string; root: string; availability: 'available' | 'historical' | 'unavailable'; detail: string | null };
export type ProjectView = Project & { mainNodeId: string | null; initialWorkerId: string | null; initialization: { state: 'pending' | 'ready' | 'blocked'; detail: string | null } };
export type WorkspaceEntry = { path: string; name: string; kind: 'directory' | 'file'; bytes: number | null };
export type FilePage = { path: string; version: string; bytes: number; offset: number; next: number | null; text: string };
export const UploadPublication = z.object({ operationId: Id, path: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type UploadPublication = z.infer<typeof UploadPublication>;
export type UploadReceipt = { operationId: string; path: string; version: string; bytes: number; state: 'staged' | 'published' };
/** A publisher requests a shared-node snapshot; attribution does not claim file authorship. */
export const CheckpointPublication = z.object({publisher:Actor,note:Text.optional()}).strict();
export type CheckpointPublication = z.infer<typeof CheckpointPublication>;
/** A retained milestone in the node’s shared Git history; Git owns its file inventory. */
export const Checkpoint = z.object({
  id:Id,nodeId:Id,commit:z.string(),createdAt:z.number().int().nonnegative(),
  publisher:Actor,note:Text.nullable(),
}).strict();
export type Checkpoint = z.infer<typeof Checkpoint>;
export type WorkerState = 'inactive' | 'closed' | 'starting' | 'idle' | 'running' | 'interrupting' | 'uncertain' | 'failed';
/** All retained workers, including archived workers; permissions are an independent attention count. */
export type NodeActivity = {nodeId:string;total:number;archived:number;states:Record<WorkerState,number>;active:number;permissions:number};
export const PromptPart = z.discriminatedUnion('type', [z.object({type:z.literal('text'),text:z.string()}),z.object({type:z.literal('image'),attachmentId:Id})]);
export type PromptPart = z.infer<typeof PromptPart>;
/** Worker ID is authoritative; name describes the sender at admission time.
 * Only trusted admission supplies this snapshot. Its absence denotes human input. */
export const WorkerSender=z.object({id:Id,name:Text}).strict();
export const Submission=z.object({id:Id,kind:z.enum(['message','interrupt']),text:z.string(),content:z.array(PromptPart).optional(),sender:WorkerSender.optional(),state:z.enum(['pending','admitted','applied','completed','failed','interrupted','uncertain']),detail:z.string().optional(),attempts:z.array(z.object({at:z.number(),state:z.string(),detail:z.string().optional()}).strict()).optional(),retryable:z.boolean().optional()}).strict();
export type Submission=z.infer<typeof Submission>;
/** Present the same attributed content to the recipient and the ordinary message
 * renderer. Original input stays immutable for retries; history retains the result.
 * Quoting the name keeps embedded newlines from becoming additional header fields. */
export function submissionContent(value:Pick<Submission,'text'|'content'|'sender'>):PromptPart[]{
  const content=value.content??[{type:'text' as const,text:value.text}];
  if(!value.sender)return content;
  const {id,name}=value.sender;
  return [{type:'text',text:`[Polariton worker message]\nWorker ID: ${id}\nName: ${JSON.stringify(name)}\n\n`},...content];
}
/** Message intent is resolved by the owner; callers never route from a stale worker snapshot. */
export type WorkerInput = {id:string;text:string;content?:PromptPart[]} | {id:string;kind:'interrupt';text:string};
export type ModelOption = { id:string; name:string; currentValue:string; options:{value:string;name:string;group?:string}[] };
export type StagedImage = {id:string;name:string;mediaType:string;bytes:number;uploadedDigest:string};
export const WorkerEnvironment = z.object({selection:EnvironmentRef.nullable(),locked:z.boolean()}).strict();
/** Captured caller text is a creation input, never a path for the daemon to reopen. */
export const WorkerInstructions = z.object({text:z.string(),sourcePath:z.string().min(1)}).strict();
export const WorkerCreate = z.object({title:Text,model:z.string().optional(),environment:EnvironmentRef.nullable().optional(),systemPrompt:WorkerInstructions.optional()}).strict();
export type WorkerCreate = z.infer<typeof WorkerCreate>;
/** The original role and choices survive later title/model edits and source-file deletion. */
export const WorkerCreation = z.object({requestId:Id,creator:Actor,createdAt:z.number().int().nonnegative(),specification:WorkerCreate,instructionDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
export type WorkerCreation = z.infer<typeof WorkerCreation>;
/** Last activation's MCP observation, not continuous remote-service health. */
export const WorkerMcpStatus=z.object({componentId:z.string(),serverName:z.string(),status:z.enum(['connected','unavailable']),code:z.string().nullable()}).strict();
export type WorkerMcpStatus=z.infer<typeof WorkerMcpStatus>;
export const WorkerResidency=z.object({timeoutMs:z.number().nullable(),phase:z.enum(['inactive','resident','unloading','disabled','unknown']),blockers:z.array(z.string()),lastUnloadedAt:z.number().nullable()}).strict();
export type WorkerView = { residency:z.infer<typeof WorkerResidency>; creation:WorkerCreation; mcp:WorkerMcpStatus[]; environment:z.infer<typeof WorkerEnvironment>; cleanupPending:boolean; id: string; nodeId: string; projectId: string; agentId: string; assignmentId: string; processId: string | null; harnessSessionId: string | null; title: string; state: WorkerState; error: string | null; archived:boolean; model:string | null; configOptions:ModelOption[]; imageCapability:boolean; submissions: (Submission & {content?:PromptPart[]})[]; permissions: Permission[] };
export type Permission = { id: string; toolCallId: string; title: string; detail: string; options: { optionId: string; name: string; kind: string }[] };
export type HistoryEvent = { type: string; seq: number; time: number; data: unknown; surfaceOp?: unknown; sourceEventSeqs?: number[] };
export type AttachmentView = { reference?:string; seq: number; index: number; name: string; mediaType: string; bytes: number };
export type HistoryPage = { kind: 'persisted'; formatVersion: number; sourceSessionId: string; attachments: AttachmentView[]; events: HistoryEvent[]; cut: string; before: number | null; coverage: 'readable-persisted-prefix'; total: number; metrics?:SessionMetrics };

/** Product failures carry stable meaning without exposing transport or storage internals. */
export class Fault extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status; }
}
