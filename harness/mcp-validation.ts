import {spawn,type ChildProcess} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir,open,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Duplex} from 'node:stream';
import {GuardianIdentity,GuardianSettings} from './settings.ts';
import {guardianIdentity,settleGuardian} from './guardian-control.mjs';
import {McpValidationInput,McpValidationLimits,McpValidationResult} from './mcp-contracts.ts';
import {validationPlan} from './mcp.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function supervision(budget:McpValidationLimits){const defaults=GuardianSettings.parse({});return {...defaults,nativeDrainTimeoutMs:budget.cleanupMs,requestTimeoutMs:Math.max(defaults.requestTimeoutMs,budget.cleanupMs+defaults.termTimeoutMs+defaults.killTimeoutMs+defaults.pollMs),maxFrameBytes:budget.maxOutputBytes};}
async function retained(directory:string,maxBytes:number){
  let file;try{file=await open(join(directory,'.mcp-validation.json'),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.()||info.size>maxBytes)throw new Error('Invalid validation ownership');return GuardianIdentity.parse(JSON.parse(await file.readFile('utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}finally{await file?.close();}
}
/** Recover only the authenticated prior owner; never signal a persisted PID or
 * repeat a functional action after an interrupted result. The caller releases
 * the validation access/scratch only after this succeeds. */
export async function recoverMcpValidation(directory:string,budget:McpValidationLimits):Promise<void>{const limits=McpValidationLimits.parse(budget),identity=await retained(directory,limits.maxOutputBytes);if(identity)await settleGuardian(identity,supervision(limits),'native');}

/** Run inference-free validation in its own guardian-owned process. `cwd` is a
 * private operation directory; identity is durable before any process launches.
 * Observation and cancellation preserve the cleanup obligation independently of
 * discovery or functional results. No research worker or model provider exists. */
export async function validateMcp(raw:McpValidationInput,budget:McpValidationLimits,signal?:AbortSignal):Promise<McpValidationResult>{
  const {plan:input,limits}=validationPlan(raw,budget),guardianLimits=supervision(limits);
  const fallback=():McpValidationResult=>({servers:input.servers.map(server=>({serverName:server.name,connection:'unavailable',discovery:'failed',tools:[],code:signal?.aborted?'MCP_CANCELLED':'MCP_STARTUP_FAILED'})),checks:input.checks.map(check=>({name:check.name,serverName:check.serverName,toolName:check.toolName,status:'not_run',code:signal?.aborted?'MCP_CANCELLED':'MCP_NOT_CONNECTED',outputDigest:null})),cleanup:{status:'unconfirmed',code:'MCP_CLEANUP_FAILED'}});
  if(signal?.aborted)return {...fallback(),cleanup:{status:'settled',code:null}};
  const request=JSON.stringify({input,limits})+'\n';if(Buffer.byteLength(request)>limits.maxOutputBytes)throw new Error('Validation input exceeds the private frame budget');
  await mkdir(input.cwd,{recursive:true,mode:0o700});await recoverMcpValidation(input.cwd,limits);
  const identity=guardianIdentity(input.cwd,undefined,guardianLimits.socketPathBytes),path=join(input.cwd,'.mcp-validation.json'),temporary=`${path}.${randomUUID()}.tmp`;
  const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(identity));await file.sync();}finally{await file.close();}await rename(temporary,path);const directory=await open(input.cwd,'r');try{await directory.sync();}finally{await directory.close();}
  let child:ChildProcess|undefined,bridge:Duplex|undefined,result=fallback();
  try {
    child=spawn(process.execPath,[resolve(root,'harness/guardian.mjs')],{detached:true,stdio:['pipe','pipe','pipe','pipe','ipc']});bridge=child.stdio[3] as Duplex;
    child.stdout!.resume();child.stderr!.resume();
    const observed=new Promise<McpValidationResult>((accept,reject)=>{
      let buffer=Buffer.alloc(0),settled=false;
      const timer=setTimeout(()=>finish(new Error('Validation observation timed out')),limits.startupMs+input.checks.length*limits.callMs+limits.cleanupMs);
      function finish(error?:Error,value?:McpValidationResult){if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else accept(value!);}
      child!.on('error',()=>finish(new Error('Validation guardian unavailable')));child!.on('exit',()=>finish(new Error('Validation guardian exited')));
      child!.on('message',raw=>{const message=z.object({type:z.string(),id:z.string()}).passthrough().safeParse(raw);if(!message.success||message.data.id!==identity.id)return;if(message.data.type==='started')bridge!.write(request);if(['unsettled','failure'].includes(message.data.type))finish(new Error('Validation guardian could not confirm execution'));});
      bridge!.on('error',()=>finish(new Error('Validation host connection failed')));bridge!.on('data',(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>limits.maxOutputBytes){finish(new Error('Validation result exceeds its byte budget'));return;}const end=buffer.indexOf(10);if(end<0)return;try{const reply=z.object({result:McpValidationResult}).strict().parse(JSON.parse(buffer.subarray(0,end).toString('utf8')));finish(undefined,reply.result);}catch{finish(new Error('Validation host result is invalid'));}});
    });
    const cancel=()=>bridge?.write(JSON.stringify({kind:'cancel'})+'\n');signal?.addEventListener('abort',cancel,{once:true});
    try {
      child.send!({identity,execution:'native',command:process.execPath,args:['--import',resolve(root,'harness/console.mjs'),resolve(root,'harness/validation-host.mjs')],cwd:input.cwd,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DSH_TELEMETRY_MODE:'DISABLED',POLARITON_MAX_FRAME_BYTES:String(limits.maxOutputBytes)},limits:guardianLimits});
      if(signal?.aborted)cancel();result=await observed;
    } finally {signal?.removeEventListener('abort',cancel);}
  } catch {result=fallback();}
  finally {
    try{await settleGuardian(identity,guardianLimits,'native');result.cleanup={status:'settled',code:null};}catch{result.cleanup={status:'unconfirmed',code:'MCP_CLEANUP_FAILED'};}
    for(const stream of [child?.stdin,child?.stdout,child?.stderr,bridge])stream?.destroy();
    if(child?.connected)child.disconnect();
  }
  return result;
}
