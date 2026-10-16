import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {chmod, link, lstat, mkdir, mkdtemp, open, opendir, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {Config} from './config.ts';
import {Fault} from './contracts.ts';

type Limits = Pick<Config, 'checkpointTimeoutMs' | 'checkpointMaxProcesses' | 'checkpointOutputBytes' | 'checkpointBufferBytes' | 'checkpointKillGraceMs'>;
type Entry = {mode: '100644' | '100755'; object: string; path: string};
const conflict = (message: string) => new Fault('PROVISION_CONFLICT', message);
const lfsHeader = Buffer.from('version https://git-lfs.github.com/spec/v1\n');

/** Materializes retained Git bytes as an independent repository with one root commit.
 * Import never runs clean/smudge filters or source hooks, copies ancestry/configuration,
 * overwrites existing work, or buffers complete files. Repeating an interrupted import
 * accepts identical retained files and rejects conflicts. External payloads and symlinks
 * are explicitly unsupported rather than represented as completely restored contents. */
export class CheckpointContent {
  private limits: Limits;
  private targets = new Set<string>();
  constructor(limits: Limits) { this.limits = limits; }

  async initializeFromCheckpoint(source: string, commit: string, target: string, cancel?: AbortSignal): Promise<void> {
    target = resolve(target);
    if (this.targets.has(target) || this.targets.size >= this.limits.checkpointMaxProcesses)
      throw new Fault('CHECKPOINT_BUSY', 'Another retained-content import is using the available Git capacity; retry shortly');
    this.targets.add(target);
    const timeout = AbortSignal.timeout(this.limits.checkpointTimeoutMs);
    const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
    let scratch: string | undefined;
    try {
      signal.throwIfAborted();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw conflict('Inheritance requires an exact retained commit identity');
      if (resolve(source) === target) throw conflict('Inheritance requires a new independent destination');
      // Resolve immutable identities once. Each invocation runs at most one Git process.
      const tree = await this.git(source, ['rev-parse', '--verify', `${commit}^{tree}`], signal);
      const format = await this.git(source, ['rev-parse', '--show-object-format'], signal);
      if (!['sha1', 'sha256'].includes(format)) throw conflict('Source uses an unsupported Git object format');
      await mkdir(target, {recursive: true});
      if (!(await lstat(target)).isDirectory()) throw conflict('Inheritance destination must be a real directory');
      const gitPath = join(target, '.git');
      const gitStat = await lstat(gitPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (gitStat && !gitStat.isDirectory()) throw conflict('Inheritance destination must own an independent Git directory');
      if (!gitStat) await this.git(target, ['init', '--quiet', '--initial-branch=main', `--object-format=${format}`], signal);
      if (await this.git(target, ['rev-parse', '--show-object-format'], signal) !== format)
        throw conflict('Inheritance source and destination use different Git object formats');
      const head = await this.git(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, undefined, true);
      if (head) {
        if (await this.git(target, ['rev-parse', `${head}^{tree}`], signal) !== tree ||
          (await this.git(target, ['rev-list', '--parents', '-n', '1', head], signal)).split(' ').length !== 1)
          throw conflict('Interrupted inheritance conflicts with an existing commit');
      }
      // Provisioning owns this unpublished destination. A previous daemon may have
      // died with a very large partial blob; reclaim only this module's reserved
      // mkdtemp directory names, never following links or touching other Git data.
      for await (const entry of await opendir(gitPath)) {
        signal.throwIfAborted();
        if (entry.isDirectory() && /^polariton-inherit-[A-Za-z0-9]{6}$/.test(entry.name))
          await rm(join(gitPath, entry.name), {recursive: true});
      }
      scratch = await mkdtemp(join(gitPath, 'polariton-inherit-'));
      const manifest = join(scratch, 'tree');
      await this.git(source, ['ls-tree', '-r', '-l', '-z', '--full-tree', tree], signal, manifest);
      // Validate entry semantics before publishing any file. The manifest stays on disk,
      // so inventories larger than a diagnostic/preview budget remain admissible.
      for await (const _ of this.entries(manifest, signal)) { /* Validate every retained entry. */ }
      await this.git(target, ['read-tree', '--empty'], signal);
      for await (const entry of this.entries(manifest, signal)) {
        const destination = join(target, entry.path);
        let directory = target;
        for (const component of entry.path.split('/').slice(0, -1)) {
          directory = join(directory, component);
          try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          if (!(await lstat(directory)).isDirectory()) throw conflict(`Inheritance path traverses a non-directory: ${entry.path}`);
        }
        const temporary = join(scratch, 'blob');
        await this.git(source, ['cat-file', 'blob', entry.object], signal, temporary);
        const file = await open(temporary, 'r');
        try {
          const prefix = Buffer.alloc(lfsHeader.length);
          const {bytesRead} = await file.read(prefix, 0, prefix.length, 0);
          if (bytesRead === prefix.length && prefix.equals(lfsHeader))
            throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', `Git LFS payload is external to the retained checkpoint: ${entry.path}`);
          await chmod(temporary, entry.mode === '100755' ? 0o755 : 0o644);
          await file.sync();
        } finally { await file.close(); }
        const object = await this.git(target, ['hash-object', '-w', '--no-filters', '--', temporary], signal);
        if (object !== entry.object) throw conflict(`Retained content changed during inheritance: ${entry.path}`);
        try { await link(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await lstat(destination);
          if (!existing.isFile() || ((existing.mode & 0o111) !== 0) !== (entry.mode === '100755') ||
            await this.git(target, ['hash-object', '--no-filters', '--', destination], signal) !== entry.object)
            throw conflict(`Interrupted inheritance conflicts with existing content: ${entry.path}`);
        }
        await rm(temporary);
        for (let parent = dirname(destination); ; parent = dirname(parent)) {
          const handle = await open(parent, 'r'); try { await handle.sync(); } finally { await handle.close(); }
          if (parent === target) break;
        }
        await this.git(target, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.object},${entry.path}`], signal);
      }
      // Unselected files (including ignored files) indicate external/interrupted work;
      // never silently claim that the destination is the selected retained workspace.
      const extra = join(scratch, 'extra');
      await this.git(target, ['ls-files', '--others', '-z'], signal, extra);
      if ((await lstat(extra)).size) throw conflict('Inheritance destination contains files absent from the selected checkpoint');
      if (await this.git(target, ['write-tree'], signal) !== tree)
        throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', 'Selected tree contains entries that cannot be faithfully inherited');
      if (!head) {
        const initial = await this.git(target, ['-c', 'user.name=Polariton', '-c', 'user.email=polariton@localhost',
          'commit-tree', tree, '-m', 'Initialize independent research workspace'], signal);
        await this.git(target, ['update-ref', 'HEAD', initial, '0'.repeat(initial.length)], signal);
      }
    } finally {
      try { if (scratch) await rm(scratch, {recursive: true, force: true}); }
      finally { this.targets.delete(target); }
    }
  }

  /** Parse one bounded tree record at a time; Git filenames are decoded only after
   * NUL framing, so spaces/newlines never become separators or shell syntax. */
  private async *entries(manifest: string, signal: AbortSignal): AsyncGenerator<Entry> {
    let pending = Buffer.alloc(0);
    const stream = createReadStream(manifest, {highWaterMark: this.limits.checkpointBufferBytes, signal});
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end: number;
      while ((end = pending.indexOf(0)) !== -1) {
        const record = pending.subarray(0, end), text = record.toString('utf8');
        if (record.length > this.limits.checkpointOutputBytes)
          throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', 'Retained path exceeds the configured Git record budget');
        pending = pending.subarray(end + 1);
        if (!Buffer.from(text).equals(record)) throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', 'Non-UTF-8 Git paths cannot be inherited');
        const parsed = /^(\d{6}) (blob|commit) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(text);
        if (!parsed || !['100644', '100755'].includes(parsed[1]) || parsed[2] !== 'blob')
          throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', 'Checkpoint inheritance supports regular files and executable files; symlinks and submodules require explicit materialization');
        const path = parsed[5], parts = path.split('/');
        if (path.includes('\\') || parts.some(part => !part || part === '.' || part === '..' || ['.git', '.polariton'].includes(part.toLowerCase())))
          throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', `Unsafe retained path cannot be inherited: ${path}`);
        yield {mode: parsed[1] as Entry['mode'], object: parsed[3], path};
      }
      if (pending.length > this.limits.checkpointOutputBytes)
        throw new Fault('UNSUPPORTED_CHECKPOINT_CONTENT', 'Retained path exceeds the configured Git record budget');
    }
    if (pending.length) throw conflict('Retained tree inventory is incomplete');
  }

  /** Own the complete subprocess lifetime, including descendants on cancellation.
   * Binary output goes directly to disk; only bounded diagnostics enter memory. */
  private async git(workspace: string, args: string[], signal: AbortSignal, output?: string, missing = false): Promise<string> {
    signal.throwIfAborted();
    const env = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0'};
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync', '-C', workspace, ...args],
      {env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    let failure: Error | undefined, bytes = 0, stdout = '', stderr = '', killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error; }
    };
    const stop = (error: Error) => {
      failure ??= error;
      if (!killTimer) { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), this.limits.checkpointKillGraceMs); }
    };
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error('Checkpoint inheritance cancelled'));
    signal.addEventListener('abort', abort, {once: true});
    const collect = (chunk: Buffer, diagnostic: boolean) => {
      bytes += chunk.length;
      if (bytes > this.limits.checkpointOutputBytes) { stop(new Fault('CHECKPOINT_OUTPUT_LIMIT', 'Git diagnostic output exceeded its configured budget')); return; }
      if (diagnostic) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stderr.on('data', chunk => collect(chunk, true));
    if (!output) child.stdout.on('data', chunk => collect(chunk, false));
    const transfer = output ? pipeline(child.stdout, createWriteStream(output, {flags: 'wx', highWaterMark: this.limits.checkpointBufferBytes}))
      .catch(error => { stop(error); }) : Promise.resolve();
    const completed = new Promise<number | null>(resolve => {
      child.on('error', error => { failure ??= error; });
      child.on('close', code => resolve(code));
    });
    if (signal.aborted) abort();
    const code = await completed;
    await transfer;
    signal.removeEventListener('abort', abort);
    if (killTimer) { clearTimeout(killTimer); kill('SIGKILL'); }
    if (failure) throw failure;
    if (code !== 0 && !(missing && code === 1))
      throw new Fault('CHECKPOINT_GIT_FAILED', `Git could not inherit retained content: ${stderr.trim() || `exit ${code}`}`);
    return stdout.trim();
  }
}
