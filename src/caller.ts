import {z} from 'zod';
export const Actor = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('owner'),id:z.literal('local-owner')}).strict(),
  z.object({kind:z.literal('worker'),id:z.string().uuid(),processId:z.string().uuid()}).strict(),
]);
export type Actor = z.infer<typeof Actor>;
export const owner:Actor={kind:'owner',id:'local-owner'};
