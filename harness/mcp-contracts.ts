import {z} from 'zod';
const isAbsolute=(value:string)=>value.startsWith('/')&&!value.includes('\0');

/** A private grant to resolve one immutable access binding. It contains no upstream
 * credentials and never belongs in public receipts, definitions, or model input. */
export const McpCredentialHandle=z.object({
  socketPath:z.string().refine(isAbsolute),accessId:z.string().min(1),
  serverName:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),token:z.string().min(1),
}).strict();
export type McpCredentialHandle=z.infer<typeof McpCredentialHandle>;

const Entry=z.object({name:z.string(),value:z.string()}).strict();
/** Prepared, private connection authority. Only Harness executes these plans.
 * Ordinary launches use auto negotiation. A prepared single-session stdin stream
 * selects legacy explicitly: an SDK disposable sibling would attach that same
 * retained service and its teardown could close the intended session. */
export const McpServerPlan=z.union([
  z.object({name:z.string(),command:z.string().refine(isAbsolute),args:z.array(z.string()),env:z.array(Entry),protocol:z.enum(['auto','legacy']).optional()}).strict(),
  z.object({name:z.string(),type:z.literal('http'),url:z.url().refine(value=>['http:','https:'].includes(new URL(value).protocol)),headers:z.array(Entry),credential:McpCredentialHandle.optional(),protocol:z.enum(['auto','legacy']).optional()}).strict(),
]);
export type McpServerPlan=z.infer<typeof McpServerPlan>;

/** Explicitly requested functional execution. Discovery never implies this effect. */
export const McpFunctionalCheck=z.object({
  name:z.string().min(1),serverName:z.string().min(1),toolName:z.string().min(1),arguments:z.record(z.string(),z.json()),
}).strict();
export const McpValidationInput=z.object({cwd:z.string().refine(isAbsolute),servers:z.array(McpServerPlan),checks:z.array(McpFunctionalCheck).default([])}).strict();
export type McpValidationInput=z.input<typeof McpValidationInput>;
export const McpValidationLimits=z.object({startupMs:z.number().int().positive(),callMs:z.number().int().positive(),cleanupMs:z.number().int().positive(),maxTools:z.number().int().positive(),maxChecks:z.number().int().positive(),maxOutputBytes:z.number().int().positive()}).strict();
export type McpValidationLimits=z.infer<typeof McpValidationLimits>;
export const McpValidationResult=z.object({
  servers:z.array(z.object({serverName:z.string(),connection:z.enum(['connected','unavailable']),discovery:z.enum(['passed','failed']),tools:z.array(z.string()),code:z.enum(['MCP_STARTUP_FAILED','MCP_STARTUP_TIMEOUT','MCP_CANCELLED','MCP_TOOL_LIMIT']).nullable()}).strict()),
  checks:z.array(z.object({name:z.string(),serverName:z.string(),toolName:z.string(),status:z.enum(['passed','failed','not_run']),code:z.enum(['MCP_CALL_FAILED','MCP_CALL_TIMEOUT','MCP_CANCELLED','MCP_NOT_CONNECTED','MCP_OUTPUT_LIMIT']).nullable(),outputDigest:z.string().nullable()}).strict()),
  cleanup:z.object({status:z.enum(['settled','unconfirmed']),code:z.literal('MCP_CLEANUP_FAILED').nullable()}).strict(),
}).strict();
export type McpValidationResult=z.infer<typeof McpValidationResult>;
