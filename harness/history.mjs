import { Context } from '@deepseek-ai/cordis';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

/** Read DSH logical records without mounting agent registry, loop, tools or provider. */
export async function readHistory(root, sessionId, { offset = 0, limit = 100 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid history page');
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root });
    const reader = await ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId);
      const { events } = await reader.read(offset, limit);
      return { header: reader.header, source: snapshot, offset, events, kind: 'persisted' };
    } finally { await reader.close(); }
  } finally { await ctx.fiber.dispose(); }
}
