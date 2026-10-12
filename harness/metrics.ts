import type {} from '@deepseek-ai/dsh-session-stats/client';
import type {} from '@deepseek-ai/dsh-token-meter/client';
import type {Context} from '@deepseek-ai/cordis';
import type {Session} from '@deepseek-ai/dsh-session';
import {SessionMetrics} from '../src/metrics.ts';
/** Read DSH's public projection seat at the same cut as the source records.
 * No Polariton accounting rules, provider calls, or persisted derived totals. */
export function sessionMetrics(ctx:Context,session:Session):SessionMetrics {
 return SessionMetrics.parse(ctx.sessionProjections.snapshot(session,
  ['tokenUsage','sessionStats','contextPressure','contextBreakdown']).values);
}
