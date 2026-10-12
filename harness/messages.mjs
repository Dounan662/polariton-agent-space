// @ts-check
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {admitEncodedImages} from '@deepseek-ai/dsh-attachment';
import {setImmediate as dispatch} from 'node:timers/promises';
import {z} from 'zod';
import {SessionId} from '@deepseek-ai/dsh-session';
import {MessageOrigin} from './contracts.ts';
import {InputSource} from './message-source.ts';
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} Agent */
/** @typedef {import('@deepseek-ai/dsh-llm').UserMessage['content']} Content */
/** @typedef {{controller:AbortController,tail:Promise<void>|null,interrupt:Promise<{interrupted:true}>|null,closed:boolean}} Admission */

const Input = z.object({sessionId:z.string().min(1),requestId:z.string().min(1),origin:MessageOrigin,content:z.array(z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),text:z.string()}).strict(),
  z.object({type:z.literal('image'),data:z.string(),mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif'])}).strict(),
])).min(1)}).strict().refine(value=>value.content.some(part=>part.type==='image'||part.text.trim()),'Enter a message');
/** @param {string} code @param {string} message */
const failure = (code,message) => Object.assign(new Error(message),{code});

/**
 * Admit identified user input to DSH's native inbox, regardless of driver state.
 * Main owns durable deduplication. This boundary owns ordered content admission
 * and the interrupt fence: no image completion may enqueue after its cancellation.
 * Every prepared input enters through one event-loop dispatch, in arrival order.
 * Dispatching at the I/O boundary lets the current turn's driver bookkeeping
 * settle before new input, without retries or private inbox mutation.
 */
export class NativeMessages {
  /** @type {WeakMap<Agent,Admission>} */
  states = new WeakMap();
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) { this.ctx=ctx; }
  /** @param {Agent} agent @returns {Admission} */
  state(agent) {
    let state=this.states.get(agent);
    if(!state){
      state={controller:new AbortController(),tail:null,interrupt:null,closed:false};
      this.states.set(agent,state);
      const owned=state;agent.ctx.effect(()=>async()=>{owned.closed=true;owned.controller.abort();await owned.tail;});
    }
    return state;
  }
  /** @param {string} sessionId */
  agent(sessionId) {
    const agent=this.ctx.agents.get(SessionId(sessionId));
    if(!agent)throw failure('SESSION_INACTIVE','Session is not active');
    return agent;
  }
  /** @param {unknown} raw */
  message(raw) {
    const parsed=Input.safeParse(raw);
    if(!parsed.success)throw failure('MESSAGE_INVALID','Message identity and ordered text or image content are required');
    const input=parsed.data,agent=this.agent(input.sessionId),state=this.state(agent);
    if(state.closed)throw failure('SESSION_INACTIVE','Session is closing');
    if(state.interrupt)throw failure('WORKER_INTERRUPTING','Wait for interruption to settle');
    const signal=state.controller.signal;
    /** @param {Content} content */
    const commit=async content=>{
      await dispatch();
      if(signal.aborted)throw failure('MESSAGE_CANCELLED','Message admission was interrupted before enqueue');
      if(state.closed||this.ctx.agents.get(agent.id)!==agent)throw failure('SESSION_INACTIVE','Session closed before message admission');
      const source=InputSource.parse(input.origin.kind==='human'?{kind:'user',rpcId:input.requestId}:{kind:'polariton-worker',rpcId:input.requestId,workerId:input.origin.workerId});
      const message=createUserMessage({content,source});
      agent.steer(message);
      return {admitted:true,messageId:message.id};
    };
    const images=input.content.filter(part=>part.type==='image');
    const admit=async()=>{
      if(signal.aborted)throw failure('MESSAGE_CANCELLED','Message admission was interrupted before enqueue');
      if(!images.length)return commit(input.content.filter(part=>part.type==='text'));
      // Main launches with the selected route and restarts after model changes.
      // ACP's private mutable selection must not become an alternate route owner.
      const {provider,model}=agent.options,attachments=this.ctx.get('attachments');
      if(!provider||!model||!attachments)throw failure('IMAGE_UNSUPPORTED','The current worker cannot admit images');
      /** @type {readonly import('@deepseek-ai/dsh-attachment').ImageAttachmentRef[]} */
      let refs;
      try{
        const info=await this.ctx.llm.resolveModelInfo(provider,model,signal);
        if(signal.aborted)throw failure('MESSAGE_CANCELLED','Message admission was interrupted before enqueue');
        if(!info.inputModalities?.includes('image'))throw failure('IMAGE_UNSUPPORTED','The selected model does not support image input');
        refs=await admitEncodedImages(attachments,images.map(part=>({data:part.data,mediaType:part.mimeType})));
      }catch(error){
        if(signal.aborted)throw failure('MESSAGE_CANCELLED','Message admission was interrupted before enqueue');
        if(error instanceof Error&&'code'in error&&error.code==='IMAGE_UNSUPPORTED')throw error;
        throw failure('IMAGE_ADMISSION_FAILED','Image content could not be validated and retained');
      }
      let index=0;
      return commit(input.content.map(part=>part.type==='text'?part:{type:'image',attachment:refs[index++]}));
    };
    const work=state.tail?state.tail.then(admit):admit();
    // The caller owns work's failure. The tail is only a quiescence barrier so
    // one rejected batch cannot poison later admission or interruption cleanup.
    const settled=work.then(()=>{},()=>{});
    state.tail=settled;
    void settled.then(()=>{if(state.tail===settled)state.tail=null;});
    return work;
  }
  /** Cancel admission and active work, then acknowledge the whole-agent barrier. */
  /** @param {string} sessionId */
  interrupt(sessionId) {
    const agent=this.agent(sessionId),state=this.state(agent);
    if(state.interrupt)return state.interrupt;
    const done=/** @type {PromiseWithResolvers<{interrupted:true}>} */(Promise.withResolvers());state.interrupt=done.promise;
    state.controller.abort();
    const stop=async()=>{
      agent.cancel({kind:'user'});
      await Promise.all([state.tail,agent.whenIdle()]);
      state.controller=new AbortController();state.interrupt=null;
      return /** @type {{interrupted:true}} */({interrupted:true});
    };
    void stop().then(done.resolve,done.reject);
    return done.promise;
  }
}
