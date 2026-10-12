import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { platform, release } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { applicationPaths } from '../src/paths.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQcEgAAAFEAMELjZZCAAAAAElFTkSuQmCC', 'base64');
const fileBytes = Buffer.from('Polariton attachment persistence verification.\n');
const sessionId = SessionId('storage-verification');
const budget = { childTimeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };

/** Exercise the unmodified Harness storage services without activating an agent or provider.
 * Each stage lives in a fresh process; only DSH_HOME selects attachment storage.
 */
async function exercise(stage) {
  assert.ok(process.env.DSH_HOME, 'Verification child requires an isolated DSH_HOME');
  const ctx = new Context();
  try {
    await ctx.plugin(LocalAttachmentStore, {});
    await ctx.plugin(JsonlSessionPersistence, { root: join(process.env.DSH_HOME, 'sessions') });
    if (stage === 'write') {
      const image = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'pixel.png' });
      const file = await ctx.attachments.saveFile({ data: fileBytes, name: 'evidence.txt' });
      const session = Session.create(sessionId, undefined, {
        version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1000, isSeeded: false,
      });
      const events = [
        session.append('turn/start', { turn: 1 }),
        session.append('user/message', createUserMessage({
          id: 'media-message', source: { kind: 'user' },
          content: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
        }), { surfaceOp: 'append' }),
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ];
      const writer = await ctx.sessionPersistence.create(session.header);
      try { await writer.append(events); await writer.flush(); } finally { await writer.close(); }
      return { image, file, events: events.length };
    }

    const reader = await ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const { events } = await reader.read();
      assert.deepEqual(events.map(event => event.type), ['turn/start', 'user/message', 'turn/end']);
      const content = events[1].data.content;
      assert.deepEqual(content.map(part => part.type), ['image', 'file']);
      const image = content[0].attachment, file = content[1].attachment;
      const storedImage = await ctx.attachments.readImage(image);
      assert.deepEqual(Buffer.from(storedImage.data), png, 'Persisted image bytes must survive a fresh process');
      const chunks = [];
      for await (const chunk of ctx.attachments.readFileStream(file)) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), fileBytes, 'Persisted file bytes must survive a fresh process');

      const imagePath = await ctx.attachments.imageHostPath(image);
      const filePath = await ctx.attachments.fileHostPath(file);
      for (const storedPath of [imagePath, filePath]) {
        const withinHome = relative(process.env.DSH_HOME, storedPath);
        assert.ok(withinHome && withinHome !== '..' && !withinHome.startsWith(`..${sep}`) && !isAbsolute(withinHome),
          'Harness must select the child DSH_HOME from its supported environment setting');
      }
      return { image, file, imagePath, filePath, events: events.length };
    } finally { await reader.close(); }
  } finally { await ctx.fiber.dispose(); }
}

/** Own only a unique qualification directory beneath the selected persistent data root.
 * Cleanup never removes an application root or app/environment data, even after failure.
 */
async function verify() {
  const paths = applicationPaths();
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(paths.data, 'verify-storage-'));
  const dshHome = join(directory, 'harness');
  let report;
  try {
    const exec = promisify(execFile), stages = [];
    for (const stage of ['write', 'read']) {
      const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), `--${stage}`], {
        env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' },
        timeout: budget.childTimeoutMs, maxBuffer: budget.maxOutputBytes,
      });
      stages.push(JSON.parse(stdout));
    }
    assert.deepEqual(stages[0].image, stages[1].image);
    assert.deepEqual(stages[0].file, stages[1].file);
    const versions = {};
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-session-persistence-jsonl']) {
      versions[name] = JSON.parse(await readFile(fileURLToPath(import.meta.resolve(`${name}/package.json`)), 'utf8')).version;
    }
    report = {
      status: 'pass', platform: platform(), release: release(), node: process.version, versions,
      profile: process.env.POLARITON_PROFILE ?? 'production', dataRoot: paths.data, dshHome,
      evidence: {
        dshHomeFromEnvironment: true, freshProcessReopen: true, persistedSessionReferences: true,
        fileBytes: fileBytes.length, imageBytes: png.length,
        fileSha256: createHash('sha256').update(fileBytes).digest('hex'),
        imageSha256: createHash('sha256').update(png).digest('hex'),
        imagePath: stages[1].imagePath, filePath: stages[1].filePath, events: stages[1].events,
      },
    };
  } finally { await rm(directory, { recursive: true, force: true }); }
  return { ...report, cleanedUp: true };
}

const mode = process.argv[2];
if (process.argv.length > 3 || (mode !== undefined && mode !== '--write' && mode !== '--read')) {
  throw new Error('Usage: node scripts/verify-storage.mjs');
}
console.log(JSON.stringify(mode ? await exercise(mode.slice(2)) : await verify()));
