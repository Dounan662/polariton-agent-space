import {requireRelease} from './release.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {SessionMetrics} from '../src/metrics.ts';
import { EventEmitter } from 'node:events';
import { guardianIdentity, settleGuardian} from './guardian-control.mjs';
import { GuardianSettings } from './settings.ts';
import {z} from 'zod';
import type {Writable,Readable} from 'node:stream';
import {Fault,type ModelOption} from '../src/contracts.ts';
import type {AccessGrant} from '../src/environment/contracts.ts';
import {ResidencySnapshot} from './settings.ts';
import {compose} from './composition.ts';
import {InputSource} from './message-source.ts';
import type {HarnessSettings,HarnessPort,HarnessEvents,PermissionRequest,PermissionAnswer,InputPart,MessageOrigin,SourceSnapshot,ModelChoice,UnavailableServer} from './contracts.ts';
const Event=z.object({type:z.string(),seq:z.number().int(),time:z.number().finite(),data:z.unknown()}).passthrough();
const Options=z.array(z.object({id:z.string(),name:z.string(),currentValue:z.string(),options:z.array(z.union([z.object({value:z.string(),name:z.string()}),z.object({group:z.string(),name:z.string(),options:z.array(z.object({value:z.string(),name:z.string()}))})]))}));
function modelOptions(raw:unknown):ModelOption[]{return Options.parse(raw).map(option=>({...option,options:option.options.flatMap(value=>'options'in value?value.options.map(item=>({...item,group:value.group})):[value])}));}
const Mcp=z.array(z.object({serverName:z.string(),status:z.enum(['connected','unavailable']),code:z.enum(['MCP_STARTUP_FAILED','MCP_STARTUP_TIMEOUT']).nullable()}).strict());


const root = fileURLToPath(new URL('../', import.meta.url));

/** Supervise one ACP process and its private control pipe; transport errors settle callers. */
export class Harness extends EventEmitter<HarnessEvents> implements HarnessPort {
  private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private sequence=0;
  readonly recoveryIdentity:z.infer<typeof import('./settings.ts').GuardianIdentity>;
  private guardianStarted?:Promise<void>;
  settled=false;
  private activating=false;
  private child?:ChildProcess;
  private config:HarnessSettings;
  readonly home:string;
  readonly workspace:string;
  private budget:()=>Promise<boolean>;
  private permissionHandler:(request:PermissionRequest)=>Promise<PermissionAnswer>;
  private guardianLimits:ReturnType<typeof GuardianSettings.parse>&{maxFrameBytes:number};
  private claims=new Map<string,Map<string,number>>();
  constructor(config:HarnessSettings,home:string,workspace:string,budget:()=>Promise<boolean>,permissionHandler:(request:PermissionRequest)=>Promise<PermissionAnswer>=async()=>({outcome:'cancelled'})){
    super();this.config=config;this.home=home;this.workspace=workspace;this.budget=budget;this.permissionHandler=permissionHandler;
    this.recoveryIdentity=guardianIdentity(home,config.runtimeDirectory,config.guardian.socketPathBytes);this.guardianLimits={...GuardianSettings.parse(config.guardian),maxFrameBytes:config.maxFrameBytes};
  }
  async start() {
    const release=await requireRelease();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const patch=await compose(this.config,this.workspace);
    await writeFile(resolve(this.home, 'cordis.patch.yml'), JSON.stringify(patch), { mode: 0o600 });
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Harness startup timed out')), this.config.startupTimeoutMs);
      this.once('ready', () => { clearTimeout(timer); resolveReady(); });
      this.once('exit', () => { clearTimeout(timer); reject(new Error('Harness exited during startup')); });
      this.once('transportError', error => { clearTimeout(timer); reject(error); });
    });
    this.child = spawn(process.execPath, [resolve(root, 'harness/guardian.mjs')], {
      detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    });
    this.guardianStarted = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Guardian startup timed out')), this.config.startupTimeoutMs);
      this.child!.on('message', raw => {
        const message=z.object({id:z.string(),type:z.string()}).passthrough().parse(raw);
        if (message.id !== this.recoveryIdentity.id) return;
        if (message.type === 'failure') { const error=Object.assign(new Error('Harness executable or workspace is unavailable'),{code:'HARNESS_SPAWN_FAILED'});this.fail(error);this.emit('transportError',error); }
        if (message.type === 'started') { clearTimeout(timer); accept(); }
        if (message.type === 'settled') { clearTimeout(timer); reject(Object.assign(new Error('Harness exited during startup'),{code:'HARNESS_STARTUP_EXIT'})); this.settled = true; this.fail(new Error('Harness process group stopped')); this.emit('exit', { code: null, signal: null }); }
        if (message.type === 'unsettled') { clearTimeout(timer); const error=new Error('Worker execution cleanup is unconfirmed');reject(error);this.fail(error);this.emit('transportError',error); }
      });
      this.child!.once('exit', () => { clearTimeout(timer); reject(new Error('Guardian exited during startup')); });
      this.child!.once('error', () => { clearTimeout(timer); reject(new Error('Guardian could not start')); });
    });
    this.child.stderr!.resume();
    this.child.on('error', () => { const error = new Error('Harness guardian transport failed'); this.fail(error); this.emit('transportError', error); });
    for(const stream of [this.child.stdin!,this.child.stdout!,this.child.stdio[3]!]) stream.on('error',()=>{const error=new Error('Harness transport failed');this.fail(error);this.emit('transportError',error);});
    this.child.on('exit', () => { if (!this.settled) { const error = new Error('Guardian exited without confirmed execution cleanup'); this.fail(error); this.emit('transportError', error); } });
    this.child.send!({identity:this.recoveryIdentity,execution:'native',command:process.execPath,args:['--import',resolve(root,'harness/console.mjs'),resolve(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','acp'],cwd:this.workspace,
      env:{...process.env,...(this.config.workerCredential?{HARNESSCTL_TOKEN:this.config.workerCredential.token,HARNESSCTL_SOCKET:this.config.workerCredential.socket,HARNESSCTL_CONFIG:this.config.workerCredential.config,PATH:resolve(root,'bin')+delimiter+process.env.PATH}:{}),DSH_HOME:this.home,DSH_TELEMETRY_DISABLED:'1',POLARITON_MAX_FRAME_BYTES:String(this.config.maxFrameBytes),POLARITON_MAX_HISTORY_EVENTS:String(this.config.maxHistoryEvents),POLARITON_REQUEST_TIMEOUT_MS:String(this.config.requestTimeoutMs),POLARITON_MCP_STARTUP_MS:String(this.config.mcpStartupTimeoutMs),POLARITON_MCP_CLEANUP_MS:String(this.config.mcpCleanupTimeoutMs)},limits:this.guardianLimits});
    for (const [input, output] of [[this.child.stdout, this.child.stdin], [this.child.stdio[3], this.child.stdio[3]]] as [Readable,Writable][]) {
      let buffered = Buffer.alloc(0);
      input.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        let end;
        while ((end = buffered.indexOf(10)) >= 0) {
          if (end > this.config.maxFrameBytes) break;
          const line = buffered.subarray(0, end).toString('utf8');
          buffered = buffered.subarray(end + 1);
          void this.frame(line, output);
        }
        if (buffered.length > this.config.maxFrameBytes) {
          buffered = Buffer.alloc(0);
          const error = new Error('Oversized harness frame'); this.fail(error); this.emit('transportError', error);
          void this.close().catch(() => this.emit('transportError', new Error('Worker execution cleanup is unconfirmed')));
        }
      });
    }
    await Promise.all([ready, this.guardianStarted]);
    const initialized = await this.exchange('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'polariton', version: release.version } });
    return {image:z.object({agentCapabilities:z.object({promptCapabilities:z.object({image:z.boolean().optional()}).optional()}).optional()}).parse(initialized).agentCapabilities?.promptCapabilities?.image===true};
  }
  private fail(error:Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  /** Parse all upstream messages at the edge; application consumers never interpret DSH event payloads. */
  private async frame(line:string,output:Writable){
    try{
      if(Buffer.byteLength(line)>this.config.maxFrameBytes)throw new Error('Oversized harness frame');
      const frame=z.object({id:z.union([z.string(),z.number()]).optional(),method:z.string().optional(),params:z.unknown().optional(),result:z.unknown().optional(),error:z.object({code:z.union([z.string(),z.number()]).optional()}).passthrough().optional()}).parse(JSON.parse(line));
      if(frame.method==='budget'){output.write(JSON.stringify({id:frame.id,result:{allowed:await this.budget()}})+'\n');return;}
      if(frame.method==='session/request_permission'){
        const request=z.object({sessionId:z.string(),toolCall:z.object({toolCallId:z.string(),title:z.string().optional(),rawInput:z.unknown().optional()}),options:z.array(z.object({optionId:z.string(),name:z.string(),kind:z.string()}))}).parse(frame.params);
        let title=request.toolCall.title,detail=request.toolCall.rawInput;
        if(!title||detail===undefined){
          for(const event of (await this.observe(request.sessionId)).events){
            if(event.type!=='tool/call')continue;
            const call=z.object({callId:z.string(),name:z.string(),arguments:z.string()}).safeParse(event.data);
            if(call.success&&call.data.callId===request.toolCall.toolCallId){title=call.data.name;detail=call.data.arguments;}
          }
        }
        const permission={...request,toolCall:{...request.toolCall,title:title??'Tool approval',rawInput:detail}};this.emit('permission',permission);
        const outcome=await this.permissionHandler(permission);
        output.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{outcome}})+'\n');return;
      }
      if(frame.method==='ready'){z.object({protocol:z.literal(1)}).parse(frame.params);this.emit('ready');return;}
      if(frame.method==='status'){this.emit('status',z.object({sessionId:z.string(),status:z.enum(['running','idle'])}).parse(frame.params));return;}
      if(frame.method==='residency'){this.emit('residency',ResidencySnapshot.extend({sessionId:z.string()}).parse(frame.params));return;}
      if(frame.method==='assistantStream'){this.emit('assistantStream',z.object({sessionId:z.string(),frame:z.unknown()}).parse(frame.params));return;}
      if(frame.method==='claimed'){
        const notice=z.object({sessionId:z.string(),source:z.unknown(),turn:z.number().int()}).parse(frame.params);
        const input=InputSource.safeParse(notice.source);
        if(input.success){let claims=this.claims.get(notice.sessionId);if(!claims){claims=new Map();this.claims.set(notice.sessionId,claims);}claims.set(input.data.rpcId,notice.turn);this.emit('turn',{sessionId:notice.sessionId,id:String(notice.turn),phase:'claimed',requestId:input.data.rpcId});}return;
      }
      if(frame.method==='discarded'){
        const notice=z.object({sessionId:z.string(),requestId:z.string().optional()}).parse(frame.params);
        if(notice.requestId)this.emit('submission',{sessionId:notice.sessionId,requestId:notice.requestId,state:'interrupted',detail:'Harness discarded this input before application'});return;
      }
      if(frame.method==='source'){
        const notice=z.object({sessionId:z.string(),seq:z.number().int(),type:z.string(),event:Event,metrics:SessionMetrics}).parse(frame.params);
        if(notice.seq!==notice.event.seq||notice.type!==notice.event.type)throw new Error('Source envelope identity disagrees with its record');
        const applied=z.object({type:z.literal('user/message'),data:z.object({source:InputSource})}).safeParse(notice.event);
        const claims=this.claims.get(notice.sessionId);
        if(applied.success){const requestId=applied.data.data.source.rpcId;claims?.delete(requestId);this.emit('submission',{sessionId:notice.sessionId,requestId,state:'applied'});}
        const ended=z.object({type:z.literal('turn/end'),data:z.object({turn:z.number().int(),reason:z.object({kind:z.string()}).passthrough()})}).safeParse(notice.event);
        if(ended.success&&claims)for(const [requestId,turn]of claims){if(turn!==ended.data.data.turn)continue;claims.delete(requestId);this.emit('submission',{sessionId:notice.sessionId,requestId,state:ended.data.data.reason.kind==='aborted'?'interrupted':'failed',detail:`Harness ended the turn (${ended.data.data.reason.kind}) before applying this message`});}
        if(ended.success)this.emit('turn',{sessionId:notice.sessionId,id:String(ended.data.data.turn),phase:'ended',reason:ended.data.data.reason});
        this.emit('source',notice);return;
      }
      // ACP session/update is redundant with the authoritative source and typed observations above.
      if(frame.method==='session/update')return;
      if(frame.method)throw new Error(`Unsupported harness notification: ${frame.method}`);
      const request=this.pending.get(String(frame.id));if(!request)return;
      this.pending.delete(String(frame.id));clearTimeout(request.timer);
      if(frame.error)request.reject(Object.assign(new Error('Harness request failed; check capability preparation and authentication'),{code:frame.error.code??'HARNESS_REJECTED'}));else request.resolve(frame.result);
    }catch(error){const failure=new Error('Harness protocol frame was invalid',{cause:error});this.fail(failure);this.emit('transportError',failure);}
  }
  private async open(sessionId:string|null,servers:AccessGrant['servers']):Promise<unknown>{
    const method=sessionId?'session/resume':'session/new',params={...(sessionId?{sessionId}:{}),cwd:this.workspace,mcpServers:servers};
    {
      if(this.activating)throw new Error('Harness session activation is already in progress');
      this.activating=true;
      try{
        await this.exchange('mcpPrepare',{cwd:params.cwd,servers:params.mcpServers??[]},true);
        const opened=z.object({sessionId:z.string().optional(),configOptions:z.unknown().optional()}).passthrough().parse(await this.exchange(method,{...params,mcpServers:[]}));
        const polaritonMcp=await this.exchange('mcpStatus',{sessionId:opened.sessionId??params.sessionId},true);
        return {...opened,polaritonMcp};
      }finally{
        this.activating=false;
        // The owning caller closes the guardian on failed activation; this clears only inert input.
        await this.exchange('mcpClear',{},true).catch(()=>{this.emit('diagnostic',{code:'MCP_PLAN_CLEAR_FAILED',message:'Prepared MCP input could not be cleared; close this host before another activation'});});
      }
    }
  }
  private exchange(method:string,params:unknown,bridge=false):Promise<unknown> {
    return new Promise((resolveRequest, reject) => {
      const output = (bridge ? this.child?.stdio[3] : this.child?.stdin) as Writable|null|undefined;
      if (!output || output.destroyed || output.writableEnded) { reject(new Error('Harness transport is closed')); return; }
      const id = String(++this.sequence);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      output.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {if(error){const pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.reject(error);}}});
    });
  }
  async locate():Promise<string|null>{
    const listed=z.object({sessions:z.array(z.object({sessionId:z.string()}))}).parse(await this.exchange('session/list',{cwd:this.workspace}));
    if(listed.sessions.length>1)throw new Fault('AMBIGUOUS_BINDING','Several unbound harness sessions require manual reconciliation');return listed.sessions[0]?.sessionId??null;
  }
  async activate(sessionId:string|null,servers:AccessGrant['servers'],unavailable:UnavailableServer[]=[]){
    const retained=sessionId??await this.locate();
    const opened=z.object({sessionId:z.string().optional(),configOptions:z.unknown().optional(),polaritonMcp:Mcp}).parse(await this.open(retained,servers));
    const id=opened.sessionId??retained;if(!id)throw new Error('Harness did not identify the activated session');
    let options=modelOptions(opened.configOptions??[]);
    const selected=this.config.selectedModel??JSON.stringify([this.config.provider,this.config.model]);
    if(!options.find(value=>value.id==='model')?.options.some(value=>value.value===selected))throw new Fault('MODEL_UNAVAILABLE','Selected model is not offered by this session');
    if(options.find(value=>value.id==='model')?.currentValue!==selected)options=await this.configure(id,'model',selected);
    if(opened.polaritonMcp.length!==servers.length||new Set(opened.polaritonMcp.map(value=>value.serverName)).size!==servers.length||servers.some(server=>!opened.polaritonMcp.some(value=>value.serverName===server.name)))throw new Fault('MCP_OBSERVATION','Harness did not report every requested MCP server');
    const failures:UnavailableServer[]=[...opened.polaritonMcp.filter((server):server is typeof server&{status:'unavailable'}=>server.status==='unavailable'),...unavailable];
    await this.exchange('mcpContext',{sessionId:id,servers:failures},true);
    await this.exchange('activationReady',{sessionId:id},true);
    return {sessionId:id,options,mcp:opened.polaritonMcp};
  }
  async models():Promise<ModelChoice[]>{return z.array(z.object({value:z.string(),name:z.string(),image:z.boolean()})).parse(await this.exchange('models',{provider:this.config.provider},true));}
  async configure(sessionId:string,id:string,value:string){
    const result=z.object({configOptions:z.unknown()}).parse(await this.exchange('session/set_config_option',{sessionId,configId:id,value}));
    const options=modelOptions(result.configOptions);if(options.find(option=>option.id===id)?.currentValue!==value)throw new Fault('MODEL_UNAVAILABLE','Harness did not confirm the selected option');return options;
  }
  async message(sessionId:string,requestId:string,content:InputPart[],origin:MessageOrigin):Promise<{messageId:string}>{return z.object({admitted:z.literal(true),messageId:z.string()}).parse(await this.exchange('message',{sessionId,requestId,content,origin},true));}
  async interrupt(sessionId:string):Promise<void>{z.object({interrupted:z.literal(true)}).parse(await this.exchange('interrupt',{sessionId},true));}
  async observe(sessionId:string):Promise<SourceSnapshot>{return z.object({events:z.array(Event),metrics:SessionMetrics,cursor:z.number().int(),assistantStream:z.object({revision:z.number().int()}).passthrough()}).parse(await this.exchange('observe',{sessionId},true));}
  async activity(sessionId:string){return ResidencySnapshot.parse(await this.exchange('residency',{sessionId},true));}
  /** Reservation and settlement are one operation. The caller rechecks only its own admission facts. */
  async suspend(sessionId:string,revision:number,canCommit:()=>boolean){
    let token:string|undefined,committed=false;
    try{
      const reserved=z.object({reserved:z.boolean(),token:z.string().optional(),snapshot:ResidencySnapshot}).parse(await this.exchange('residencyReserve',{sessionId,revision},true));
      token=reserved.token;
      if(!reserved.reserved||!token||!canCommit())return {suspended:false,snapshot:reserved.snapshot};
      const result=z.object({committed:z.boolean(),snapshot:ResidencySnapshot}).parse(await this.exchange('residencyCommit',{sessionId,token},true));
      if(!result.committed)return {suspended:false,snapshot:result.snapshot};
      committed=true;this.emit('suspending');
      try{await this.closeSession(sessionId);}catch{this.emit('diagnostic',{code:'SESSION_CLOSE_UNCONFIRMED',message:'Settling the reserved process after an unconfirmed session close'});}
      await this.close();return {suspended:true,snapshot:result.snapshot};
    }finally{
      if(token&&!committed){try{await this.exchange('residencyRelease',{sessionId,token},true);}catch{throw new Fault('RESERVATION_UNCERTAIN','Idle reservation release was not confirmed; close the worker before resuming');}}
    }
  }
  async closeSession(sessionId:string):Promise<void>{await this.exchange('deactivate',{sessionId},true);await this.exchange('session/close',{sessionId});}
  /** Completion requires both native execution drain and guardian process-group settlement. */
  async close() {
    if (!this.child) return;
    await this.guardianStarted?.catch(() => {});
    await settleGuardian(this.recoveryIdentity, this.guardianLimits, 'native');
    this.settled = true;
    this.fail(new Error('Harness transport is closed'));
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stdio[3]]) stream?.destroy();
  }
  static async recover(identity:z.infer<typeof import('./settings.ts').GuardianIdentity>, config:HarnessSettings) {
    await settleGuardian(identity, {...config.guardian,maxFrameBytes:config.maxFrameBytes}, 'native');
  }
}
