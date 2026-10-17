import { parentPort, workerData } from 'node:worker_threads';
import { Context } from '@deepseek-ai/cordis';
import {Session,SessionId} from '@deepseek-ai/dsh-session';
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
import {TokenMeter} from '@deepseek-ai/dsh-token-meter';
import * as SessionStats from '@deepseek-ai/dsh-session-stats';
import {sessionMetrics} from './metrics.ts';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

// Execution-free persistence and projection reader. No agent, loop, tools or provider is mounted.
const ctx = new Context();
try {
  await ctx.plugin(JsonlSessionPersistence, { root: workerData.root });
  const reader = await ctx.sessionPersistence.open(workerData.sessionId, 'read');
  try {
    const events = []; let bytes = 0;
    for (;;) {
      const page = await reader.read(events.length, Math.min(workerData.pageSize, workerData.maxEvents + 1 - events.length));
      if (!page.events.length) break;
      for (const event of page.events) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > workerData.maxBytes || events.length >= workerData.maxEvents) throw new Error('HISTORY_LIMIT');
        events.push(event);
      }
      if (page.events.length < workerData.pageSize) break;
    }
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(TokenMeter,{});
    await ctx.plugin(SessionStats);
    // The detached replay is never registered with a session store or persistence.
    // DSH's in-memory end-seed marker contributes to none of these projections.
    const session=Session.create(SessionId(workerData.sessionId),events);
    parentPort.postMessage({ events, metrics:sessionMetrics(ctx,session), version: reader.header.version });
  } finally { await reader.close(); }
} catch (error) { parentPort.postMessage({ error: error.message === 'HISTORY_LIMIT' ? 'HISTORY_LIMIT' : 'HISTORY_UNAVAILABLE' }); }
finally { await ctx.fiber.dispose(); }
