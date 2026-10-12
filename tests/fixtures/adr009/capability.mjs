import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const numbers = z.array(z.number().finite()).min(1).max(10000);
const resultSchema = z.object({ count: z.number().int(), mean: z.number(), standardDeviation: z.number() });
const success = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

/** Shared fixture state makes concurrent sessions independently observable without timing races. */
export function fixtureState() {
  return { calls: [], waiting: new Map(), children: [], resource: { mode: 'normal', delayMs: 0, bytes: 0 } };
}

/** Controlled test capability; scientific calculations are independently checked by the test oracle. */
export function createCapability(version, state) {
  if (![1, 2].includes(version)) throw new Error('Fixture version must be 1 or 2');
  const server = new McpServer({ name: 'polariton-adr009-fixture', version: `${version}.0.0` });
  const record = (name, args, value) => {
    state.calls.push({ name, args, result: value, version });
    return success(value);
  };
  server.registerTool('statistics', {
    description: 'Count, arithmetic mean and population standard deviation (ddof=0) of finite measurements.',
    inputSchema: z.object({ values: numbers }), outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, ({ values }) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const standardDeviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    if (!Number.isFinite(mean) || !Number.isFinite(standardDeviation)) return { isError: true, content: [{ type: 'text', text: 'Numeric range exceeded' }] };
    return record('statistics', { values }, { count: values.length, mean, standardDeviation });
  });
  if (version === 2) server.registerTool('weighted_statistics', {
    description: 'Weighted mean and population standard deviation. Equal-length finite nonnegative weights must have positive total weight.',
    inputSchema: z.object({ values: numbers, weights: numbers }), outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, ({ values, weights }) => {
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (values.length !== weights.length || weights.some(value => value < 0) || total <= 0 || !Number.isFinite(total)) {
      state.calls.push({ name: 'weighted_statistics', args: { values, weights }, error: 'invalid_weights', version });
      return { isError: true, content: [{ type: 'text', text: 'invalid_weights: equal lengths, finite nonnegative weights and a positive finite total are required' }] };
    }
    const mean = values.reduce((sum, value, index) => sum + value * (weights[index] / total), 0);
    const standardDeviation = Math.sqrt(values.reduce((sum, value, index) => sum + (weights[index] / total) * (value - mean) ** 2, 0));
    if (!Number.isFinite(mean) || !Number.isFinite(standardDeviation)) return { isError: true, content: [{ type: 'text', text: 'Numeric range exceeded' }] };
    return record('weighted_statistics', { values, weights }, { count: values.length, mean, standardDeviation });
  });
  server.registerTool('echo', {
    description: 'Return a caller-provided identity, optionally waiting at a verifier-controlled barrier.',
    inputSchema: z.object({ identity: z.string().max(128), barrier: z.string().max(128).optional() }),
    outputSchema: z.object({ identity: z.string(), version: z.number() }),
  }, async ({ identity, barrier }, context) => {
    const signal = context.mcpReq.signal;
    if (barrier) await new Promise((resolve, reject) => {
      const key = `${barrier}:${identity}`;
      if (state.waiting.has(key)) { reject(new Error('Duplicate barrier identity')); return; }
      const abort = () => { state.waiting.delete(key); reject(new Error('Barrier call cancelled')); };
      state.waiting.set(key, () => { state.waiting.delete(key); signal.removeEventListener('abort', abort); resolve(); });
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    return record('echo', { identity, barrier }, { identity, version });
  });
  server.registerTool('deliberate_error', {
    description: 'Always returns an MCP tool error for failure-boundary qualification.', inputSchema: z.object({}),
  }, () => ({ isError: true, content: [{ type: 'text', text: 'controlled_fixture_failure' }] }));
  server.registerTool('isolation_probe', {
    description: 'Container-only verification: attempt bounded sentinel writes to protected and private runtime directories.', inputSchema: z.object({}),
  }, async () => {
    if (!existsSync('/.dockerenv')) return { isError: true, content: [{ type: 'text', text: 'Container required' }] };
    const writes = {};
    for (const directory of ['/app', '/source', '/run/polariton', '/state']) {
      const path = `${directory}/.polariton-fixture-write-probe`;
      try { await writeFile(path, 'bounded fixture sentinel', { flag: 'wx' }); writes[directory] = true; await unlink(path); }
      catch (error) { writes[directory] = error.code; }
    }
    return record('isolation_probe', {}, writes);
  });
  if (process.env.POLARITON_FIXTURE_DESTRUCTIVE === '1' && existsSync('/.dockerenv')) server.registerTool('fixture_fault', {
    description: 'Explicit test-only containment probe; starts a bounded-by-container helper workload. Never a production scientific capability.',
    inputSchema: z.object({ mode: z.enum(['cpu', 'memory', 'output', 'disk', 'helpers', 'crash']) }),
  }, ({ mode }) => {
    if (mode === 'crash') { setTimeout(() => process.exit(71), 25); return success({ mode, scheduled: true }); }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./exhaust.mjs', import.meta.url)), mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const receipt = { mode, pid: child.pid, state: 'running', code: null, signal: null, error: null, outputBytes: 0 };
    state.children.push(receipt);
    child.on('error', error => { receipt.state = 'failed'; receipt.error = error.message; });
    child.on('exit', (code, signal) => { receipt.state = 'exited'; receipt.code = code; receipt.signal = signal; });
    child.on('message', message => { if (Number.isSafeInteger(message?.bytes)) receipt.outputBytes = message.bytes; });
    return record('fixture_fault', { mode }, { mode, pid: child.pid });
  });
  if (process.env.POLARITON_FIXTURE_DESTRUCTIVE === '1' && existsSync('/.dockerenv')) server.registerTool('fixture_observation', {
    description: 'Explicit fixture-only control of subsequent read-only resource responses.',
    inputSchema: z.object({ mode: z.enum(['normal', 'error', 'malformed', 'malformed-envelope', 'oversized']), delayMs: z.number().int().min(0).max(60000).default(0), bytes: z.number().int().min(0).max(16777216).default(0) }),
  }, args => { state.resource = args; return record('fixture_observation', args, args); });
  server.registerResource('capability', 'stats://capability', { mimeType: 'application/json' }, async uri => {
    const { mode, delayMs, bytes } = state.resource;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (mode === 'error') throw new Error('controlled_resource_failure');
    if (mode === 'malformed-envelope') return { contents: [{ uri: uri.href, mimeType: 'application/json', text: 17 }] };
    const info = { version, operations: version === 1 ? ['statistics'] : ['statistics', 'weighted_statistics'] };
    const text = mode === 'malformed' ? '{invalid-json' : mode === 'oversized' ? 'x'.repeat(bytes) : JSON.stringify(info);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });
  server.registerResource('fixture-receipts', 'fixture://receipts', { mimeType: 'application/json', description: 'Verifier-only synthetic call receipts and active barriers; reading does not invoke tools.' }, uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ version, calls: state.calls, waiting: [...state.waiting.keys()], children: state.children }) }],
  }));
  if (existsSync('/.dockerenv')) server.registerResource('fixture-limits', 'fixture://limits', { mimeType: 'application/json' }, async uri => {
    const values = {};
    for (const name of ['memory.max', 'memory.events', 'pids.max', 'pids.current', 'pids.events', 'cpu.max', 'cpu.stat']) values[name] = (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(values) }] };
  });
  return server;
}
