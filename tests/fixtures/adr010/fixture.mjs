import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const Configuration = z.object({
  role: z.enum(['measurement', 'transform']),
  seed: z.string().min(1),
  slowMs: z.number().int().positive(),
}).strict();
const Input = z.object({sample:z.string().min(1).max(96), mode:z.enum(['normal','error','slow']).default('normal')});

/** A scientific fixture whose receipts come from the capability, never from model prose.
 * The verifier supplies the seed outside worker prompts/workspaces, and independently
 * checks inputs, results, and the append-only invocation stream collected by the host.
 */
export function createFixture(raw, version, {record, receipt = randomUUID} = {}) {
  const config = Configuration.parse(raw);
  if (![1,2].includes(version)) throw new Error('Unsupported fixture release');
  if (typeof record !== 'function') throw new Error('An independent invocation recorder is required');
  const server = new McpServer({name:`adr010-${config.role}`,version:String(version)});
  const invoke = async (name, input, extra) => {
    const id = receipt();
    const base = {fixture:'adr010',role:config.role,version,invocationId:id,tool:name,input};
    record({...base,phase:'started'});
    try {
      if (input.mode === 'slow') await delay(config.slowMs,undefined,{signal:extra.signal});
      if (input.mode === 'error') {
        const result = {isError:true,content:[{type:'text',text:`Controlled ${config.role} failure for ${input.sample}; receipt ${id}`}]};
        record({...base,phase:'completed',result});return result;
      }
      const value = config.role === 'measurement'
        ? createHash('sha256').update(`${config.seed}:${input.sample}`).digest().readUInt32BE(0)%10000
        : input.value * (version === 1 ? 3 : 7) + (version === 1 ? 11 : 19);
      const output = {sample:input.sample,value,receipt:id,role:config.role,version,
        ...(config.role==='transform'?{measurementReceipt:input.measurementReceipt}:{})};
      const result = {content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};
      record({...base,phase:'completed',result});return result;
    } catch (error) {
      record({...base,phase:'cancelled',error:error instanceof Error?error.name:'Unknown error'});
      throw error;
    }
  };
  if (config.role === 'measurement') server.registerTool('measure',{
    description:'Retrieve an externally held synthetic measurement. Return the value and receipt to the transform tool. Use mode error for a controlled failure or slow for cancellation testing.',
    inputSchema:Input,
  },(input,extra)=>invoke('measure',input,extra));
  else server.registerTool('transform',{
    description:'Transform the exact measurement value returned by measure. Pass its receipt unchanged. Versioned arithmetic is implemented by this server.',
    inputSchema:Input.extend({value:z.number().int().min(0).max(9999),measurementReceipt:z.string().min(1)}),
  },(input,extra)=>invoke('transform',input,extra));
  server.registerResource('capability','fixture://capability',{mimeType:'application/json'},async()=>({
    contents:[{uri:'fixture://capability',mimeType:'application/json',text:JSON.stringify({role:config.role,version,tools:[config.role==='measurement'?'measure':'transform']})}],
  }));
  return server;
}
