import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createCapability, fixtureState } from './capability.mjs';
import { serveCapability } from '../../../environment/server.mjs';

const version = z.coerce.number().int().min(1).max(2).parse(process.env.POLARITON_FIXTURE_VERSION ?? '1');
const state = fixtureState();
const token = process.env.POLARITON_FIXTURE_CONTROL_TOKEN;
const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('release'), barrier: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal('resource'), mode: z.enum(['normal', 'error', 'malformed', 'malformed-envelope', 'oversized']), delayMs: z.number().int().min(0).max(60000).default(0), bytes: z.number().int().min(0).max(16777216).default(0) }).strict(),
  z.object({ action: z.literal('crash') }).strict(),
  z.object({ action: z.literal('exhaust'), mode: z.enum(['cpu', 'memory', 'output', 'disk', 'helpers']) }).strict(),
]);
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const authorized = req => {
  const actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
  return Boolean(token) && actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** Fault controls are a distinct verifier-only surface, never advertised to an agent as MCP tools. */
async function onRequest(req, res) {
  if (!['/control', '/evidence'].includes(req.url)) return false;
  if (!authorized(req)) { reply(res, 401, { error: 'Verifier authorization required' }); return true; }
  if (req.url === '/evidence' && req.method === 'GET') {
    reply(res, 200, { version, calls: state.calls, waiting: [...state.waiting.keys()], resource: state.resource }); return true;
  }
  if (req.url !== '/control' || req.method !== 'POST') { reply(res, 405, { error: 'Method not allowed' }); return true; }
  try {
    let body = ''; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) { reply(res, 413, { error: 'Control request too large' }); return true; } body += chunk; }
    const control = controlSchema.parse(JSON.parse(body));
    if (control.action === 'release') {
      const pending = [...state.waiting].filter(([key]) => key.startsWith(`${control.barrier}:`));
      for (const [, release] of pending) release();
      reply(res, 200, { released: pending.length });
    } else if (control.action === 'resource') {
      state.resource = { mode: control.mode, delayMs: control.delayMs, bytes: control.bytes }; reply(res, 200, state.resource);
    } else if (control.action === 'crash') {
      reply(res, 200, { scheduled: 'crash' }); setImmediate(() => process.exit(71));
    } else {
      if (process.env.POLARITON_FIXTURE_DESTRUCTIVE !== '1' || !existsSync('/.dockerenv')) { reply(res, 409, { error: 'Destructive fixture requires an explicitly enabled container' }); return true; }
      const child = spawn(process.execPath, [fileURLToPath(new URL('./exhaust.mjs', import.meta.url)), control.mode], { stdio: 'inherit' });
      child.on('error', error => process.stderr.write(`${error.message}\n`));
      reply(res, 200, { pid: child.pid, mode: control.mode });
    }
  } catch (error) { reply(res, 400, { error: error.message }); }
  return true;
}

const listener = await serveCapability({ createServer: () => createCapability(version, state), onRequest });
process.stdout.write(`${JSON.stringify({ event: 'fixture.ready', port: listener.address().port, version })}\n`);
