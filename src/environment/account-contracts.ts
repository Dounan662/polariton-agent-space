import {z} from 'zod';

const Key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
export const AccountUrl=z.url().refine(value=>{const url=new URL(value);return !url.username&&!url.password&&!url.hash&&!url.search&&(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)));},'Use HTTPS, or loopback HTTP, without credentials or query parameters');
const Scopes=z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).refine(values=>new Set(values).size===values.length,'Scopes must be unique');
export const AccountCreate=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('oauth'),id:Key,name:z.string().min(1),resource:AccountUrl,issuer:AccountUrl,scopes:Scopes,registration:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('dynamic')}).strict(),
    z.object({kind:z.literal('preregistered'),clientId:z.string().min(1),clientSecret:z.string().min(1).optional()}).strict(),
  ])}).strict(),
  z.object({kind:z.literal('static'),id:Key,name:z.string().min(1),account:z.string().min(1),authority:z.string().min(1),value:z.string().min(1),expiresAt:z.iso.datetime().optional()}).strict(),
]);
export type AccountCreate=z.infer<typeof AccountCreate>;
export const AccountReplace=z.object({value:z.string().min(1),expiresAt:z.iso.datetime().optional()}).strict();
export type AccountReplace=z.infer<typeof AccountReplace>;
export const AccountBinding=z.object({connectionId:Key,epoch:z.string().min(1),resource:AccountUrl,scopes:Scopes}).strict();
export type AccountBinding=z.infer<typeof AccountBinding>;
export const AccountPublic=z.object({id:Key,name:z.string(),kind:z.enum(['static','oauth']),status:z.enum(['disconnected','connecting','connected','expired','error']),epoch:z.string(),resource:z.string(),scopes:Scopes,account:z.string().nullable(),errorCode:z.string().nullable()}).strict();
export type AccountPublic=z.infer<typeof AccountPublic>;
export const AccountInventory=z.object({accounts:z.array(AccountPublic),affected:z.record(z.string(),z.number().int().nonnegative()),redirectUri:z.url().nullable()}).strict();
export type AccountInventory=z.infer<typeof AccountInventory>;
export const AccountAuthorization=z.object({authorizationUrl:z.url()}).strict();
export type AccountAuthorization=z.infer<typeof AccountAuthorization>;
export const AccountDisconnect=z.object({account:AccountPublic,remoteRevocation:z.enum(['succeeded','unsupported','failed','not_applicable']),cleanup:z.discriminatedUnion('status',[
  z.object({status:z.literal('settled'),activeAccesses:z.literal(0)}).strict(),
  z.object({status:z.literal('worker_restart_required'),activeAccesses:z.number().int().positive()}).strict(),
])}).strict();
export type AccountDisconnect=z.infer<typeof AccountDisconnect>;
