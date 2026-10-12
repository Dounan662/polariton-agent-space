import {z} from 'zod';
import {Id,WorkerEnvironment,WorkerMcpStatus,WorkerResidency} from './contracts.ts';

/** Compact observations preserve identities and explicitly mark shortened display text. */
export const OverviewText=z.object({text:z.string(),truncated:z.boolean()}).strict();
export type OverviewText=z.infer<typeof OverviewText>;
export const WorkerOverviewInput=z.object({target:Id.optional(),section:z.enum(['coworkers','attention']).optional(),limit:z.number().int().positive().optional(),after:z.string().min(1).optional()}).strict().refine(v=>v.section!==undefined||(v.limit===undefined&&v.after===undefined),'Overview pagination requires --section coworkers or --section attention');
export type WorkerOverviewInput=z.infer<typeof WorkerOverviewInput>;
const state=z.enum(['inactive','closed','starting','idle','running','interrupting','uncertain','failed']);
export const OverviewCoworker=z.object({id:Id,name:OverviewText,state}).strict();
export type OverviewCoworker=z.infer<typeof OverviewCoworker>;
export const OverviewAttention=z.object({id:z.string(),kind:z.enum(['currentIssue','permission','pendingDelivery','historicalDelivery']),code:z.string(),title:OverviewText,detail:OverviewText.nullable(),sender:z.object({id:Id,name:OverviewText}).strict().nullable(),deliveryState:z.enum(['pending','admitted','failed','interrupted','uncertain']).nullable(),operation:z.string().nullable(),inspect:z.string()}).strict();
export type OverviewAttention=z.infer<typeof OverviewAttention>;
export const OverviewWorker=z.object({id:Id,projectId:Id,nodeId:Id,name:OverviewText,state,model:z.string().nullable(),error:OverviewText.nullable(),residency:WorkerResidency.shape.phase,cleanupPending:z.boolean(),environment:WorkerEnvironment,connections:z.array(WorkerMcpStatus),connectionsKnown:z.boolean(),connectionTotal:z.number().int().nonnegative(),unavailableConnections:z.number().int().nonnegative(),active:z.boolean()}).strict();
export type OverviewWorker=z.infer<typeof OverviewWorker>;
const page=<S extends z.ZodType>(item:S)=>z.object({availability:z.enum(['available','unavailable']),total:z.number().int().nonnegative().nullable(),returned:z.number().int().nonnegative(),coverage:z.enum(['complete','page','unknown']),next:z.string().nullable(),items:z.array(item)}).strict();
export const WorkerOverview=z.object({
 status:z.enum(['complete','partial']),observed:z.object({startedAt:z.number(),finishedAt:z.number(),consistency:z.literal('live-owner-observation')}).strict(),
 worker:z.object({id:Id,name:OverviewText,inspect:z.string()}).strict(),
 placement:z.object({project:z.object({id:Id,name:OverviewText.nullable(),availability:z.enum(['available','historical','unavailable','unknown']),initialization:z.enum(['pending','ready','blocked','unknown']),initialWorkerId:Id.nullable(),inspect:z.string()}).strict(),node:z.object({id:Id,title:OverviewText.nullable(),archived:z.boolean().nullable(),availability:z.enum(['available','unknown']),inspect:z.string()}).strict(),workspace:z.object({path:z.string().nullable(),availability:z.enum(['available','unavailable','unknown']),omission:z.enum(['size','source']).nullable(),inspect:z.string()}).strict()}).strict(),
 execution:z.object({state,model:z.string().nullable(),error:OverviewText.nullable(),residency:WorkerResidency.shape.phase,cleanupPending:z.boolean()}).strict(),
 environment:z.object({selection:z.object({environmentId:z.string(),revisionId:z.string(),name:OverviewText}).strict().nullable(),locked:z.boolean(),observation:z.enum(['none','unknown','last-observed']),active:z.boolean(),connections:z.object({total:z.number().int().nonnegative().nullable(),returned:z.number().int().nonnegative(),coverage:z.enum(['complete','page','unknown']),next:z.string().nullable(),items:z.array(z.object({componentId:z.string(),serverName:OverviewText,status:WorkerMcpStatus.shape.status,code:z.string().nullable()}).strict())}).strict(),inspect:z.string().nullable()}).strict(),
 coworkers:page(OverviewCoworker),attention:page(OverviewAttention).extend({totals:z.object({currentIssues:z.number().int().nonnegative(),permissions:z.number().int().nonnegative().nullable(),pendingDelivery:z.number().int().nonnegative().nullable(),historicalDelivery:z.number().int().nonnegative().nullable()}).strict()}),
 issues:z.array(z.object({source:z.enum(['project','node','workspace','coworkers','attention']),code:z.string(),detail:OverviewText}).strict()),
}).strict();
export type WorkerOverview=z.infer<typeof WorkerOverview>;
export type AttentionPosition={rank:number;id:string};
/** Display values are bounded; keys and counts are never truncated. */
export function overviewText(text:string,max:number):OverviewText{const chars=Array.from(text);return {text:chars.slice(0,max).join(''),truncated:chars.length>max};}
export function attentionRank(item:OverviewAttention){return ['currentIssue','permission','pendingDelivery','historicalDelivery'].indexOf(item.kind);}
