// @ts-check
import {createScope} from '@deepseek-ai/dsh-scope';
import {validateJsonSchemaValue} from '@deepseek-ai/dsh-tools';
import {z} from 'zod';
import {JobId} from '@deepseek-ai/dsh-jobs';
const WaitInput=z.object({job_id:z.string(),wait:z.boolean().optional(),timeout_ms:z.number().optional()}).passthrough();

export const inject = ['tools', 'agents', 'jobs'];
import {JobObservationSettings} from './settings.ts';

/**
 * Yield job observations to guidance while DSH owns execution and output cursors.
 * A scoped definition retains the upstream schema, limits and result projection.
 * Its observation signal never replaces the outer tool signal: DSH would otherwise
 * discard a successful, already-consumed output when guidance races completion.
 * The pinned jobs API rejects a validated owned wait only for observer cancellation;
 * job failures settle normally. Contract tests qualify that boundary, including
 * cancellation, failed jobs, timeout, completion races and retained stream output.
 */
/** @param {import('@deepseek-ai/cordis').Context} ctx @param {unknown} config */
export function apply(ctx, config) {
  const limits = JobObservationSettings.parse(config ?? {});
  ctx.on('agent/created', ({agent}) => {
    const original = ctx.tools.get('job_output', agent);
    if (!original) return;
    const scope = createScope(ctx, agent);
    agent.ctx.effect(() => scope.rawDispose);
    scope.ctx.tools.register({...original, async execute(args, exec) {
      // Upstream retains ownership of malformed-argument errors and every read.
      const parsed=WaitInput.safeParse(args);
      if (validateJsonSchemaValue(original.parameters,args,'').length || !parsed.success || parsed.data.wait !== true || !parsed.data.job_id.length) return original.execute(args, exec);
      const input=parsed.data,id=JobId(input.job_id);
      const timeout = Math.min(input.timeout_ms ?? limits.waitTimeoutMs, limits.maxWaitTimeoutMs);
      if (!Number.isFinite(timeout) || timeout<=0) return original.execute(args, exec);
      ctx.jobs.get(id, agent.id);
      const guidance = new AbortController();
      const queued = () => agent.inbox.nextStep.some(message => message.source.kind === 'user' || message.source.kind === 'polariton-worker');
      const release = ctx.on('session/event', (session, event) => {
        if (session.id === agent.id && event.type === 'agent/inbox/spliced'
          && event.data.target === 'next-step' && queued()) guidance.abort();
      });
      try {
        if (queued()) guidance.abort();
        await ctx.jobs.wait(id,timeout,agent.id,AbortSignal.any([exec.signal,guidance.signal]));
      } catch (error) {
        if (exec.signal.aborted || !guidance.signal.aborted) throw error;
      } finally { release(); }
      exec.signal.throwIfAborted();
      return original.execute({...input,wait:false},exec);
    }});
  });
}
