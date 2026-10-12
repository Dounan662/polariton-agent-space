export interface RefreshPolicy {
  requestTimeoutMs: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  maxRetries: number;
}

export interface ResourceSnapshot<T> {
  readonly data: T | undefined;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
}

/** Scheduling returns a cancellation function; tests can advance time without wall-clock waits. */
export interface RefreshClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

const clock: RefreshClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/**
 * Owns one mounted resource's reads, retained successful value, and bounded recovery.
 * Invalidations coalesce without throwing away completed reads. A reader must honor
 * its abort signal; late completion after a deadline or disposal is never published.
 * A timed-out reader retains its concurrency slot until it settles: a broken reader
 * that ignores cancellation reports an error but cannot accumulate background work.
 * Construction is idle; the owner starts it with invalidate and disposes on unmount.
 */
export class RefreshResource<T> {
  private snapshot: ResourceSnapshot<T> = {data: undefined, error: null, loading: false, refreshing: false, stale: true};
  private readonly listeners = new Set<() => void>();
  private readonly read: (signal: AbortSignal) => Promise<T>;
  private readonly policy: RefreshPolicy;
  private readonly clock: RefreshClock;
  private readonly equal: (a: T, b: T) => boolean;
  private readonly retryable: (error: Error) => boolean;
  private active: {controller: AbortController; cancelDeadline: () => void} | null = null;
  private cancelRetry: (() => void) | null = null;
  private hasData = false;
  private dirty = false;
  private retries = 0;
  private disposed = false;

  constructor(read: (signal: AbortSignal) => Promise<T>, policy: RefreshPolicy, options: {equal?: (a: T, b: T) => boolean; retryable?: (error: Error) => boolean; clock?: RefreshClock} = {}) {
    this.read = read;
    this.policy = policy;
    this.clock = options.clock ?? clock;
    this.equal = options.equal ?? Object.is;
    this.retryable = options.retryable ?? (() => true);
  }

  getSnapshot = (): ResourceSnapshot<T> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Repeated events cannot cancel a useful response or bypass failure backoff. */
  invalidate = (): void => {
    if (this.disposed) return;
    if (this.active) {
      this.dirty = true;
      return;
    }
    if (this.cancelRetry) return;
    this.retries = 0;
    this.start();
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.cancelRetry?.();
    this.cancelRetry = null;
    const active = this.active;
    this.active = null;
    active?.cancelDeadline();
    active?.controller.abort();
  };

  private publish(snapshot: ResourceSnapshot<T>): void {
    if (this.disposed) return;
    const prior = this.snapshot;
    if (prior.data === snapshot.data && prior.error === snapshot.error && prior.loading === snapshot.loading && prior.refreshing === snapshot.refreshing && prior.stale === snapshot.stale) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    if (this.disposed || this.active) return;
    const request = {controller: new AbortController(), cancelDeadline: () => {}};
    this.active = request;
    this.dirty = false;
    let timeout: Error | null = null;
    const finish = (result: {data: T} | {error: Error}): void => {
      if (this.disposed || this.active !== request) return;
      if (timeout) result = {error: timeout};
      request.cancelDeadline();
      this.active = null;
      const dirty = this.dirty;
      this.dirty = false;
      if ('data' in result) {
        const data = this.hasData && this.equal(this.snapshot.data as T, result.data) ? this.snapshot.data : result.data;
        this.hasData = true;
        this.retries = 0;
        this.publish({data, error: null, loading: false, refreshing: dirty, stale: dirty});
        if (dirty) this.start();
      } else {
        // A failed read has not observed the resource, including any dirty events.
        // Recovery covers those events without allowing them to reset its budget.
        if (this.retries < this.policy.maxRetries && this.retryable(result.error)) {
          const delay = Math.min(this.policy.maxRetryDelayMs, this.policy.retryDelayMs * 2 ** this.retries);
          this.retries++;
          this.cancelRetry = this.clock.schedule(() => {
            this.cancelRetry = null;
            this.start();
          }, delay);
        }
        this.publish({...this.snapshot, error: result.error, loading: false, refreshing: false, stale: true});
      }
    };
    request.cancelDeadline = this.clock.schedule(() => {
      timeout = new Error('Workspace read timed out');
      this.publish({...this.snapshot, error: timeout, loading: false, refreshing: false, stale: true});
      request.controller.abort();
    }, this.policy.requestTimeoutMs);
    this.publish({...this.snapshot, loading: !this.hasData, refreshing: this.hasData, stale: true});
    if (this.disposed || this.active !== request) return;
    try {
      void this.read(request.controller.signal).then(
        data => finish({data}),
        error => finish({error: error instanceof Error ? error : new Error(String(error))}),
      );
    } catch (error) {
      finish({error: error instanceof Error ? error : new Error(String(error))});
    }
  }
}
