import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from './config.ts';
import { Fault } from './contracts.ts';
import type { ResearchTree } from './research.ts';
import { WorkspaceScope, type WorkspaceChange } from './workspace-contracts.ts';

type Settings = Pick<Config, 'workspaceDebounceMs' | 'workspaceReconcileMs' | 'workspaceReadTimeoutMs' | 'maxWorkspaceWatches' | 'maxWorkspaceScans'>;
type Research = Pick<ResearchTree, 'observationPath' | 'directory'>;
type Cancel = () => void;
type Listener = (change: WorkspaceChange) => void;
export type WorkspaceDiagnostic = { event: 'scan-error' | 'watch-error' | 'scan-timeout' | 'listener-error'; scope: WorkspaceScope; detail: string };
export type WorkspaceSnapshot = { watchPath: string | null; binding: string; fingerprint: string };
/** Injectable operating-system boundary; scheduled callbacks and watchers must be cancellable. */
export type WorkspaceObserverIO = {
  snapshot(scope: WorkspaceScope): Promise<WorkspaceSnapshot>;
  watch(path: string, changed: () => void, failed: (error: Error) => void): Cancel;
  schedule(delayMs: number, callback: () => void): Cancel;
};
type Resource = {
  scope: WorkspaceScope; listeners: Set<Listener>; active: boolean; running: boolean; dirty: boolean;
  fingerprint?: string; state?: WorkspaceChange; watchPath?: string; binding?: string;
  stopWatch?: Cancel; stopDebounce?: Cancel; stopReconcile?: Cancel; stopDeadline?: Cancel;
};
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'DIRECTORY_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Shares bounded read-only watches and reconciles missed events without depending on agent activity.
 * Each resource has at most one scan; a blocked scan retains its concurrency slot after its deadline,
 * preventing timeout/retry storms. Subscribers receive an initial invalidation after watch admission.
 */
export class WorkspaceObserver {
  private readonly resources = new Map<string, Resource>();
  private readonly queue = new Set<Resource>();
  private running = 0;
  private closed = false;
  private counters = { scans: 0, changes: 0, errors: 0, timeouts: 0 };
  private readonly io: WorkspaceObserverIO;
  private readonly settings: Settings;
  private readonly diagnostic: (event: WorkspaceDiagnostic) => void;

  constructor(settings: Settings, research: Research, diagnostic: (event: WorkspaceDiagnostic) => void = () => {}, io?: Partial<WorkspaceObserverIO>) {
    this.settings = settings;
    this.diagnostic = diagnostic;
    this.io = {
      schedule: (delay, callback) => { const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer); },
      watch: (path, changed, failed) => { const watcher = watch(path, { persistent: false }, changed); watcher.on('error', failed); return () => watcher.close(); },
      snapshot: async scope => {
        const target = await research.observationPath(scope.project, scope.node, scope.path);
        const watchPath = scope.kind === 'file' ? dirname(target) : target;
        let directory;
        try { directory = await lstat(watchPath, { bigint: true }); }
        catch (error) { if (missing(error)) return { watchPath: null, binding: '', fingerprint: 'missing' }; throw error; }
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Fault('FILE_DENIED', 'Observation directory is not admitted', 403);
        const binding = `${directory.dev}:${directory.ino}`;
        let fingerprint: string;
        if (scope.kind === 'directory') {
          try { fingerprint = JSON.stringify(await research.directory(scope.project, scope.node, scope.path)); }
          catch (error) { if (missing(error)) return { watchPath: null, binding: '', fingerprint: 'missing' }; throw error; }
        } else {
          try {
            const file = await lstat(target, { bigint: true });
            if (!file.isFile() || file.isSymbolicLink()) throw new Fault('FILE_DENIED', 'Observed file is not admitted', 403);
            fingerprint = `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
          } catch (error) { if (!missing(error)) throw error; fingerprint = 'missing'; }
        }
        // Recheck admission after reading so a replaced parent cannot keep an outside watch alive.
        await research.observationPath(scope.project, scope.node, scope.path);
        return { watchPath, binding, fingerprint: `${binding}:${fingerprint}` };
      },
      ...io,
    };
  }

  /** Releasing the last listener closes its watch and timers; equivalent scopes share one resource. */
  subscribe(raw: WorkspaceScope, listener: Listener): Cancel {
    if (this.closed) throw new Fault('WORKSPACE_OBSERVER_CLOSED', 'Workspace observation is closed');
    const scope = WorkspaceScope.parse(raw), key = JSON.stringify([scope.project, scope.node, scope.kind, scope.path]);
    let resource = this.resources.get(key);
    if (!resource) {
      if (this.resources.size >= this.settings.maxWorkspaceWatches) throw new Fault('WORKSPACE_WATCH_LIMIT', 'Workspace observation capacity reached', 429);
      resource = { scope, listeners: new Set(), active: true, running: false, dirty: false };
      this.resources.set(key, resource);
    }
    const registration: Listener = change => listener(change);
    resource.listeners.add(registration);
    if (resource.state) this.deliver(resource, registration, resource.state);
    else this.enqueue(resource);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resource.listeners.delete(registration);
      if (resource.listeners.size || !resource.active) return;
      this.dispose(resource);
      if (this.resources.get(key) === resource) this.resources.delete(key);
    };
  }

  /** Counters expose observation health without retaining file contents or unbounded history. */
  stats() { return { ...this.counters, resources: this.resources.size, scansInFlight: this.running, queued: this.queue.size, watches: [...this.resources.values()].filter(resource => resource.stopWatch).length }; }

  close() {
    this.closed = true;
    for (const resource of this.resources.values()) this.dispose(resource);
    this.resources.clear();
  }

  private dispose(resource: Resource) {
    resource.active = false;
    resource.stopWatch?.(); resource.stopDebounce?.(); resource.stopReconcile?.(); resource.stopDeadline?.();
    this.queue.delete(resource);
    resource.listeners.clear();
  }

  private deliver(resource: Resource, listener: Listener, change: WorkspaceChange) {
    try { listener(change); }
    catch (error) { this.counters.errors++; this.diagnostic({ event: 'listener-error', scope: resource.scope, detail: detail(error) }); }
  }

  private publish(resource: Resource, change: WorkspaceChange) {
    if (!resource.active) return;
    resource.state = change;
    this.counters.changes++;
    for (const listener of resource.listeners) this.deliver(resource, listener, change);
  }

  private enqueue(resource: Resource) {
    if (!resource.active) return;
    if (resource.running) { resource.dirty = true; return; }
    resource.stopReconcile?.(); resource.stopReconcile = undefined;
    this.queue.add(resource);
    this.pump();
  }

  private pump() {
    while (!this.closed && this.running < this.settings.maxWorkspaceScans && this.queue.size) {
      const resource = this.queue.values().next().value!;
      this.queue.delete(resource);
      resource.running = true;
      this.running++;
      void this.scan(resource);
    }
  }

  private changed(resource: Resource) {
    if (!resource.active || resource.stopDebounce) return;
    // A leading-edge deadline is bounded even if writers never become quiet.
    resource.stopDebounce = this.io.schedule(this.settings.workspaceDebounceMs, () => {
      resource.stopDebounce = undefined;
      this.enqueue(resource);
    });
  }

  private async scan(resource: Resource) {
    this.counters.scans++;
    resource.stopDeadline = this.io.schedule(this.settings.workspaceReadTimeoutMs, () => {
      if (!resource.active) return;
      this.counters.timeouts++;
      const message = 'Workspace observation timed out; retaining the last view until the filesystem responds';
      this.diagnostic({ event: 'scan-timeout', scope: resource.scope, detail: message });
      this.publish(resource, { scope: resource.scope, state: 'unavailable', detail: message });
    });
    try {
      const snapshot = await this.io.snapshot(resource.scope);
      if (!resource.active) return;
      if (resource.watchPath !== snapshot.watchPath || resource.binding !== snapshot.binding || !resource.stopWatch) {
        resource.stopWatch?.(); resource.stopWatch = undefined;
        resource.watchPath = snapshot.watchPath ?? undefined;
        resource.binding = snapshot.binding;
        if (snapshot.watchPath) {
          try {
            resource.stopWatch = this.io.watch(snapshot.watchPath, () => this.changed(resource), error => {
              if (!resource.active) return;
              resource.stopWatch?.(); resource.stopWatch = undefined;
              this.counters.errors++;
              this.diagnostic({ event: 'watch-error', scope: resource.scope, detail: detail(error) });
              this.publish(resource, { scope: resource.scope, state: 'unavailable', detail: 'Live observation interrupted; reconciling automatically' });
              this.changed(resource);
            });
          } catch (error) {
            this.counters.errors++;
            this.diagnostic({ event: 'watch-error', scope: resource.scope, detail: detail(error) });
            // Reconciliation remains authoritative when OS watch admission is unavailable.
          }
        }
      }
      if (resource.fingerprint !== snapshot.fingerprint || resource.state?.state === 'unavailable') {
        resource.fingerprint = snapshot.fingerprint;
        this.publish(resource, { scope: resource.scope, state: 'changed' });
      }
    } catch (error) {
      if (!resource.active) return;
      resource.stopWatch?.(); resource.stopWatch = undefined;
      this.counters.errors++;
      this.diagnostic({ event: 'scan-error', scope: resource.scope, detail: detail(error) });
      const message = detail(error);
      const terminal = error instanceof Fault && ['PROJECT_NOT_FOUND', 'NODE_NOT_FOUND', 'FILE_DENIED'].includes(error.code);
      if (terminal || resource.state?.state !== 'unavailable' || resource.state.detail !== message)
        this.publish(resource, { scope: resource.scope, state: 'unavailable', detail: message, ...(terminal ? { terminal: true } : {}) });
      if (terminal) {
        this.dispose(resource);
        for (const [key, value] of this.resources) if (value === resource) this.resources.delete(key);
      }
    } finally {
      resource.stopDeadline?.(); resource.stopDeadline = undefined;
      resource.running = false;
      this.running--;
      if (resource.active) {
        if (resource.dirty) { resource.dirty = false; this.queue.add(resource); }
        else resource.stopReconcile = this.io.schedule(this.settings.workspaceReconcileMs, () => { resource.stopReconcile = undefined; this.enqueue(resource); });
      }
      this.pump();
    }
  }
}
