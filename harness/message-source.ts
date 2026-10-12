import {z} from 'zod';
import type {} from '@deepseek-ai/dsh-llm';

/** Correlation belongs only to Polariton-admitted input; native producers retain their own sources. */
export const InputSource=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('user'),rpcId:z.string()}),
  z.object({kind:z.literal('polariton-worker'),rpcId:z.string(),workerId:z.string().uuid()}),
]);

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'polariton-worker':{kind:'polariton-worker';rpcId:string;workerId:string};
  }
}
