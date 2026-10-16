import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Checkpoint, CheckpointPublication, Fault } from './contracts.ts';
import type { Config } from './config.ts';

const Intent = z.object({
  workspace: z.string(), branch: z.string(), parent: z.string(),
  publication: CheckpointPublication,
  phase: z.enum(['staging', 'committing', 'selected']),
  selected: Checkpoint.optional(), logVersion: z.string().optional(),
}).strict();
type Intent = z.infer<typeof Intent>;
type Row = { project: string; node: string; kind: string; payload: string; state: string };
type Limits = Pick<Config, 'checkpointTimeoutMs' | 'checkpointMaxProcesses' | 'checkpointOutputBytes' | 'checkpointKillGraceMs'>;
const conflict = (message: string) => new Fault('CHECKPOINT_RECOVERY_CONFLICT', message, 409);

/** Publishes ordinary Git commits as retained research milestones. The journal
 * binds each request to its exact result across uncertain subprocess exits;
 * callers never manage Git phases or infer success from the current HEAD. */
export class GitCheckpoints {
  private readonly db: DatabaseSync;
  private readonly limits: Limits;
  private readonly clock: () => number;
  private active = 0;

  constructor(db: DatabaseSync, limits: Limits, clock: () => number) {
    this.db = db; this.limits = limits; this.clock = clock;
  }

  async recover(project: string, node: string, workspace: string, id: string, signal: AbortSignal): Promise<Checkpoint> {
    const row = this.db.prepare('SELECT payload FROM operations WHERE id=?').get(id) as {payload:string};
    const intent = Intent.parse(JSON.parse(row.payload));
    return this.publish(project, node, workspace, id, intent.publication, signal, true);
  }

  async publish(project: string, node: string, workspace: string, id: string, publication: CheckpointPublication,
    cancel: AbortSignal, recovering = false): Promise<Checkpoint> {
    if (this.active >= this.limits.checkpointMaxProcesses) throw new Fault('CHECKPOINT_BUSY', 'Checkpoint execution capacity is occupied; retry this request.', 409);
    this.active++;
    const deadline = AbortSignal.timeout(this.limits.checkpointTimeoutMs);
    const signal = AbortSignal.any([cancel, deadline]);
    try {
      const prior = this.db.prepare('SELECT project,node,kind,payload,state FROM operations WHERE id=?').get(id) as Row | undefined;
      let intent: Intent;
      if (prior) {
        if (prior.project !== project || prior.node !== node || prior.kind !== 'checkpoint')
          throw new Fault('OPERATION_CONFLICT', 'Checkpoint identity belongs to another operation');
        intent = Intent.parse(JSON.parse(prior.payload));
        // A worker may retry after reactivation under a new process. Bind the
        // request to its durable actor and preserve the original process evidence.
        if (intent.workspace !== workspace || intent.publication.publisher.kind !== publication.publisher.kind ||
          intent.publication.publisher.id !== publication.publisher.id || (intent.publication.note ?? null) !== (publication.note ?? null))
          throw new Fault('OPERATION_CONFLICT', 'Checkpoint identity belongs to different publication input or workspace');
        if (prior.state === 'complete') return Checkpoint.parse(intent.selected);
        await this.repository(workspace,signal);
      } else {
        const unfinished = this.db.prepare("SELECT id FROM operations WHERE project=? AND node=? AND kind='checkpoint' AND state!='complete' LIMIT 1").get(project,node) as {id:string} | undefined;
        if (unfinished) throw conflict(`Resolve checkpoint ${unfinished.id} before starting another publication in this node.`);
        const state = await this.state(workspace, signal);
        intent = {workspace, ...state, publication, phase:'staging'};
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?)').run(id, project, node, 'checkpoint', JSON.stringify(intent), 'pending');
      }
      const save = () => this.db.prepare('UPDATE operations SET payload=? WHERE id=?').run(JSON.stringify(intent), id);
      const pendingRef = `refs/polariton/publications/${id}`;
      const select = async (commit: string) => {
        const pending = await this.git(workspace,['rev-parse','--verify','--quiet',pendingRef],signal,[0,1]);
        if (pending.code === 0 && pending.stdout.trim() !== commit) throw conflict('Pending checkpoint reference conflicts with the selected result.');
        if (pending.code !== 0) await this.git(workspace,['update-ref',pendingRef,commit,'0'.repeat(commit.length)],signal);
        intent.selected = Checkpoint.parse({id, nodeId:node, commit, createdAt:this.clock(), publisher:intent.publication.publisher, note:intent.publication.note ?? null});
        intent.phase = 'selected'; save();
      };
      if (intent.phase === 'staging') {
        // A no-change selection can retain HEAD immediately before a crash that
        // prevents the selected phase reaching SQLite. Its ref is exact evidence.
        const retained = await this.git(workspace,['rev-parse','--verify','--quiet',pendingRef],signal,[0,1]);
        if (retained.code === 0) {
          if (retained.stdout.trim() !== intent.parent) throw conflict('Pending unchanged checkpoint differs from its original HEAD.');
          await select(intent.parent);
        } else if (recovering) throw conflict(`Checkpoint ${id} stopped before commit; retry that request to continue publication.`);
      }
      if (intent.phase === 'committing') {
        const commit = await this.identify(workspace, id, intent, signal);
        if (commit) await select(commit);
        else {
          if (recovering) throw conflict(`Checkpoint ${id} has no recoverable commit; retry the original request after inspecting Git state.`);
          // Only repeat when Git still has the journaled branch/parent and no
          // matching commit exists, including in reflogs. Never reset user state.
          await this.unchanged(workspace, intent, signal);
          intent.phase = 'staging'; save();
        }
      }
      if (intent.phase === 'staging') {
        await this.unchanged(workspace, intent, signal);
        // Protect application-owned state even if a user changes ignore rules.
        const internal = await this.git(workspace, ['ls-files', '--', '.polariton', ':(glob)**/.polariton/**'], signal);
        if (internal.stdout) throw new Fault('CHECKPOINT_STATE', 'Polariton internal files are tracked; remove them from Git before publishing.', 409);
        await this.git(workspace, ['add', '-A', '--', '.', ':(exclude).polariton', ':(exclude,glob)**/.polariton/**'], signal);
        await this.unchanged(workspace, intent, signal);
        const difference = await this.git(workspace, ['diff', '--cached', '--quiet', '--no-ext-diff', 'HEAD', '--'], signal, [0,1]);
        if (difference.code === 0) await select(intent.parent);
        else {
          intent.logVersion = await this.logVersion(workspace,intent.branch);
          intent.phase = 'committing'; save();
          const message = `${publication.note ?? 'Shared workspace checkpoint'}\n\nPolariton-Checkpoint: ${id}`;
          await this.git(workspace, ['-c','user.name=Polariton','-c','user.email=polariton@localhost',
            'commit', '--quiet', '--cleanup=verbatim', '-m', message], signal);
          const commit = await this.identify(workspace, id, intent, signal);
          if (!commit) throw conflict('Git returned without a commit carrying this publication identity; inspect hooks and retry the original request.');
          await select(commit);
        }
      }
      const selected = Checkpoint.parse(intent.selected);
      const ref = `refs/polariton/checkpoints/${id}`;
      const retained = await this.git(workspace, ['rev-parse', '--verify', '--quiet', ref], signal, [0,1]);
      if (retained.code === 0) {
        if (retained.stdout.trim() !== selected.commit) throw new Fault('CHECKPOINT_REF_CONFLICT', 'Retained checkpoint reference differs from its journal', 409);
      }
      const pending = await this.git(workspace,['rev-parse','--verify','--quiet',pendingRef],signal,[0,1]);
      if (pending.code === 0 && pending.stdout.trim() !== selected.commit) throw conflict('Pending checkpoint reference changed during publication.');
      const updates = [retained.code !== 0 ? `create ${ref} ${selected.commit}` : '',
        pending.code === 0 ? `delete ${pendingRef} ${selected.commit}` : ''].filter(Boolean);
      if (updates.length) await this.git(workspace,['update-ref','--stdin'],signal,[0],`start\n${updates.join('\n')}\nprepare\ncommit\n`);
      signal.throwIfAborted();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT OR IGNORE INTO checkpoints VALUES (?,?,?,?,?)').run(id, project, node, selected.createdAt, JSON.stringify(selected));
        this.db.prepare("UPDATE operations SET state='complete' WHERE id=?").run(id);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return selected;
    } catch (error) {
      if (cancel.aborted) throw new Fault('CHECKPOINT_CANCELLED', 'Checkpoint execution stopped; staged work or a commit may remain. Retry the original request to reconcile it.', 409);
      if (deadline.aborted) throw new Fault('CHECKPOINT_TIMEOUT', 'Checkpoint exceeded its execution deadline; inspect Git and retry the original request.', 409);
      throw error;
    } finally { this.active--; }
  }

  private async unchanged(workspace: string, intent: Intent, signal: AbortSignal) {
    const state = await this.state(workspace, signal);
    if (state.branch !== intent.branch || state.parent !== intent.parent)
      throw conflict('Git branch or HEAD changed during publication; reconcile the original request without resetting user work.');
  }

  /** Only a uniquely identified direct child can complete an uncertain commit.
   * Reflogs preserve evidence if an external command moved HEAD after creation. */
  private async identify(workspace: string, id: string, intent: Intent, signal: AbortSignal): Promise<string | undefined> {
    const marker = `Polariton-Checkpoint: ${id}`;
    const matches = (await this.git(workspace, ['log','--all','--reflog','--fixed-strings',`--grep=${marker}`,
      '--format=%H','--max-count=2'], signal)).stdout.trim().split('\n').filter(Boolean);
    if (matches.length > 1) throw conflict('Several Git commits carry this publication identity; inspect history before recovering.');
    if (!matches.length) {
      await this.unchanged(workspace, intent, signal);
      // HEAD alone cannot distinguish a failed commit from commit/reset/prune.
      // A retry is safe only while both pre-attempt reflogs remain unchanged.
      if (!intent.logVersion || await this.logVersion(workspace,intent.branch) !== intent.logVersion)
        throw conflict('Publication commit evidence is missing or Git reflogs changed; inspect the original request and history before recovery.');
      return undefined;
    }
    const commit = matches[0]!;
    const parent = (await this.git(workspace, ['show','-s','--format=%P',commit], signal)).stdout.trim();
    const message = (await this.git(workspace, ['show','-s','--format=%B',commit], signal)).stdout.trimEnd();
    if (parent !== intent.parent || message.split('\n').filter(line => line === marker).length !== 1 || !message.endsWith(marker))
      throw conflict('Git commit parent or publication trailer differs from the recorded request; inspect hooks and history.');
    const branch = (await this.git(workspace, ['symbolic-ref','--quiet','HEAD'], signal, [0,1])).stdout.trim();
    if (branch !== intent.branch) throw conflict('The checked-out branch changed during publication; restore its expected context before recovery.');
    return commit;
  }

  /** Reflog identity guards the uncertain no-commit case. Missing logs cannot
   * prove that a commit never happened and therefore never authorize a retry. */
  private async logVersion(workspace: string, branch: string): Promise<string | undefined> {
    const versions: string[] = [];
    for (const name of ['HEAD',branch]) {
      try {
        const info = await lstat(join(workspace,'.git','logs',name),{bigint:true});
        if (!info.isFile()) return undefined;
        versions.push(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }
    return versions.join('/');
  }

  private async repository(workspace: string, signal: AbortSignal): Promise<string> {
    if (await realpath(workspace) !== workspace || await realpath(join(workspace,'.git')) !== join(workspace,'.git'))
      throw new Fault('CHECKPOINT_STATE', 'Checkpoint repository binding changed', 409);
    const root = (await this.git(workspace,['rev-parse','--show-toplevel'],signal)).stdout.trim();
    const gitdir = (await this.git(workspace,['rev-parse','--absolute-git-dir'],signal)).stdout.trim();
    if (root !== workspace || gitdir !== join(workspace,'.git')) throw new Fault('CHECKPOINT_STATE','Use the node’s independent Git repository.',409);
    return gitdir;
  }

  private async state(workspace: string, signal: AbortSignal): Promise<{branch:string;parent:string}> {
    const gitdir = await this.repository(workspace,signal);
    const branch = await this.git(workspace,['symbolic-ref','--quiet','HEAD'],signal,[0,1]);
    const parent = await this.git(workspace,['rev-parse','--verify','--quiet','HEAD^{commit}'],signal,[0,1]);
    if (branch.code || parent.code) throw new Fault('CHECKPOINT_STATE','Checkout a branch with an initial commit before publishing.',409);
    for (const entry of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG']) {
      try { await lstat(join(gitdir,entry)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Fault('CHECKPOINT_STATE',`Finish or abort the Git operation (${entry}) before publishing.`,409);
    }
    if ((await this.git(workspace,['ls-files','--unmerged'],signal)).stdout)
      throw new Fault('CHECKPOINT_STATE','Resolve Git index conflicts before publishing.',409);
    return {branch:branch.stdout.trim(),parent:parent.stdout.trim()};
  }

  /** Bound diagnostics, not file contents. Cancellation waits for process-group
   * settlement so a hook cannot continue writing after publication is unlocked. */
  private git(workspace: string, args: string[], signal: AbortSignal, codes = [0], input?: string): Promise<{stdout:string;code:number}> {
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true'});
      const child = spawn('git',['-c','core.logAllRefUpdates=always','-c','gc.auto=0','-c','maintenance.auto=false','-c','core.fsync=all','-c','core.fsyncMethod=fsync','-C',workspace,...args],
        {env,detached:true,stdio:['pipe','pipe','pipe']});
      let failure: Error | undefined, stdout = '', stderr = '', size = 0;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid,signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error; }
      };
      const stop = () => {
        kill('SIGTERM');
        escalation ??= setTimeout(() => kill('SIGKILL'),this.limits.checkpointKillGraceMs);
      };
      const abort = () => { failure ??= new Error('Git execution cancelled'); stop(); };
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
      const collect = (bytes: Buffer, output: boolean) => {
        size += bytes.length;
        if (size > this.limits.checkpointOutputBytes) {
          failure ??= new Fault('CHECKPOINT_GIT','Git diagnostics exceeded the configured output budget; inspect repository hooks.'); stop();
        } else if (output) stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
      };
      child.stdin.on('error',error => { failure ??= error; stop(); });
      child.stdin.end(input);
      child.stdout.on('data',(bytes:Buffer) => collect(bytes,true));
      child.stderr.on('data',(bytes:Buffer) => collect(bytes,false));
      child.once('error',error => { failure ??= error; });
      child.once('close',code => {
        signal.removeEventListener('abort',abort);
        // Hooks may leave redirected background descendants after Git closes its pipes.
        // Terminate the owned group on every outcome, before releasing the operation.
        kill('SIGKILL');
        if (escalation) clearTimeout(escalation);
        if (failure) reject(failure);
        else if (code === null || !codes.includes(code)) reject(new Fault('CHECKPOINT_GIT',`Git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
        else resolve({stdout,code});
      });
    });
  }
}
