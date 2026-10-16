import type {Context} from '@deepseek-ai/cordis';
import type {Config as UpstreamConfig} from '@deepseek-ai/dsh-mcp-client';
import type Schema from '@deepseek-ai/schemastery';
export {createMcpToolDefinition} from '@deepseek-ai/dsh-mcp-client';
export type CredentialProvider={token(signal?:AbortSignal):Promise<string|undefined>};
export type Config=UpstreamConfig&{protocol:'auto'|'legacy';cleanupTimeoutMs:number;credentialProvider?:CredentialProvider};
type Input=Parameters<typeof import('@deepseek-ai/dsh-mcp-client').Config>[0]&{protocol?:'auto'|'legacy';cleanupTimeoutMs:number;credentialProvider?:CredentialProvider};
export declare const Config:Schema<Input,Config>;
export declare const name:string;
export declare const inject:string[];
export declare function apply(ctx:Context,config:Config):Promise<void>;
/** Positive settlement across every connection owned by this Harness root. */
export declare function drainMcp(ctx:Context):Promise<void>;
