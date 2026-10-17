import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';

/** Original one-pixel image and inert file retained through DSH's public attachment contract. */
export async function persistMedia(home, sessionId, fileText = '<script>untrusted research result</script>') {
  const ctx = new Context();
  try {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home });
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC', 'base64');
    const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'pixel.png' });
    const fileBytes = Buffer.from(fileText);
    const file = await ctx.attachments.saveFile({ data: fileBytes, name: 'result.html' });
    const imagePath = await ctx.attachments.imageHostPath(image);
    const id = SessionId(sessionId);
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false });
    const events = [session.append('turn/start', { turn: 1 }), session.append('user/message', createUserMessage({
      id: 'media-message', source: { kind: 'user' }, content: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
    }), { surfaceOp: 'append' }), session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })];
    const writer = await ctx.sessionPersistence.create(session.header);
    try { await writer.append(events); await writer.flush(); } finally { await writer.close(); }
    return { png, fileBytes, image, file, imagePath, events };
  } finally { await ctx.fiber.dispose(); }
}
