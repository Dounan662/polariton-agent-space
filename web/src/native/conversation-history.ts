/** UI work limits are independent of the source reader's event and byte limits. */
export interface ConversationBudget {
  estimatedRowHeight: number;
  overscanRows: number;
  prefetchPixels: number;
  endThreshold: number;
  pagesPerDemand: number;
  persistDelayMs: number;
}
export const conversationBudget: Readonly<ConversationBudget> = {
  estimatedRowHeight: 160, overscanRows: 6, prefetchPixels: 800,
  endThreshold: 48, pagesPerDemand: 24, persistDelayMs: 250,
};
export type ReadingPosition = {key: string; offset: number; atBottom: boolean};
/** Browser storage is optional; malformed bookmarks cannot drive history loading. */
export function readingPosition(value: string | null): ReadingPosition | null {
  try {
    const position: unknown = JSON.parse(value ?? 'null');
    if (position && typeof position === 'object' && 'key' in position && typeof position.key === 'string' &&
      'offset' in position && typeof position.offset === 'number' && Number.isFinite(position.offset) &&
      'atBottom' in position && typeof position.atBottom === 'boolean') return position as ReadingPosition;
  } catch { /* Invalid browser state has no authority over source history. */ }
  return null;
}
interface HistoryReader {
  readonly status: 'connecting' | 'ready' | 'error';
  readonly error: string;
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  older(): Promise<boolean>;
}
type Schedule = (work: () => void) => () => void;
const schedule: Schedule = work => {const id = setTimeout(work, 0); return () => clearTimeout(id);};

/** Serialize viewport demand, yield between pages, and latch failures/budget stops
 * until explicit recovery. Geometry stays with the virtualizer; source validity
 * and stale-response rejection stay with the reader. Hidden views do no work. */
export class HistoryDemand {
  private active = false;
  private needed = false;
  private pages = 0;
  private inFlight = false;
  private disposed = false;
  private cancel: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private pause: string | null = null;
  private retrying = false;
  private reader: HistoryReader;
  private limit: number;
  private queue: Schedule;
  constructor(reader: HistoryReader, limit = conversationBudget.pagesPerDemand, queue: Schedule = schedule) {this.reader=reader;this.limit=limit;this.queue=queue;}
  readonly subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  readonly getSnapshot = () => this.pause;
  update(active: boolean, needed: boolean) {
    this.active = active; this.needed = needed;
    if (!needed) this.pages = 0;
    this.cancel?.(); this.cancel = null;
    if (this.disposed || !active || !needed || this.inFlight || this.reader.loadingOlder ||
      this.reader.status !== 'ready' || !this.reader.hasMore || this.pause) return;
    if (this.reader.error && !this.retrying) {this.stop('Earlier history could not be loaded.'); return;}
    if (this.pages >= this.limit) {this.stop('Automatic history loading paused at its page budget.'); return;}
    this.cancel = this.queue(() => {this.cancel = null; void this.load();});
  }
  retry() {this.pages = 0; this.retrying = true; this.pause = null; this.emit(); this.update(this.active, this.needed);}
  dispose() {this.disposed = true; this.cancel?.(); this.cancel = null; this.listeners.clear();}
  private emit() {for (const listener of this.listeners) listener();}
  private stop(message: string) {this.pause = message; this.emit();}
  private async load() {
    if (this.disposed || !this.active || !this.needed || this.reader.loadingOlder ||
      this.reader.status !== 'ready' || !this.reader.hasMore) return;
    this.inFlight = true; this.retrying = false; this.pages++;
    try {
      const applied = await this.reader.older();
      if (!this.disposed && !applied && this.reader.status === 'ready' && this.reader.hasMore)
        this.stop(this.reader.error || 'Earlier history made no progress.');
    } catch (error) {
      if (!this.disposed) this.stop(`Earlier history could not be loaded: ${String(error)}`);
    } finally {
      this.inFlight = false;
      // The owner reevaluates geometry after projection publication, before this
      // yielded callback may fetch the next page (including hidden-only pages).
      this.update(this.active, this.needed);
    }
  }
}
