// @ts-check
import {Socket} from 'node:net';
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local';
import {z} from 'zod';
import {drainMcp} from './native/mcp-client.mjs';
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} Runtime */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} ProcessHandle */
/** @typedef {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalHandle} TerminalHandle */

/**
 * Own all native allocations across shutdown, including terminals which have not
 * published their handle yet. Upstream remains the execution and quiescence
 * authority; a command's exit is never substituted for its managed range's exit.
 * Drain permanently closes admission and succeeds only on positive range proof.
 */
export class ExecutionOwner {
  /** @type {Set<ProcessHandle>} */ processes=new Set();
  /** @type {Set<TerminalHandle>} */ terminals=new Set();
  /** @type {Set<Promise<TerminalHandle>>} */ allocations=new Set();
  /** @type {Map<TerminalHandle,Promise<void>>} */ terminating=new Map();
  /** @type {Error[]} */ allocationFailures=[];
  /** @type {Promise<void>|undefined} */ draining;
  closed=false;
  /** @param {Pick<Runtime,'spawn'|'spawnTerminal'> & {onFailure:(error:Error)=>void}} provider */
  constructor(provider){this.provider=provider;}
  check(){if(this.closed)throw Object.assign(new Error('Native execution is shutting down'),{code:'EXECUTION_CLOSING'});}
  /** @param {Parameters<Runtime['spawn']>[0]} spec @returns {ProcessHandle} */
  spawn(spec){
    this.check();spec.signal?.throwIfAborted();const handle=this.provider.spawn(spec);this.processes.add(handle);
    // Failed launch outcomes also need range observation. This observer never
    // changes command results and leaves unproven handles owned for final drain.
    const observe=async()=>{if(await handle.waitForExit())this.processes.delete(handle);};
    void handle.done.then(observe,observe).catch(error=>this.provider.onFailure(asError(error)));
    return handle;
  }
  /** @param {Parameters<Runtime['spawnTerminal']>[0]} spec @returns {Promise<TerminalHandle>} */
  spawnTerminal(spec){
    this.check();spec.signal?.throwIfAborted();
    const allocation=this.provider.spawnTerminal(spec).then(handle=>{
      this.terminals.add(handle);
      if(!spec.shellActivity){
        const settled=()=>this.terminateTerminal(handle);
        void handle.done.then(settled,settled).catch(error=>this.provider.onFailure(asError(error)));
      }
      // A successful terminal termination is the public whole-session proof.
      // Preserve the native handle's streams and behavior while observing that
      // proof even when the ordinary terminal consumer initiates shutdown.
      return {
        get pid(){return handle.pid;},get output(){return handle.output;},get done(){return handle.done;},
        write:data=>handle.write(data),resize:(cols,rows)=>handle.resize(cols,rows),
        inspectForeground:()=>handle.inspectForeground(),inspectActivity:()=>handle.inspectActivity(),
        signalForeground:signal=>handle.signalForeground(signal),terminate:()=>this.terminateTerminal(handle),
      };
    },error=>{
      const failure=asError(error);this.allocationFailures.push(failure);this.provider.onFailure(failure);throw error;
    }).finally(()=>this.allocations.delete(allocation));
    this.allocations.add(allocation);return allocation;
  }
  /** @param {TerminalHandle} handle @returns {Promise<void>} */
  terminateTerminal(handle){
    let pending=this.terminating.get(handle);if(pending)return pending;
    pending=Promise.resolve().then(()=>handle.terminate()).then(()=>{this.terminals.delete(handle);});
    this.terminating.set(handle,pending);
    void pending.then(()=>this.terminating.delete(handle),()=>this.terminating.delete(handle));
    return pending;
  }
  /** A timeout belongs to the external guardian; pending cleanup never becomes success. */
  drain(){
    if(this.draining)return this.draining;
    this.closed=true;
    this.draining=(async()=>{
      // Start termination of already-published ranges immediately; a pending
      // terminal allocation must not delay unrelated cleanup.
      const initialTerminals=new Set(this.terminals);
      const initial=Promise.allSettled([
        ...[...this.processes].map(async handle=>{
          handle.terminate();
          if(!await handle.waitForExit())throw new Error('Native process range did not confirm quiescence');
          this.processes.delete(handle);
        }),
        ...[...initialTerminals].map(handle=>this.terminateTerminal(handle)),
      ]);
      // Every accepted allocation was registered before admission closed. Its
      // published handle must be included even if it arrives during shutdown.
      await Promise.allSettled([...this.allocations]);
      const late=await Promise.allSettled([...this.terminals].filter(handle=>!initialTerminals.has(handle)).map(handle=>this.terminateTerminal(handle)));
      const settled=[...await initial,...late];
      const failures=[...this.allocationFailures,...settled.flatMap(value=>value.status==='rejected'?[asError(value.reason)]:[])];
      if(failures.length)throw new AggregateError(failures,'Native execution settlement could not be proven');
    })();
    return this.draining;
  }
}
/** @param {unknown} error */
function asError(error){return error instanceof Error?error:new Error('Native execution ownership failed',{cause:error});}

const Drain=z.object({id:z.string().min(1),method:z.literal('drain')}).strict();

/** The qualified native provider, with one private guardian-owned drain channel. */
export default class OwnedSubprocessRuntime extends LocalSubprocessRuntime {
  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx){
    super(ctx);
    this.owner=new ExecutionOwner({spawn:spec=>super.spawn(spec),spawnTerminal:spec=>super.spawnTerminal(spec),onFailure:error=>ctx.logger.error('Native execution ownership observation failed',error)});
    const maxFrameBytes=z.coerce.number().int().positive().parse(process.env.POLARITON_MAX_FRAME_BYTES);
    const socket=new Socket({fd:4});let buffered=Buffer.alloc(0);
    const drain=async()=>{try{await Promise.all([this.owner.drain(),drainMcp(ctx)]);return true;}catch(error){ctx.logger.error('Native execution drain failed',error);return false;}};
    socket.on('data',chunk=>{
      if(buffered.length+chunk.length>maxFrameBytes){socket.destroy(new Error('Oversized execution control frame'));return;}
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length){
        const end=buffered.indexOf(10);
        if(end<0){if(buffered.length>maxFrameBytes)socket.destroy(new Error('Oversized execution control frame'));return;}
        if(end>maxFrameBytes){socket.destroy(new Error('Oversized execution control frame'));return;}
        const line=buffered.subarray(0,end);buffered=buffered.subarray(end+1);
        let request;try{request=Drain.parse(JSON.parse(line.toString('utf8')));}catch{socket.destroy(new Error('Invalid execution control frame'));return;}
        const {id}=request;void drain().then(settled=>{if(!socket.destroyed)socket.write(JSON.stringify({id,settled})+'\n');});
      }
    });
    socket.on('error',error=>ctx.logger.error('Native execution control failed',error));
    socket.once('close',()=>{void drain();});
    ctx.effect(()=>async()=>{await Promise.all([this.owner.drain(),drainMcp(ctx)]);socket.destroy();});
  }
  /** @param {Parameters<Runtime['spawn']>[0]} spec */
  spawn(spec){return this.owner.spawn(spec);}
  /** @param {Parameters<Runtime['spawnTerminal']>[0]} spec */
  spawnTerminal(spec){return this.owner.spawnTerminal(spec);}
}
