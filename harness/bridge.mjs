// @ts-check
import {z} from 'zod';
import * as SessionStats from '@deepseek-ai/dsh-session-stats';
import {sessionMetrics} from './metrics.ts';
import {SessionId,SessionSeq} from '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-shell-env';
import Schedule from '@deepseek-ai/dsh-schedule';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { SessionAssistantStreamAccumulator } from './native/assistant-stream.ts';
import { McpAdmission } from './mcp.mjs';
import { NativeMessages } from './messages.mjs';
import {InputSource} from './message-source.ts';
import { Residency} from './residency.mjs';
import {ResidencyReserveInput,ResidencyTokenInput } from './settings.ts';

const Frame=z.object({id:z.string().optional(),method:z.string().optional(),params:z.record(z.string(),z.unknown()).optional(),result:z.unknown().optional(),error:z.object({message:z.string()}).optional()});

export const inject = ['agents', 'sessionPersistence', 'llm', 'systemPrompt', 'shellEnv', 'jobs', 'subprocess', 'sessionProjections', 'tokenMeter'];

/** Private inherited-pipe control of already-live agents; never creates an agent. */
/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx) {
  await ctx.plugin(SessionStats);
  // DSH scrubs ambient secrets before tools run. An explicit registry grant is
  // the supported boundary for the worker's application credential; never rely
  // on ambient TOKEN inheritance or infer identity from a session hint.
  if(process.env.HARNESSCTL_TOKEN)ctx.shellEnv.register({
    name:'harnessctl',
    variables:{DSH_HARNESSCTL_TOKEN:{description:'Private harnessctl caller credential; consumed by the CLI, never print it.'}},
    resolve:()=>({DSH_HARNESSCTL_TOKEN:process.env.HARNESSCTL_TOKEN}),
  });
  const messages=new NativeMessages(ctx);
  const mcp=new McpAdmission(ctx,{startupMs:Number(process.env.POLARITON_MCP_STARTUP_MS),cleanupMs:Number(process.env.POLARITON_MCP_CLEANUP_MS),callMs:Number(process.env.POLARITON_REQUEST_TIMEOUT_MS),credentialMs:Number(process.env.POLARITON_REQUEST_TIMEOUT_MS),maxCredentialBytes:Number(process.env.POLARITON_MAX_FRAME_BYTES)});
  /** A reminder producer belongs to a fully activated session, never discovery. */
  /** @type {ReturnType<import('@deepseek-ai/cordis').Context['plugin']>|undefined} */
  let schedule;
  const socket = new Socket({ fd: 3 });
  const lines = createInterface({ input: socket });
  /** @type {Map<string,{resolve:(value:unknown)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  let sequence = 0;
  /** @type {Map<string,SessionAssistantStreamAccumulator>} */
  const streams=new Map();
  /** @param {unknown} value */
  const send = value => socket.write(JSON.stringify(value) + '\n');
  const residency=new Residency(ctx,{deadlineMs:Number(process.env.POLARITON_REQUEST_TIMEOUT_MS),requireSchedule:true,changed:(sessionId,snapshot)=>send({method:'residency',params:{sessionId,...snapshot}})});
  /** @param {string} method @param {unknown} params @returns {Promise<unknown>} */
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = `bridge-${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Polariton controller did not answer request admission'));
    }, Number(process.env.POLARITON_REQUEST_TIMEOUT_MS));
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  ctx.on('llm/stream', async function* (options, next) {
    const grant = z.object({allowed:z.boolean()}).parse(await ask('budget', { sessionId: ctx.agents.currentInitiator()?.id ?? null }));
    if (!grant.allowed) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'POLARITON_REQUEST_BUDGET_EXHAUSTED', message: 'Model request admission limit reached',
      } } };
      return;
    }
    yield* next();
  });
  ctx.on('agent/status', ({ agent, status }) => send({ method: 'status', params: { sessionId: agent.id, status } }));
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => send({ method: 'claimed', params: {
    sessionId: agent.id, messageId: message.id, source: message.source, turn,
  } }));
  ctx.on('agent/inbox/discarded',({agent,message})=>{const source=InputSource.safeParse(message.source);if(source.success)send({method:'discarded',params:{sessionId:agent.id,requestId:source.data.rpcId}});});
  ctx.on('agent/assistant-stream',({agent,frame})=>{
    let stream=streams.get(agent.id);if(!stream){stream=new SessionAssistantStreamAccumulator();streams.set(agent.id,stream);}
    const cursor=agent.session.seq===0?-1:SessionSeq(agent.session.seq-1);stream.accept(frame,cursor);
    send({method:'assistantStream',params:{sessionId:agent.id,frame:frame.type==='start'?{...frame,startedAfterSeq:cursor}:frame}});
  },{global:true});
  ctx.on('agent/disposed',({agent})=>streams.delete(agent.id),{global:true});
  ctx.on('session/event', (session, event) => {
    send({ method: 'source', params: { sessionId: session.id, seq: event.seq, type: event.type, event, metrics:sessionMetrics(ctx,session) } });
  });
  lines.on('line', async line => {
    /** @type {z.infer<typeof Frame>|undefined} */
    let frame;
    try {
      frame = Frame.parse(JSON.parse(line));
      if (frame.id && !frame.method) {
        const request = pending.get(frame.id);
        if (!request) return;
        pending.delete(frame.id); clearTimeout(request.timer);
        if (frame.error) request.reject(new Error(frame.error.message));
        else request.resolve(frame.result);
        return;
      }
      if (typeof frame.id !== 'string') throw new Error('Invalid bridge request');
      // DSH owns route discovery. Reading this catalog never creates an Agent or a session.
      if(frame.method==='models'){
        const provider=frame.params?.provider;
        if(typeof provider!=='string'||!ctx.llm.listProviders().some(value=>value.id===provider))throw new Error('Unknown model provider');
        const models=await ctx.llm.listModels(provider);
        send({id:frame.id,result:models.map(model=>({value:JSON.stringify([provider,model.id]),name:model.name,image:model.inputModalities?.includes('image')===true}))});
        return;
      }
      if(frame.method==='mcpPrepare'){send({id:frame.id,result:mcp.prepare(frame.params)});return;}
      if(frame.method==='mcpClear'){send({id:frame.id,result:mcp.clear()});return;}
      if (typeof frame.params?.sessionId !== 'string') throw new Error('Invalid bridge request');
      const agent = ctx.agents.get(SessionId(frame.params.sessionId));
      if (!agent) throw Object.assign(new Error('Session is not active'),{code:'SESSION_INACTIVE'});
      let result;
      if(frame.method==='activationReady'){
        // The controller has completed MCP grants, model selection and availability
        // context before this exchange. Native Schedule may now restore due work.
        schedule??=ctx.plugin(Schedule,{});
        await schedule;residency.refreshSchedules();result={ready:true};
      }
      else if(frame.method==='deactivate'){
        if(schedule){await schedule.dispose();schedule=undefined;}
        residency.touch();result={deactivated:true};
      }
      else if(frame.method==='residency'){result=residency.inspect(agent.id);}
      else if(frame.method==='residencyReserve'){const input=ResidencyReserveInput.parse(frame.params);result=residency.reserve(agent.id,input.revision);}
      else if(frame.method==='residencyCommit'){const input=ResidencyTokenInput.parse(frame.params);result=residency.commit(agent.id,input.token);}
      else if(frame.method==='residencyRelease'){const input=ResidencyTokenInput.parse(frame.params);result={released:residency.release(input.token),snapshot:residency.inspect(agent.id)};}
      else if(frame.method==='message'){const input=frame.params;result=await residency.admit(()=>messages.message(input));}
      else if(frame.method==='interrupt'){result=await residency.admit(()=>messages.interrupt(agent.id));}
      else if(frame.method==='mcpStatus'){result=mcp.status(agent.id);}
      else if(frame.method==='mcpContext'){result=mcp.context(frame.params);}
      else if (frame.method === 'observe') {
        // Capture a synchronous cut before flushing it. Events arriving during flush form the buffered suffix.
        const events=agent.session.snapshotEvents();
        if(events.length>Number(process.env.POLARITON_MAX_HISTORY_EVENTS))throw new Error('History exceeds observation budget');
        result={events,metrics:sessionMetrics(ctx,agent.session),assistantStream:streams.get(agent.id)?.snapshot()??{revision:0},cursor:agent.session.seq-1};
        await ctx.sessionPersistence.flush();
      } else throw new Error('Unsupported bridge method');
      send({ id: frame.id, result });
    } catch (error) {
      send({ id: frame?.id, error: { code:error instanceof Error&&'code'in error?error.code:'HARNESS_REJECTED', message: error instanceof Error ? error.message : 'Bridge operation failed' } });
    }
  });
  socket.on('error', error => ctx.logger.error('Polariton bridge failed', error));
  ctx.effect(() => () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Bridge closed')); }
    pending.clear(); lines.close(); socket.destroy();
  });
  send({ method: 'ready', params: { protocol: 1 } });
}
