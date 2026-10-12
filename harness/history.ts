import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {lstat} from 'node:fs/promises';
import {Worker as ReaderThread} from 'node:worker_threads';
import {Context} from '@deepseek-ai/cordis';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {AttachmentId,type ImageAttachmentRef,type FileAttachmentRef} from '@deepseek-ai/dsh-attachment';
import {z} from 'zod';
import {SessionMetrics} from '../src/metrics.ts';
import {Fault,Id,type HistoryPage,type HistoryEvent} from '../src/contracts.ts';
import type {Config} from '../src/config.ts';
import {InputSource} from './message-source.ts';

export type HistoryScope={id:string;harnessSessionId:string|null};
type Cut={workerId:string;sessionId:string|null;digest:string;events:HistoryEvent[];metrics?:SessionMetrics;expires:number};
const Attachment = z.object({ attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(AttachmentId), bytes: z.number().int().nonnegative(), name: z.string().optional(), mediaType: z.enum(['image/png','image/jpeg','image/webp','image/gif']).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() });
/** Find durable references in public event data; paths and browser-supplied references are never accepted. */
function attachments(data: unknown): (ImageAttachmentRef | FileAttachmentRef)[] {
  const pending = [data], result: (ImageAttachmentRef | FileAttachmentRef)[] = [];
  while (pending.length) {
    const value = pending.pop(); if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const parsed = Attachment.safeParse(value);
    if (parsed.success && ((parsed.data.mediaType && parsed.data.width && parsed.data.height) || (!parsed.data.mediaType && parsed.data.name))) result.push(parsed.data as ImageAttachmentRef | FileAttachmentRef);
    else pending.push(...Object.values(value));
  }
  return result;
}

/** Bounded, execution-free source cuts and attachment access for an already-authorized worker.
 * DSH remains the sole writer; cuts never acquire an execution or repair handle. */
export class HarnessHistory {
  private cuts=new Map<string,Cut>();
  private readers=new Set<ReaderThread>();
  private config:Config;
  constructor(config:Config){this.config=config;}
  /** Retain one immutable cut per distinct source, sharing unchanged reads within its fixed lifetime.
   * Capacity is global; expired cuts go first, then the least recently used source. */
  retain(worker:HistoryScope,events:HistoryEvent[],metrics?:SessionMetrics):string {
    const source=JSON.stringify(events);
    if(events.length>this.config.maxHistoryEvents||Buffer.byteLength(source)>this.config.maxFrameBytes)throw new Fault('HISTORY_LIMIT','History exceeds configured observation budget');
    const now=Date.now(),digest=createHash('sha256').update(source).digest('hex');
    for(const [id,cut] of this.cuts)if(cut.expires<=now)this.cuts.delete(id);
    for(const [id,cut] of this.cuts)if(cut.workerId===worker.id&&cut.sessionId===worker.harnessSessionId&&cut.digest===digest){
      this.cuts.delete(id);this.cuts.set(id,cut);return id;
    }
    const id=randomUUID();while(this.cuts.size>=this.config.maxHistoryCuts)this.cuts.delete(this.cuts.keys().next().value!);
    this.cuts.set(id,{workerId:worker.id,sessionId:worker.harnessSessionId,digest,events:structuredClone(events),metrics:structuredClone(metrics),expires:now+this.config.historyCutTtlMs});return id;
  }
  /** Authorize a cut and record actual use without extending its source lifetime. */
  private source(worker:HistoryScope,id:string):Cut {
    const cut=this.cuts.get(id);
    if(!cut||cut.workerId!==worker.id||cut.sessionId!==worker.harnessSessionId||cut.expires<=Date.now())throw new Fault('HISTORY_CUT_EXPIRED','History cut expired; reload the latest source');
    this.cuts.delete(id);this.cuts.set(id,cut);return cut;
  }
  applied(worker:HistoryScope,cutId:string):string[]{
    const cut=this.source(worker,cutId);
    return cut.events.flatMap(event=>{const value=z.object({type:z.literal('user/message'),data:z.object({source:InputSource})}).safeParse(event);return value.success?[value.data.data.source.rpcId]:[];});
  }
  async history(worker: HistoryScope, cutId?: string, before?: number): Promise<HistoryPage> {
    const id = worker.id;
    if (!worker.harnessSessionId) throw new Fault('NO_HISTORY', 'This worker has not been started', 404);
    let cut: Cut | undefined;
    if (cutId) {
      cut = this.source(worker,cutId);
    } else {
      if(this.readers.size>=this.config.maxHistoryReaders) throw new Fault('HISTORY_BUSY','History readers are at capacity; retry shortly');
      const reader=new ReaderThread(new URL('./reader.mjs',import.meta.url),{
        env:{}, resourceLimits:{maxOldGenerationSizeMb:this.config.historyWorkerMemoryMb},
        workerData:{root:join(this.config.stateRoot,'harness',id,'sessions'),sessionId:worker.harnessSessionId,pageSize:this.config.historyPageSize,maxEvents:this.config.maxHistoryEvents,maxBytes:this.config.maxFrameBytes},
      });
      this.readers.add(reader);
      let events:HistoryEvent[],metrics:SessionMetrics|undefined;
      try {
        events=await new Promise<HistoryEvent[]>((accept,reject)=>{
          const timer=setTimeout(()=>reject(new Fault('HISTORY_TIMEOUT','History source did not settle before the read deadline')),this.config.requestTimeoutMs);
          const finish=(error:Error|null,value?:HistoryEvent[])=>{clearTimeout(timer);if(error)reject(error);else accept(value!);};
          reader.once('message',(result:{events?:HistoryEvent[];error?:string;version?:number;metrics?:unknown})=>{
            if(result.error||result.version!==SESSION_FORMAT_VERSION)finish(new Fault(result.error??'HISTORY_UNAVAILABLE','Saved source exceeds the configured budget, is missing, unreadable, or incompatible; no agent was started'));
            else {const parsed=SessionMetrics.safeParse(result.metrics);if(!parsed.success)finish(new Fault('METRICS_UNAVAILABLE','Saved session metrics failed validation'));else {metrics=parsed.data;finish(null,result.events);}}
          });
          reader.once('error',()=>finish(new Fault('HISTORY_UNAVAILABLE','History reader failed within its resource boundary')));
          reader.once('exit',()=>finish(new Fault('HISTORY_UNAVAILABLE','History reader exited before completing its source cut')));
        });
      } finally { await reader.terminate();this.readers.delete(reader); }
      cutId=this.retain(worker,events,metrics);cut=this.source(worker,cutId);
    }
    const end = before ?? cut.events.length;
    if (!Number.isSafeInteger(end) || end < 0 || end > cut.events.length) throw new Fault('INVALID_CURSOR', 'Invalid history cursor', 400);
    const start = Math.max(0, end - this.config.historyPageSize);
    const events = structuredClone(cut.events.slice(start, end));
    return { kind: 'persisted', formatVersion: SESSION_FORMAT_VERSION, sourceSessionId: worker.harnessSessionId, attachments: events.flatMap(event => attachments(event.data).map((ref, index) => ({ reference:Buffer.from(JSON.stringify({worker:id,session:worker.harnessSessionId,seq:event.seq,index,attachment:ref.attachmentId})).toString('base64url'), seq: event.seq, index, name: ref.name ?? 'Recorded image', mediaType: 'mediaType' in ref ? ref.mediaType : 'application/octet-stream', bytes: ref.bytes }))), events, cut: cutId!, before: start === 0 ? null : start, coverage: 'readable-persisted-prefix', total: cut.events.length,metrics:structuredClone(cut.metrics) };
  }
  async image(worker:HistoryScope,attachmentId:string) {
    const page=await this.history(worker), cut=this.source(worker,page.cut);
    for(const event of cut.events) {const refs=attachments(event.data),index=refs.findIndex(ref=>ref.attachmentId===attachmentId&&'mediaType' in ref);if(index>=0)return this.attachment(worker,page.cut,event.seq,index);}
    throw new Fault('ATTACHMENT_NOT_FOUND','Image is not referenced by this worker',404);
  }
  /** Read only an attachment referenced by an authorized frozen history page. */
  async attachment(worker:HistoryScope, cutId: string, seq: number, index: number) {
    const id=worker.id;
    const cut = this.source(worker,cutId);
    const event = cut.events.find(value => value.seq === seq), ref = event && attachments(event.data)[index];
    if (!ref) throw new Fault('ATTACHMENT_NOT_FOUND', 'No attachment belongs to this source record', 404);
    if (ref.bytes > this.config.maxFileBytes) throw new Fault('ATTACHMENT_LIMIT', 'Recorded attachment exceeds configured download budget');
    const ctx = new Context();
    try {
      await ctx.plugin(LocalAttachmentStore, { dshHome: join(this.config.stateRoot, 'harness', id) });
      const signal = AbortSignal.timeout(this.config.requestTimeoutMs);
      if ('mediaType' in ref) {
        const path = ctx.attachments.imageHostPath(ref);
        if (!path) throw new Fault('ATTACHMENT_UNAVAILABLE', 'Attachment backend has no bounded local image source');
        const info = await lstat(path);
        if (!info.isFile() || info.size !== ref.bytes || info.size > this.config.maxFileBytes) throw new Fault('ATTACHMENT_UNAVAILABLE', 'Retained image failed size or file validation');
        const stored = await ctx.attachments.readImage(ref, signal); return { bytes: Buffer.from(stored.data), mediaType: ref.mediaType }; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of ctx.attachments.readFileStream(ref, signal)) { size += chunk.length; if (size > this.config.maxFileBytes) throw new Fault('ATTACHMENT_LIMIT', 'Attachment exceeds download budget'); chunks.push(Buffer.from(chunk)); }
      return { bytes: Buffer.concat(chunks), mediaType: 'application/octet-stream' };
    } catch (error) { if (error instanceof Fault) throw error; throw new Fault('ATTACHMENT_UNAVAILABLE', 'Retained attachment is missing or failed integrity validation', 409); }
    finally { await ctx.fiber.dispose(); }
  }
  /** Retained references are re-authorized against a fresh DSH read; no live cut or process is required. */
  async evidence(worker:HistoryScope,reference:string){
    const ref=z.object({worker:Id,session:z.string(),seq:z.number().int().nonnegative(),index:z.number().int().nonnegative(),attachment:z.string()}).strict().parse(JSON.parse(Buffer.from(reference,'base64url').toString('utf8')));
    const id=worker.id;
    if(ref.worker!==id||ref.session!==worker.harnessSessionId)throw new Fault('ATTACHMENT_NOT_FOUND','Evidence does not belong to this worker',404);
    const page=await this.history(worker),cut=this.source(worker,page.cut);
    const event=cut.events.find(value=>value.seq===ref.seq),attachment=event&&attachments(event.data)[ref.index];
    if(!attachment||attachment.attachmentId!==ref.attachment)throw new Fault('ATTACHMENT_NOT_FOUND','Evidence is absent from retained source',404);
    return this.attachment(worker,page.cut,ref.seq,ref.index);
  }
  async close(){await Promise.allSettled([...this.readers].map(reader=>reader.terminate()));this.cuts.clear();}
}
