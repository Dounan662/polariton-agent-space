import {z} from 'zod';
import {isAbsolute,join} from 'node:path';

const SocketPathBytes=z.number().int().positive().max(100).default(100);

/** Own the runtime socket name and capacity together. Both installation and
 * execution validate the complete address before publishing state or binding. */
export function runtimeSocketPath(directory:string,id:string,maxBytes=SocketPathBytes.parse(undefined)):string{
  if(!isAbsolute(directory))throw new Error('Runtime directory must be absolute');
  const path=join(directory,`${z.uuid().parse(id)}.sock`);
  if(Buffer.byteLength(path)>=SocketPathBytes.parse(maxBytes))throw new Error('Runtime directory is too long for guardian Unix sockets; select a shorter XDG_RUNTIME_DIR');
  return path;
}

/** Public limits and observation contracts contain no upstream execution implementation. */
export const GuardianIdentity = z.object({id:z.string().uuid(),token:z.string().regex(/^[a-f0-9]{64}$/),directory:z.string().min(1),socket:z.string().min(1)}).strict();
/** Native handles may need several TERM/KILL observation rounds before the
 * guardian can retire the foreground group. The request encloses both phases. */
export const GuardianSettings = z.object({
  socketPathBytes:SocketPathBytes,
  nativeDrainTimeoutMs:z.number().int().positive().default(30000),
  termTimeoutMs:z.number().int().positive().default(3000),
  killTimeoutMs:z.number().int().positive().default(3000),
  pollMs:z.number().int().positive().default(50),
  requestTimeoutMs:z.number().int().positive().default(40000),
  maxConnections:z.number().int().positive().default(8),
}).strict().refine(value=>value.nativeDrainTimeoutMs+value.termTimeoutMs+value.killTimeoutMs<value.requestTimeoutMs,
  'Native drain and group shutdown must fit within the guardian request deadline').prefault({});

export const GuardianLaunch = z.object({identity:GuardianIdentity,execution:z.enum(['native','group']),command:z.string().min(1),args:z.array(z.string()),cwd:z.string().min(1),env:z.record(z.string(),z.string().optional()),limits:GuardianSettings.unwrap().safeExtend({maxFrameBytes:z.number().int().positive()})}).strict();


export const JobObservationSettings = z.object({
  waitTimeoutMs:z.number().int().positive().default(30000),
  maxWaitTimeoutMs:z.number().int().positive().default(600000),
}).strict().refine(value=>value.waitTimeoutMs<=value.maxWaitTimeoutMs,'Job observation default must fit within its maximum wait');


export const ResidencySnapshot=z.object({
  revision:z.number().int().nonnegative(),
  eligible:z.boolean(),
  blockers:z.array(z.object({kind:z.enum(['running','inbox','job','descendant','goal','schedule','dynamic-plugin','admission','maintenance','unknown']),detail:z.string().optional()}).strict()),
  reservation:z.string().optional(),
}).strict();
export const ResidencyReserveInput=z.object({sessionId:z.string().min(1),revision:z.number().int().nonnegative()}).strict();
export const ResidencyTokenInput=z.object({sessionId:z.string().min(1),token:z.uuid()}).strict();
