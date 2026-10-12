import type {SessionMetrics} from '../../../src/metrics.ts';
import {SourceObservation} from './observation.ts';
import type {Scope} from './observation.ts';
import type {HistoryPage,HistoryEvent} from '../../../src/contracts.ts';
/** Source transport envelopes are opaque to the application; the presenter owns
 * version-specific stream decoding and reconciliation. */
export type PresentationSnapshot={generation:string;page:HistoryPage|null;assistantStream:unknown};
export type PresentationFrame={generation:string;sequence:number;kind:string;event?:HistoryEvent;metrics?:SessionMetrics;frame?:unknown};
export type {Scope} from './observation.ts';
/** A subscribed reading surface. Transport delivers opaque source envelopes; the
 * presenter owns their interpretation. Reading never activates a worker. */
export type WorkerObservation=Pick<SourceObservation,
 'scope'|'base'|'status'|'error'|'loadingOlder'|'hasHistory'|'hasMore'|'latest'|
 'subscribe'|'getSnapshot'|'snapshot'|'accept'|'fail'|'stale'|'retry'|'dispose'|'older'|'recordedSubmissions'|'inspectSource'>;
/** Create one retained presenter per worker, independent of mounted UI tabs. */
export function observeWorker(scope:Scope,repair:()=>void,maxEvents:number):WorkerObservation{
 return new SourceObservation(scope,repair,maxEvents);
}
