import {z} from 'zod';

const Identifier=z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/);
export const ProviderProtocol=z.enum(['openai-completions','openai-responses','anthropic-messages']);
export const ProviderModel=z.object({id:z.string().trim().min(1).max(256),name:z.string().trim().min(1).max(256).optional(),image:z.boolean().optional(),contextWindow:z.number().int().positive().optional(),maxTokens:z.number().int().positive().optional()}).strict();
export type ProviderModel=z.infer<typeof ProviderModel>;
export const ProviderDefinition=z.object({id:Identifier,kind:z.enum(['builtin','custom']),name:z.string().trim().min(1).max(128),baseURL:z.string().url().optional(),protocol:ProviderProtocol.optional(),models:z.array(ProviderModel).min(1),keyless:z.boolean()}).strict();
export type ProviderDefinition=z.infer<typeof ProviderDefinition>;
export const SaveProvider=z.object({id:Identifier,kind:z.enum(['builtin','custom']),name:z.string().trim().min(1).max(128).optional(),baseURL:z.string().url().optional(),protocol:ProviderProtocol.optional(),models:z.array(ProviderModel).min(1).optional(),keyless:z.boolean().optional(),apiKey:z.string().trim().min(1).max(8192).optional(),removeKey:z.boolean().optional(),revision:z.number().int().nonnegative().optional()}).strict();
export type SaveProvider=z.infer<typeof SaveProvider>;
export const DiscoverProvider=z.object({id:Identifier.optional(),baseURL:z.string().url().optional(),protocol:ProviderProtocol.optional(),apiKey:z.string().trim().min(1).max(8192).optional()}).strict();
export type DiscoverProvider=z.infer<typeof DiscoverProvider>;
export const RemoveProvider=z.object({id:Identifier,revision:z.number().int().nonnegative().optional()}).strict();
export const DefaultProviderRoute=z.object({route:z.string().nullable(),revision:z.number().int().nonnegative().optional()}).strict();
export interface ProviderDescriptor extends ProviderDefinition {credential:{configured:boolean;source?:string;writable:boolean};configured:boolean}
export interface ProviderCatalogEntry {id:string;name:string;keyUrl:string;models:ProviderModel[];credential?:ProviderDescriptor['credential']}
export interface ProviderSnapshot {revision:number;defaultRoute:string|null;catalog:ProviderCatalogEntry[];providers:ProviderDescriptor[];choices:{value:string;name:string;image:boolean}[]}
