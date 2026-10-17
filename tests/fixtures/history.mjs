import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

/** Create a real DSH-owned log whose compacted source and interrupted tail remain inspectable.
 * This original fixture uses the public DSH 0.2.1-rc.2 compaction contract;
 * format 4 requires compaction to finish inside its owning open turn.
 */
export async function persistHistory(root, sessionId = 'history-compaction-interruption') {
  const id = SessionId(sessionId);
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false,
  });
  const events = [];
  const append = (type, data, options) => {
    const event = session.append(type, data, options);
    events.push(event);
    return event;
  };
  const user = (id, text, source = { kind: 'user' }) => createUserMessage({
    id, content: [{ type: 'text', text }], source,
  });
  append('turn/start', { turn: 1 });
  const original = append('user/message', user('original-message', 'Original research evidence.'), { surfaceOp: 'append' });
  const compactionId = CompactionId('history-compaction');
  const summary = [{ type: 'text', text: 'A compacted research checkpoint.' }];
  const start = append('compaction/start', { compactionId, turn: 1 });
  const summarized = append('compaction/summary', {
    compactionId, summary, shadowedRange: { start: original.seq, end: original.seq },
    shadowedSeqs: [original.seq], shadowedTokenCount: 4, provider: 'fixture', model: 'fixture',
  });
  append('user/message', user('checkpoint-message', summary[0].text, compactCheckpointSource(compactionId)), {
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [start.seq, summarized.seq, original.seq],
  });
  append('compaction/end', { compactionId, turn: 1 });
  append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  append('turn/start', { turn: 2 });
  append('user/message', user('interrupted-message', 'Work interrupted before a model result.'), { surfaceOp: 'append' });
  append('step/start', { turn: 2, step: 1 });

  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, { root });
    const writer = await ctx.sessionPersistence.create(session.header);
    try {
      await writer.append(events);
      await writer.flush();
    } finally { await writer.close(); }
  } finally { await ctx.fiber.dispose(); }
  return { id, events, original, compactionId };
}
