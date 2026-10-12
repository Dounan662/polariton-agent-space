import type {TurnTokenUsage} from './llm/token-meter/src/turn-usage.ts';
import {formatCacheHitPercent} from './client/ui-chat/src/client/chat/token-format.ts';

export function cacheHit(usage:TurnTokenUsage):string {
 return usage.cacheReadTokens===undefined?'unknown':formatCacheHitPercent(usage.cacheReadTokens,usage.totalTokens-usage.outputTokens,1)??'unknown';
}
