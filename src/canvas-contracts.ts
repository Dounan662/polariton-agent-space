import {z} from 'zod';
import {Id,Text} from './contracts.ts';

/** Presentation coordinates and revisions belong to one browser canvas, never the research log. */
export const CanvasPoint=z.object({x:z.number().finite(),y:z.number().finite()}).strict();
export const CanvasBounds=CanvasPoint.extend({width:z.number().finite().nonnegative(),height:z.number().finite().nonnegative()}).strict();
export const CanvasGetInput=z.object({project:Id,canvas:Id.optional()}).strict();
export const CanvasMoveInput=z.object({project:Id,canvas:Id,expectRevision:z.string().min(1),positions:z.array(CanvasPoint.extend({id:Id}).strict()).min(1)}).strict().refine(v=>new Set(v.positions.map(p=>p.id)).size===v.positions.length,'Each node may appear only once');
export const CanvasFinishInput=z.object({project:Id}).strict();
export const CanvasSnapshotInput=z.object({project:Id,canvas:Id,node:Id.optional()}).strict();
export const CanvasCommand=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('canvas.get'),input:CanvasGetInput}).strict(),
 z.object({kind:z.literal('canvas.move'),input:CanvasMoveInput}).strict(),
 z.object({kind:z.literal('canvas.snapshot'),input:CanvasSnapshotInput}).strict(),
]);
export type CanvasCommand=z.infer<typeof CanvasCommand>;
const identity={canvas:Id,project:Id,revision:z.string().min(1)};
export const CanvasState=z.object({...identity,graphRevision:z.number().int().nonnegative(),nodes:z.array(CanvasBounds.extend({id:Id,title:Text,archived:z.boolean()}).strict()),edges:z.array(z.object({id:Id,from:Id,to:Id,relation:Text}).strict())}).strict();
export type CanvasState=z.infer<typeof CanvasState>;
export const CanvasMoveResult=z.object({...identity,requestId:Id,moved:z.array(Id)}).strict();
export type CanvasMoveResult=z.infer<typeof CanvasMoveResult>;
export const CanvasImage=z.object({...identity,graphRevision:z.number().int().nonnegative(),mediaType:z.literal('image/png'),width:z.number().int().positive(),height:z.number().int().positive(),bounds:CanvasBounds,data:z.string()}).strict();
export const CanvasSnapshot=CanvasImage.extend({bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type CanvasSnapshot=z.infer<typeof CanvasSnapshot>;
/** Worker-visible snapshot files are temporary unless the CLI explicitly exports a copy. */
export const CanvasSnapshotFile=CanvasSnapshot.omit({data:true}).extend({output:z.string(),expiresAt:z.number().finite().nullable()});
export type CanvasSnapshotFile=z.infer<typeof CanvasSnapshotFile>;

/** Budgets travel with the browser connection so rendering and transport enforce the same bounds. */
export const CanvasPolicy=z.object({
 timeoutMs:z.number().int().positive().max(2147483647).default(20000),
 maxPending:z.number().int().positive().default(4),
 maxNodes:z.number().int().positive().default(500),
 maxImageBytes:z.number().int().positive().default(8388608),
 maxPixels:z.number().int().positive().default(16777216),
 maxDimension:z.number().int().positive().default(8192),
 padding:z.number().int().positive().default(48),
 maxReceipts:z.number().int().positive().default(64),
 maxCoordinate:z.number().finite().positive().default(1000000),
 snapshotTtlMs:z.number().int().positive().max(2147483647).default(1800000),
 maxSnapshots:z.number().int().positive().default(32),
}).strict();
export type CanvasPolicy=z.infer<typeof CanvasPolicy>;
export const CanvasResponse=z.union([
 z.object({id:Id,result:z.union([CanvasState,CanvasMoveResult,CanvasImage])}).strict(),
 z.object({id:Id,error:z.object({code:z.string().min(1),message:z.string().min(1)}).strict()}).strict(),
]);
export type CanvasResponse=z.infer<typeof CanvasResponse>;

/** A fixed topology/activity observation accompanies each browser presentation operation. */
const canvasGraph=z.object({revision:z.number().int().nonnegative(),nodes:z.array(z.object({id:Id,title:Text,description:z.string(),archived:z.boolean(),source:z.object({nodeId:Id,checkpointId:Id}).optional()}).strict()),edges:z.array(z.object({id:Id,from:Id,to:Id,relation:Text,explanation:z.string(),retracted:z.boolean()}).strict()),recovery:z.string().nullable()}).strict();
const count=z.number().int().nonnegative();
const canvasActivity=z.object({nodeId:Id,total:count,archived:count,active:count,permissions:count,states:z.object({inactive:count,closed:count,starting:count,idle:count,running:count,interrupting:count,uncertain:count,failed:count}).strict()}).strict();
export const CanvasRequest=z.object({kind:z.literal('canvas-request'),id:Id,command:CanvasCommand,graph:canvasGraph,activity:z.array(canvasActivity),requestId:Id.optional(),actor:z.string().min(1),expiresAt:z.number().finite()}).strict();
export type CanvasRequest=z.infer<typeof CanvasRequest>;
export const CanvasNotice=z.discriminatedUnion('kind',[CanvasRequest,z.object({kind:z.literal('canvas-ready'),canvas:Id,policy:CanvasPolicy}).strict(),z.object({kind:z.literal('canvas-cancel'),id:Id}).strict()]);
export type CanvasNotice=z.infer<typeof CanvasNotice>;
