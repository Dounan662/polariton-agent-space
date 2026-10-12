import {z} from 'zod';
const count=z.number().int().nonnegative().safe(),duration=z.number().nonnegative().finite();
/** Whole-session readings at a source cut. Token buckets contain reported usage;
 * context composition is an estimate, not a billing breakdown. */
export const SessionMetrics=z.object({
 tokenUsage:z.object({uncachedInputTokens:count,cacheReadTokens:count,cacheWriteTokens:count,outputTokens:count}).strict(),
 sessionStats:z.object({turns:count,steps:count,llmMs:duration,toolMs:duration,ttftMs:duration,ttftSteps:count,decodeMs:duration,decodeTokens:count}).strict(),
 contextPressure:z.object({pressureTokens:count.optional(),projectedTokens:count.optional(),contextWindow:count.positive().optional()}).strict(),
 contextBreakdown:z.object({systemTokens:count,toolsTokens:count,messageTokens:count}).strict(),
}).strict();
export type SessionMetrics=z.infer<typeof SessionMetrics>;
