// @ts-check
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from 'zod';
import * as McpClient from './native/mcp-client.mjs';
import {McpServerPlan,McpValidationInput,McpValidationLimits} from './mcp-contracts.ts';
import {credentialProvider} from './mcp-credentials.ts';

const Entry = z.object({name:z.string(),value:z.string()}).strict();
const Plan = z.object({cwd:z.string().refine(isAbsolute),servers:z.array(McpServerPlan)}).strict();
const Context = z.object({sessionId:z.string(),servers:z.array(z.object({serverName:z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),status:z.literal('unavailable'),code:z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/)}).strict())}).strict();
const Limits = z.object({startupMs:z.number().int().positive(),cleanupMs:z.number().int().positive(),callMs:z.number().int().positive(),credentialMs:z.number().int().positive(),maxCredentialBytes:z.number().int().positive()}).strict();

/** ACP's stable namespace normalization, applied to every declaration before any connection starts. */
/** @param {string} name */
function serverName(name) {
  if(!name.trim()||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Invalid MCP server name');
  if(/^[A-Za-z0-9_-]{1,32}$/.test(name))return name;
  return `${name.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,20)||'server'}_${createHash('sha256').update(name).digest('hex').slice(0,8)}`.slice(0,32);
}
/** @param {Array<z.infer<typeof Entry>>} values @param {boolean} header */
function entries(values,header) {
  /** @type {Record<string,string>} */
  const result=Object.create(null),seen=new Set();
  for(const {name,value} of values){
    if(header){validateHeaderName(name);validateHeaderValue(name,value);}
    else if(!name||name.includes('=')||name.includes('\0')||value.includes('\0'))throw new Error('Invalid MCP environment');
    const key=header?name.toLowerCase():name;if(seen.has(key))throw new Error('Duplicate MCP entry');seen.add(key);result[name]=value;
  }
  return result;
}
/** @template T @param {PromiseLike<T>} promise @param {number} ms @param {AbortSignal} [signal] @returns {Promise<T>} */
export function deadline(promise,ms,signal) {
  return new Promise((resolve,reject)=>{
    const aborted=()=>finish(Object.assign(new Error('MCP setup cancelled'),{code:'MCP_CANCELLED'}));
    const timer=setTimeout(()=>finish(Object.assign(new Error('MCP setup timed out'),{code:'MCP_STARTUP_TIMEOUT'})),ms);
    /** @param {unknown} error @param {T} [value] */
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);if(error)reject(error);else resolve(/** @type {T} */(value));};
    signal?.addEventListener('abort',aborted,{once:true});
    if(signal?.aborted)aborted();
    Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
  });
}

/** Resolve declarations once for both workers and inference-free validation. */
/** @param {unknown} input @param {z.infer<typeof Limits>} limits */
export function connectionPlans(input,limits) {
  const {cwd,servers}=Plan.parse(input),names=new Set();
  return servers.map(server=>{
    const name=serverName(server.name);if(names.has(name))throw new Error('Duplicate MCP namespace');names.add(name);
    const common={serverName:name,protocol:server.protocol??'auto',failOnStartupError:true,reconnect:{enabled:false},cleanupTimeoutMs:limits.cleanupMs,toolCallTimeoutMs:limits.callMs};
    /** @type {NonNullable<Parameters<typeof McpClient.Config>[0]>} */
    const config='type'in server?{...common,transport:'streamable-http',url:server.url,headers:entries(server.headers,true)}:{...common,transport:'stdio',command:server.command,args:server.args,env:entries(server.env,false),cwd};
    if('type'in server&&server.credential){
      if(server.credential.serverName!==name||server.headers.some(entry=>entry.name.toLowerCase()==='authorization'))throw new Error('Credential binding conflicts with server authority');
      config.credentialProvider=credentialProvider(server.credential,{timeoutMs:limits.credentialMs,maxBytes:limits.maxCredentialBytes});
    }
    return {...McpClient.Config(config),...(config.transport==='streamable-http'?{headers:config.headers??{}}:{env:config.env??{}})};
  });
}

/** Reject invalid validation authority before the supervisor launches any owner. */
/** @param {unknown} input @param {unknown} budget */
export function validationPlan(input,budget) {
  const plan=McpValidationInput.parse(input),limits=McpValidationLimits.parse(budget);
  if(plan.checks.length>limits.maxChecks||new Set(plan.checks.map(check=>check.name)).size!==plan.checks.length)throw new Error('Functional checks exceed the budget or have duplicate names');
  const configs=connectionPlans({cwd:plan.cwd,servers:plan.servers},{...limits,credentialMs:limits.callMs,maxCredentialBytes:limits.maxOutputBytes});
  for(const check of plan.checks)if(!configs.some(config=>config.serverName===check.serverName))throw new Error('Functional check references an unknown server');
  return {plan,limits,configs};
}

/**
 * Compose optional MCP capabilities inside DSH using its public, scoped client plugin.
 * ACP remains the session owner; this adapter supplies independent connection outcomes
 * because the pinned ACP plugin treats one optional server failure as a session failure.
 * No transport, MCP client, tool proxy, or history writer is implemented here.
 */
export class McpAdmission {
  /** @type {ReturnType<typeof McpClient.Config>[]|undefined} */ pending;
  /** @type {Map<string,{servers:Array<{serverName:string,status:'connected'|'unavailable',code:'MCP_STARTUP_FAILED'|'MCP_STARTUP_TIMEOUT'|null}>,unavailable:z.infer<typeof Context>['servers']}>} */
  sessions=new Map();
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {z.input<typeof Limits>} limits */
  constructor(ctx,limits) {
    this.ctx=ctx;this.limits=Limits.parse(limits);
    ctx.on('agent/created',async({agent,source,signal})=>{
      if(!['startup','resume'].includes(source)||!ctx.agents.roots().includes(agent))return;
      const configs=this.pending;this.pending=undefined;if(!configs)return;
      /** @type {NonNullable<ReturnType<McpAdmission['sessions']['get']>>} */
      const record={servers:[],unavailable:[]};this.sessions.set(agent.id,record);
      agent.ctx.systemPrompt.section({name:'polariton:mcp-availability',order:agent.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),interpolate:false,text:()=>{
        const failures=new Map([...record.servers.filter(server=>server.status==='unavailable'),...record.unavailable].map(server=>[server.serverName,server.code]));
        return failures.size?`Polariton optional MCP availability at worker setup: ${[...failures].map(([name,code])=>`${name}: unavailable (${code})`).join('; ')}. Continue with the tools that are available. Do not claim to have used unavailable tools. Ask for capability repair only when the user's task requires them.`:'';
      }});
      // Every startup owns its own deadline; one slow optional server cannot delay the others.
      record.servers=await Promise.all(configs.map(async config=>{
        /** @type {ReturnType<import('@deepseek-ai/cordis').Context['plugin']>|undefined} */
        let fiber;
        try {
          signal?.throwIfAborted();fiber=agent.ctx.plugin(McpClient,config);
          await deadline(fiber,this.limits.startupMs,signal);
          return {serverName:config.serverName,status:'connected',code:null};
        } catch(error) {
          // Disposal starts synchronously and fences late registration. Failure to drain is a
          // lifecycle failure, not a usable degraded activation; the guardian must settle it.
          if(fiber)await deadline(fiber.dispose(),this.limits.cleanupMs);
          if(signal?.aborted||(error instanceof Error&&'code'in error&&error.code==='MCP_CANCELLED'))throw new Error('MCP setup cancelled');
          return {serverName:config.serverName,status:'unavailable',code:error instanceof Error&&'code'in error&&error.code==='MCP_STARTUP_TIMEOUT'?'MCP_STARTUP_TIMEOUT':'MCP_STARTUP_FAILED'};
        }
      }));
    },{global:true});
    ctx.on('agent/disposed',({agent})=>this.sessions.delete(agent.id),{global:true});
  }
  /** Validate the whole declaration set before effects; a Harness serializes session activation. */
  /** @param {unknown} input */
  prepare(input) {
    if(this.pending)throw new Error('MCP activation is already pending');
    try {
      const configs=connectionPlans(input,this.limits);
      this.pending=configs;return {prepared:true};
    }catch{throw new Error('Invalid MCP declarations; check names, transports and connection fields');}
  }
  clear(){this.pending=undefined;return {cleared:true};}
  /** @param {string} sessionId */
  status(sessionId){const value=this.sessions.get(sessionId);if(!value)throw new Error('MCP activation status is unavailable');return value.servers;}
  /** @param {unknown} input */
  context(input){let parsed;try{parsed=Context.parse(input);}catch{throw new Error('Invalid MCP availability context');}const record=this.sessions.get(parsed.sessionId);if(!record)throw new Error('Session is not active');record.unavailable=parsed.servers;return {updated:true};}
}
