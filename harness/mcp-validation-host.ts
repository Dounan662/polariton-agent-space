import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import * as McpClient from './native/mcp-client.mjs';
import {validationPlan,deadline} from './mcp.mjs';
import {McpValidationInput,McpValidationLimits,type McpValidationResult} from './mcp-contracts.ts';

/** Observe prepared connections using the worker's exact MCP engine. This host has
 * no Agent, model provider, session writer, shell tools, or inferred tool effects.
 * Functional calls require explicit checks; outputs are represented by digests so
 * application content and credentials cannot enter shareable operation receipts.
 * Cleanup uncertainty is retained independently of connection and call outcomes. */
export async function validateMcp(input:McpValidationInput,budget:McpValidationLimits,signal?:AbortSignal):Promise<McpValidationResult> {
  const {plan,limits,configs}=validationPlan(input,budget);
  const ctx=new Context(),fibers:Array<ReturnType<Context['plugin']>>=[];
  const result:McpValidationResult={servers:[],checks:[],cleanup:{status:'settled',code:null}};
  try {
    await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);
    result.servers=await Promise.all(configs.map(async config=>{
      try {
        signal?.throwIfAborted();const fiber=ctx.plugin(McpClient,config);fibers.push(fiber);
        await deadline(fiber,limits.startupMs,signal);
        const tools=ctx.tools.schemas().map(tool=>tool.name).filter(name=>name.startsWith(`mcp__${config.serverName}__`));
        if(tools.length>limits.maxTools)return {serverName:config.serverName,connection:'connected' as const,discovery:'failed' as const,tools:[],code:'MCP_TOOL_LIMIT' as const};
        return {serverName:config.serverName,connection:'connected' as const,discovery:'passed' as const,tools,code:null};
      } catch(error) {
        const code=signal?.aborted?'MCP_CANCELLED':error instanceof Error&&'code'in error&&error.code==='MCP_STARTUP_TIMEOUT'?'MCP_STARTUP_TIMEOUT':'MCP_STARTUP_FAILED';
        return {serverName:config.serverName,connection:'unavailable' as const,discovery:'failed' as const,tools:[],code};
      }
    }));
    for(const check of plan.checks){
      const component=result.servers.find(server=>server.serverName===check.serverName)!;
      const publicName=check.toolName.startsWith(`mcp__${check.serverName}__`)?check.toolName:`mcp__${check.serverName}__${check.toolName}`;
      const base={name:check.name,serverName:check.serverName,toolName:check.toolName,outputDigest:null};
      if(signal?.aborted){result.checks.push({...base,status:'not_run',code:'MCP_CANCELLED'});continue;}
      if(component.discovery!=='passed'||!component.tools.includes(publicName)){result.checks.push({...base,status:'not_run',code:'MCP_NOT_CONNECTED'});continue;}
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limits.callMs);
      try {
        const response=await ctx.tools.execute({callId:ToolCallId(check.name),name:publicName,arguments:check.arguments,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
        const output=JSON.stringify(response.value??response.content),outputBytes=Buffer.byteLength(output);
        const code=signal?.aborted?'MCP_CANCELLED':controller.signal.aborted?'MCP_CALL_TIMEOUT':response.isError?'MCP_CALL_FAILED':outputBytes>limits.maxOutputBytes?'MCP_OUTPUT_LIMIT':null;
        result.checks.push({...base,status:code?'failed':'passed',code,outputDigest:code?null:createHash('sha256').update(output).digest('hex')});
      } catch {
        result.checks.push({...base,status:'failed',code:signal?.aborted?'MCP_CANCELLED':controller.signal.aborted?'MCP_CALL_TIMEOUT':'MCP_CALL_FAILED'});
      } finally {clearTimeout(timer);}
    }
  } finally {
    try {
      // Connection handles are settled before Cordis can discard their scopes.
      // A timeout is only an observation: failure never certifies process death.
      await deadline(McpClient.drainMcp(ctx),limits.cleanupMs);
      await deadline(Promise.all(fibers.map(fiber=>fiber.dispose())),limits.cleanupMs);
      await deadline(ctx.fiber.dispose(),limits.cleanupMs);
    } catch {result.cleanup={status:'unconfirmed',code:'MCP_CLEANUP_FAILED'};}
  }
  return result;
}
