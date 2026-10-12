import { EventEmitter } from 'node:events';
import type {HarnessPort,HarnessEvents,InputPart,MessageOrigin,Activity,PermissionRequest,PermissionAnswer} from '../../harness/contracts.ts';
import {isActivationPrompt} from './activation.ts';

/** Explicit event barrier for tests compiled against the application's ES2023 library. */
function barrier<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Controllable neighboring harness: tests choose settlement and exit independently of delivery. */
export class ControlledHarness extends EventEmitter<HarnessEvents> implements HarnessPort {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly promptEntered = barrier<void>();
  readonly closeEntered = barrier<void>();
  interrupted = barrier<unknown>();
  readonly messages: Array<{requestId:string;content:unknown[];origin:MessageOrigin}> = [];
  readonly closed = barrier<void>();
  readonly sourceEvents: { type: string; seq: number; time: number; data: unknown }[] = [];
  status: 'idle' | 'running' = 'idle';
  autoClose = true;
  promptStillAdmitting = false;
  settleCancellation = true;
  exited = false;
  readonly id: string;
  model:string;
  readonly permission: (request: PermissionRequest) => Promise<PermissionAnswer>;
  constructor(id: string, permission: (request: PermissionRequest) => Promise<PermissionAnswer>,model='deepseek-flash') {
    super(); this.id = id; this.permission = permission;this.model=model;
  }
  async start() { return {image:false}; }
  async locate():Promise<string|null>{this.calls.push({method:'locate',params:{}});return null;}
  options(){return [{id:'model',name:'Model',currentValue:JSON.stringify(['deepseek-official',this.model]),options:[{name:this.model,value:JSON.stringify(['deepseek-official',this.model])}]}];}
  async activate(sessionId:string|null,servers:Parameters<HarnessPort['activate']>[1]):ReturnType<HarnessPort['activate']>{this.calls.push({method:'activate',params:{sessionId,servers}});return {sessionId:this.id,options:this.options(),mcp:[]};}
  async configure(sessionId:string,id:string,value:string){this.calls.push({method:'configure',params:{sessionId,id,value}});this.model=JSON.parse(value)[1];return this.options();}
  async models(){this.calls.push({method:'models',params:{}});return [{value:JSON.stringify(['deepseek-official',this.model]),name:this.model,image:false}];}
  async observe(_sessionId:string){return {events:this.sourceEvents,cursor:this.sourceEvents.at(-1)?.seq??-1,assistantStream:{revision:0}};}
  async activity(_sessionId:string):Promise<Activity>{return {revision:0,eligible:false,blockers:[{kind:'unknown'}]};}
  async suspend(_sessionId:string,_revision:number,_canCommit:()=>boolean):ReturnType<HarnessPort['suspend']>{throw new Error('Suspension was not enabled in this fixture');}
  async message(sessionId:string,requestId:string,content:InputPart[],origin:MessageOrigin) {
    const message={sessionId,requestId,content,origin};this.calls.push({method:'message',params:message});
    this.messages.push(message);
    if(isActivationPrompt(message)){this.complete();return {messageId:requestId};}
    if(!this.promptStillAdmitting){this.status='running';this.emit('status',{sessionId:this.id,status:this.status});}
    this.interrupted=barrier<unknown>();this.promptEntered.resolve();return {messageId:requestId};
  }
  async interrupt(sessionId:string){
    this.calls.push({method:'interrupt',params:{sessionId}});
    if(!this.settleCancellation){await this.interrupted.promise;return;}
    this.complete('cancelled');
  }
  async closeSession(sessionId:string){this.calls.push({method:'closeSession',params:{sessionId}});this.complete('cancelled');}
  complete(stopReason = 'end_turn') {
    for(const message of this.messages.splice(0)){
      if(stopReason==='cancelled')this.emit('submission',{sessionId:this.id,requestId:message.requestId,state:'interrupted'});
      else {
        const source=message.origin.kind==='human'?{kind:'user',rpcId:message.requestId}:{kind:'polariton-worker',rpcId:message.requestId,workerId:message.origin.workerId};
        const event={type:'user/message',seq:this.sourceEvents.length,time:1000+this.sourceEvents.length,data:{id:message.requestId,role:'user',source,content:message.content}};
        this.sourceEvents.push(event);this.emit('source',{sessionId:this.id,seq:event.seq,type:event.type,event});this.emit('submission',{sessionId:this.id,requestId:message.requestId,state:'applied'});
      }
    }
    this.status = 'idle';
    this.emit('status', { sessionId: this.id, status: this.status });
    this.interrupted.resolve({interrupted:true});
  }
  close(): Promise<void> {
    this.closeEntered.resolve();
    if (this.autoClose) this.exit();
    return this.closed.promise;
  }
  exit() {
    if (this.exited) return;
    this.exited = true;

    this.emit('exit');
    this.closed.resolve();
  }
  askPermission(toolCallId: string) {
    this.sourceEvents.push({ type: 'tool/call', seq: this.sourceEvents.length, time: 1000 + this.sourceEvents.length,
      data: { callId: toolCallId, name: 'synthetic_tool', arguments: JSON.stringify({ purpose: `Review ${toolCallId}` }) } });
    return this.permission({ sessionId: this.id, toolCall: { toolCallId, title:'synthetic_tool', rawInput:{purpose:`Review ${toolCallId}`} }, options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ] });
  }
}
