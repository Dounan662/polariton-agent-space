import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, type Checkpoint } from './contracts.ts';
import type { Config } from './config.ts';

/** A stable read includes identity/change evidence, so replacement and mode-only edits
 * invalidate an attempt even when its bytes happen to match. Sources honor cancellation. */
export type SnapshotFile = { bytes: Buffer; mode: '100644' | '100755'; version: string };
export interface SnapshotSource {
  files(signal: AbortSignal): Promise<string[]>;
  read(path: string, signal: AbortSignal): Promise<SnapshotFile>;
}
type Limits = Pick<Config, 'checkpointCaptureAttempts' | 'checkpointCaptureTimeoutMs' | 'maxWorkspaceFiles' | 'maxWorkspaceBytes' | 'maxFileBytes' | 'maxFrameBytes'>;
export type CapturedSnapshot = { tree: string; files: string[]; capture: Checkpoint['capture'] };
const fingerprint = (file: SnapshotFile) => `${file.mode}:${file.version}:${createHash('sha256').update(file.bytes).digest('hex')}`;
const changed = () => new Fault('WORKSPACE_CHANGED', 'Workspace changed during capture; no checkpoint was published. Retry at the next useful edit boundary.', 409);
const transient = (error: unknown) => error instanceof Error && 'code' in error &&
  ['WORKSPACE_CHANGED', 'FILE_CHANGED', 'FILE_NOT_FOUND', 'ENOENT', 'ENOTDIR'].includes(String(error.code));

/** Builds an immutable Git tree without changing the working tree, ordinary index or
 * refs. Retries only observed filesystem races, within one deadline. The returned
 * interval is cooperatively verified, never a claim of filesystem atomicity. */
export class SnapshotCapture {
  private limits: Limits;
  private clock: () => number;
  private timeout: (ms: number) => AbortSignal;
  constructor(limits: Limits, clock: () => number = Date.now, timeout: (ms: number) => AbortSignal = AbortSignal.timeout) {
    this.limits = limits; this.clock = clock; this.timeout = timeout;
  }

  async capture(workspace: string, scratchPrefix: string, source: SnapshotSource, cancel?: AbortSignal): Promise<CapturedSnapshot> {
    const deadline = this.timeout(this.limits.checkpointCaptureTimeoutMs);
    const signal = cancel ? AbortSignal.any([cancel, deadline]) : deadline;
    // A crashed Git child may leave an index lock. Each invocation owns a fresh
    // directory, so recovery never steals that lock or consumes a stale index.
    const scratch = await mkdtemp(scratchPrefix + '-');
    const index = join(scratch, 'index');
    // Ambient Git routing must not redirect snapshot writes into another repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_INDEX_FILE: index, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' });
    const git = (args: string[], input?: Buffer): Promise<string> => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let inputError: Error | undefined;
      const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false',
        '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', '-C', workspace, ...args],
      { env, signal, maxBuffer: this.limits.maxFrameBytes }, (error, stdout) => {
        if (error || inputError) reject(error ?? inputError); else resolve(stdout.trim());
      });
      child.stdin!.on('error', error => { inputError = error; });
      child.stdin!.end(input);
    });
    try {
      for (let attempt = 1; attempt <= this.limits.checkpointCaptureAttempts; attempt++) {
        signal.throwIfAborted();
        const startedAt = this.clock();
        try {
          const files = (await source.files(signal)).sort();
          if (files.length > this.limits.maxWorkspaceFiles) throw new Fault('WORKSPACE_LIMIT', 'Workspace exceeds configured capture budget');
          const before = new Map<string, string>();
          const entries: string[] = [];
          let size = 0;
          await git(['read-tree', '--empty']);
          for (const path of files) {
            signal.throwIfAborted();
            const file = await source.read(path, signal);
            if (file.bytes.length > this.limits.maxFileBytes) throw new Fault('FILE_LIMIT', 'File exceeds configured capture budget');
            size += file.bytes.length;
            if (size > this.limits.maxWorkspaceBytes) throw new Fault('WORKSPACE_LIMIT', 'Workspace exceeds configured capture budget');
            before.set(path, fingerprint(file));
            // Feed the captured bytes directly: Git clean filters and working-tree
            // rereads would otherwise change the snapshot after we had inspected it.
            const blob = await git(['hash-object', '-w', '--no-filters', '--stdin'], file.bytes);
            entries.push(`${file.mode} ${blob}\t${path}\0`);
          }
          await git(['update-index', '-z', '--index-info'], Buffer.from(entries.join('')));
          const tree = await git(['write-tree']);
          if (JSON.stringify(files) !== JSON.stringify((await source.files(signal)).sort())) throw changed();
          for (const path of files) {
            signal.throwIfAborted();
            if (fingerprint(await source.read(path, signal)) !== before.get(path)) throw changed();
          }
          if (JSON.stringify(files) !== JSON.stringify((await source.files(signal)).sort())) throw changed();
          signal.throwIfAborted();
          return { tree, files, capture: { startedAt, finishedAt: this.clock(), policy: 'regular-files-v1', consistency: 'cooperative-verified', attempts: attempt } };
        } catch (error) {
          if (signal.aborted || !transient(error)) throw error;
          if (attempt === this.limits.checkpointCaptureAttempts) throw changed();
        }
      }
      throw changed();
    } catch (error) {
      if (cancel?.aborted) throw new Fault('CAPTURE_CANCELLED', 'Checkpoint capture was cancelled; no checkpoint was published', 409);
      if (deadline.aborted) throw new Fault('CAPTURE_TIMEOUT', 'Checkpoint capture exceeded its configured deadline; no checkpoint was published', 409);
      throw error;
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
