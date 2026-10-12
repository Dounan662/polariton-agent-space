import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheHit } from '../web/src/native/usage.ts';
import { deriveTurnTokenUsage, type TurnTokenUsage } from '../web/src/native/llm/token-meter/src/turn-usage.ts';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';

const usage = (override: Partial<TurnTokenUsage> = {}): TurnTokenUsage => ({ uncachedInputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 50, reasoningTokens: 30, totalTokens: 150, ...override });

test('cache HIT divides cached prompt by all prompt input, excluding output and its reasoning subset', () => {
  assert.equal(cacheHit(usage()), '60');
  assert.equal(cacheHit(usage({ outputTokens: 150, reasoningTokens: 130, totalTokens: 250 })), '60');
});

test('unreported cache buckets are not fabricated in the per-turn disclosure',()=>{
 assert.equal(cacheHit(usage({cacheReadTokens:undefined})), 'unknown');
});

test('a partial cache hit near one hundred percent remains visibly partial', () => {
  const result = cacheHit(usage({ uncachedInputTokens: 1, cacheReadTokens: 999999, cacheWriteTokens: 0, outputTokens: 100, totalTokens: 1000100 }));
  assert.notEqual(result, '100');
  assert.match(result, /^99\./);
});

test('native completed-turn disclosure rejects missing lifecycle and contradictory provider totals', () => {
  const events = (totalTokens = 150): SessionEvent[] => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], usage: { inputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 20, outputTokens: 50, reasoningTokens: 30, totalTokens }, message: { id: 'usage-fixture', role: 'assistant', source: { kind: 'model', provider: 'synthetic', model: 'fixture' }, content: [{ type: 'text', text: 'Done' }] } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq })) as SessionEvent[];
  assert.equal(deriveTurnTokenUsage(events())?.totalTokens, 150);
  assert.equal(deriveTurnTokenUsage(events().slice(0, -1)), undefined);
  assert.equal(deriveTurnTokenUsage(events().slice(1)), undefined);
  assert.equal(deriveTurnTokenUsage(events(180)), undefined, 'reasoning must not be added to the exact total a second time');
});
