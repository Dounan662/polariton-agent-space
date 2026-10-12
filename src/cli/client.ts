import {constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {loadConfig,type Config} from '../config.ts';
import {CanvasSnapshotFile} from '../canvas-contracts.ts';
import {Fault} from '../contracts.ts';
import {owner} from '../caller.ts';
import {EnvironmentClient,loadRackConfig,socketRequest} from '../environment/daemon.ts';
import {parseJsonInput} from '../json-input.ts';
import {applicationSocket} from './server.ts';
import {commands,parseCommand,Request,environmentCommand,isMutation,type CommandName} from './contracts.ts';
import {faultInfo} from '../operations.ts';
import {helpOutput,unknownCommand} from './help.ts';
import {Result,Receipt,FollowRecord,parseResult} from './results.ts';
import {compactReceipt} from './receipts.ts';
import {invalidInvocation} from './input-errors.ts';
const camel=(name:string)=>name.replace(/-([a-z])/g,(_m,c:string)=>c.toUpperCase());
const duration=(value:string)=>{const match=/^(\d+)(ms|s|m|h)$/.exec(value);if(!match)throw new Fault('INVALID_INPUT','Use a duration such as 30s, 2m or 500ms',400);return Number(match[1])*({ms:1,s:1000,m:60000,h:3600000}[match[2]!]!);};
export function exitCode(value:unknown):number{
 if(!value||typeof value!=='object')return 0;
 const r=value as {state?:string;status?:string;error?:{code?:string};code?:string};
 const code=r.error?.code??r.code;
 if(r.state==='uncertain'||code?.includes('UNCERTAIN'))return 7;
 if(code){
  if(/AUTH|ACTOR|ORIGIN|GRANT_DENIED/.test(code))return 4;
  if(code==='WORKSPACE_CHANGED'||code==='CANVAS_AMBIGUOUS')return 3;
  if(code==='CAPTURE_TIMEOUT'||code==='CAPTURE_CANCELLED')return 6;
  if(/CONFLICT|BUSY|LIMIT|CAPACITY|STALE|REQUIRED|NOT_FOUND|NOT_ADMITTED|REMOVED|NO_HISTORY|CLOSED/.test(code))return 3;
  if(/INVALID|USAGE|INPUT|BODY|^STORAGE_VERSION$|^STATE_FORMAT$/.test(code))return 2;
  if(/UNAVAILABLE|ECONNREFUSED|ENOENT/.test(code))return 5;
  if(/TIMEOUT/.test(code))return 8;
 }
 if(r.state==='failed'||r.state==='partial'||r.status==='partial')return 6;
 return code?1:0;
}
/** Takes one bounded UTF-8 input snapshot before dispatch. Named inputs must be regular files;
 * intentional streams enter only through stdin. Text and JSON share the same byte boundary. */
async function input(path:string,maxBytes:number,pageBytes:number){
 const chunks:Buffer[]=[];let size=0;
 const file=path==='-'?undefined:await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  if(file){const info=await file.stat();if(!info.isFile())throw new Fault('INVALID_INPUT','Input must be a regular file; use --input - for a stream',400);if(info.size>maxBytes)throw new Fault('INPUT_LIMIT','Input exceeds configured body limit',400);}
  for await(const chunk of file?file.createReadStream({highWaterMark:pageBytes,autoClose:false}):process.stdin){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)throw new Fault('INPUT_LIMIT','Input exceeds configured body limit',400);chunks.push(bytes);}
  try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}
  catch{throw new Fault('INVALID_INPUT','Input must be valid UTF-8',400);}
 }finally{await file?.close();}
}
/** Export only the exact captured PNG. A temporary file can expire or change after
 * the daemon responds; bounded reading and its capture digest make either visible. */
async function snapshotBytes(snapshot:CanvasSnapshotFile,config:Config):Promise<Buffer>{
 const source=await open(snapshot.output,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{
  const info=await source.stat();
  if(!info.isFile()||info.size!==snapshot.bytes||info.size>config.canvas.maxImageBytes)throw new Fault('CANVAS_EXPORT_FAILED','Temporary snapshot is unavailable or exceeds its capture bounds');
  const chunks:Buffer[]=[];let total=0;
  for await(const chunk of source.createReadStream({highWaterMark:config.filePageBytes,autoClose:false})){
   const bytes=Buffer.from(chunk);total+=bytes.length;
   if(total>snapshot.bytes||total>config.canvas.maxImageBytes)throw new Fault('CANVAS_EXPORT_FAILED','Temporary snapshot changed while reading');
   chunks.push(bytes);
  }
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==snapshot.bytes||createHash('sha256').update(bytes).digest('hex')!==snapshot.sha256)throw new Fault('CANVAS_EXPORT_FAILED','Temporary snapshot does not match its capture digest');
  return bytes;
 }finally{await source.close();}
}
let observerClosed=false;
async function output(value:unknown,timeoutMs?:number,format:'json'|'text'='json'){
 if(observerClosed||process.stdout.destroyed||process.stdout.writableEnded)throw new Fault('OBSERVER_TIMEOUT','Output observer disconnected');
 if(process.stdout.write(format==='text'?String(value):JSON.stringify(value)+'\n'))return;
 await new Promise<void>((accept,reject)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{if(timer)clearTimeout(timer);process.stdout.off('drain',drained);process.stdout.off('error',failed);};
  const drained=()=>{cleanup();accept();},failed=(error:Error)=>{cleanup();reject(error);};
  process.stdout.once('drain',drained);process.stdout.once('error',failed);
  if(timeoutMs!==undefined)timer=setTimeout(()=>{cleanup();observerClosed=true;process.stdout.destroy();reject(new Fault('OBSERVER_TIMEOUT','Output consumer did not drain within the observation budget'));},timeoutMs);
 });
}
/** Shared lexical parsing keeps discovery and execution on one CLI grammar. */
export function parseArguments(args:string[]){
 const words:string[]=[],flags:Record<string,string|boolean>={};
 const switches=new Set(['help','json','schema','details','wait','follow','preview','options','force','detach','textStdin','install']);
 for(let p=0;p<args.length;p++){const arg=args[p]!;if(!arg.startsWith('--')){words.push(arg);continue;}const key=camel(arg.slice(2));if(Object.hasOwn(flags,key))throw new Fault('INVALID_INPUT',`Duplicate flag --${arg.slice(2)}`,400);if(switches.has(key))flags[key]=true;else {const next=args[++p];if(next===undefined||next.startsWith('--'))throw new Fault('INVALID_INPUT',`${arg} requires a value`,400);flags[key]=next;}}
 return {words,flags};
}
/** Parse caller input without installation I/O or dispatch. Structured input has
 * already been decoded by the caller; this is also the release example boundary. */
export function parseInvocation(words:string[],flags:Record<string,string|boolean>,supplied:Record<string,unknown>={}){
 const name=words.length>=2?`${words[0]}.${words[1]}` as CommandName:undefined;
 if(!name||!Object.hasOwn(commands,name)||words.length>3)unknownCommand(words[0]);
 let values={...supplied};
 const fields=z.toJSONSchema(commands[name].input,{io:'input'}) as {properties?:Record<string,{type?:string;anyOf?:Array<{type?:string}>}>};
 if(flags.textStdin&&(name!=='worker.send'||flags.text!==undefined||flags.input==='-'))throw new Fault('INVALID_INPUT','--text-stdin is for worker send and cannot combine with --text or --input -',400);
 if(flags.systemPromptFile!==undefined&&name!=='worker.create')throw new Fault('INVALID_INPUT','--system-prompt-file applies only to worker create',400);
 if(name==='capability.preview'&&values.mcpServers!==undefined)values={configuration:values};
 if(words[2]){if(values.target!==undefined)throw new Fault('INVALID_INPUT','Target was supplied twice',400);values.target=words[2];}
 if(name==='canvas.move'&&(words[2]!==undefined||flags.x!==undefined||flags.y!==undefined)){
  if(values.positions!==undefined)throw new Fault('INVALID_INPUT','Supply a single TARGET with --x and --y, or batch positions through --input, not both',400);
  if(!words[2]||flags.x===undefined||flags.y===undefined)throw new Fault('INVALID_INPUT','A single canvas move requires TARGET, --x and --y',400);
  values.positions=[{id:values.target,x:Number(flags.x),y:Number(flags.y)}];delete values.target;
 }
 const globals=new Set(['config','input','requestId','wait','timeout','follow','output','contractVersion','textStdin','systemPromptFile','json','details']);
 for(const [key,value] of Object.entries(flags)){if(globals.has(key)||(name==='canvas.move'&&(key==='x'||key==='y')))continue;if(!fields.properties?.[key])throw new Fault('INVALID_INPUT',`Unsupported flag --${key.replace(/[A-Z]/g,c=>`-${c.toLowerCase()}`)}; see harnessctl ${name.replace('.',' ')} --help`,400);if(values[key]!==undefined)throw new Fault('INVALID_INPUT',`Input and flags both supply ${key}`,400);const property=fields.properties[key]!;values[key]=property.type==='boolean'?(value===true?true:value==='true'?true:value==='false'?false:(()=>{throw new Fault('INVALID_INPUT',`${key} requires true or false`,400);})()):property.type==='integer'||property.type==='number'?Number(value):key==='expectRevision'&&value==='none'?null:value;}
 if(name==='worker.send'&&Array.isArray(values.content))values.content=values.content.map(part=>part&&typeof part==='object'&&part.type==='image'&&typeof part.path==='string'?{...part,path:resolve(part.path)}:part);
 if(name==='capability.register'&&typeof values.repository==='string'&&values.repository.length)values.repository=resolve(values.repository);
 let request:Request;
 try{request=Request.parse({version:flags.contractVersion===undefined?1:Number(flags.contractVersion),requestId:flags.requestId??(name==='worker.send'?randomUUID():undefined),command:parseCommand(name,values)});}
 catch(error){if(error instanceof z.ZodError)throw invalidInvocation(error,{...values,requestId:flags.requestId,version:flags.contractVersion},name,Object.keys(fields.properties??{}));throw error;}
 if(flags.details&&(name==='canvas.move'||(!commands[name].mutation&&name!=='operation.get')))throw new Fault('INVALID_INPUT','--details applies to mutation receipts and operation get; use --help --details for command guidance',400);
 if(flags.follow&&(name!=='worker.get'||flags.wait))throw new Fault('INVALID_INPUT','--follow applies to worker get and cannot combine with --wait',400);
 if(flags.wait&&(name==='canvas.move'||(!commands[name].mutation&&name!=='operation.get')))throw new Fault('INVALID_INPUT','--wait requires a mutation receipt or operation get',400);
 if(flags.output&&name!=='worker.evidence'&&name!=='binding.create'&&name!=='canvas.snapshot')throw new Fault('INVALID_INPUT','--output is reserved for retained evidence, canvas snapshots or connection credentials',400);
 if((name==='worker.evidence'||name==='binding.create')&&!flags.output)throw new Fault('INVALID_INPUT','This command requires --output FILE; secret/binary bytes never go to ordinary stdout',400);
 return {name,values,request};
}
/** A short-lived bounded client. It owns parsing and output, never domain recovery or target identity. */
export async function run(args:string[]):Promise<number>{
 if(args.length===1&&args[0]==='--version'){await output({executable:'harnessctl',version:'1.0.0',contracts:[1]});return 0;}
 const {words,flags}=parseArguments(args);
 if(flags.help||!words.length||words[0]==='help'){await output(helpOutput(words,flags),undefined,'text');return 0;}
 const name=words.length>=2?`${words[0]}.${words[1]}` as CommandName:undefined;
 if(!name||!Object.hasOwn(commands,name)||words.length>3)unknownCommand(words[0]);
 if(flags.textStdin&&(name!=='worker.send'||flags.text!==undefined||flags.input==='-'))throw new Fault('INVALID_INPUT','--text-stdin is for worker send and cannot combine with --text or --input -',400);
 const config=await loadConfig(typeof flags.config==='string'?resolve(flags.config):process.env.HARNESSCTL_CONFIG);
 let source:Record<string,unknown>=flags.input?z.record(z.string(),z.unknown()).parse(parseJsonInput(await input(String(flags.input),config.maxBodyBytes,config.filePageBytes))):{};
 if(flags.textStdin){if(source.text!==undefined)throw new Fault('INVALID_INPUT','Input and --text-stdin both supply text',400);source.text=await input('-',config.maxBodyBytes,config.filePageBytes);}
 if(flags.systemPromptFile!==undefined){
  if(name!=='worker.create'||source.systemPrompt!==undefined)throw new Fault('INVALID_INPUT','--system-prompt-file applies only to worker create and cannot combine with systemPrompt',400);
  const sourcePath=resolve(String(flags.systemPromptFile));
  source.systemPrompt={sourcePath,text:await input(sourcePath,config.maxWorkerPromptBytes,config.filePageBytes)};
 }
 const {values,request}=parseInvocation(words,flags,source);
 const timeout=flags.timeout?duration(String(flags.timeout)):config.cliWaitMs;
 if(timeout<=0||timeout>config.cliMaxWaitMs)throw new Fault('INVALID_INPUT','Deadline exceeds configured wait bound',400);
 const present=(value:unknown)=>{const envelope=Result.parse(value),receipt=Receipt.safeParse(envelope.data);return !flags.details&&receipt.success?{...envelope,data:compactReceipt(receipt.data)}:envelope;};
 if(name.startsWith('daemon.')||(request.command.kind==='operation.get'&&request.command.input.target.startsWith('daemon:'))){const {runLifecycle}=await import('./lifecycle.ts');return runLifecycle(request,config,value=>output(present(value),timeout));}
 const worker=process.env.DSH_HARNESSCTL_TOKEN??process.env.HARNESSCTL_TOKEN;
 if(process.env.DSH_SHELL&&!worker)throw new Fault('AUTH_REQUIRED','Worker shell has no provisioned application credential; explicitly resume its worker',401);
 const call=async(req:Request):Promise<unknown>=>{
  const env=environmentCommand(req.command.kind)||(req.command.kind==='operation.get'&&req.command.input.target.startsWith('environment:'));
  if(env&&!worker){const rack=new EnvironmentClient(await loadRackConfig(config.environmentConfig));return rack.call('/v1/cli',{request:req,actor:owner});}
  const token=worker??z.object({token:z.string()}).parse(JSON.parse(await readFile(join(config.stateRoot,'application-admin.json'),'utf8'))).token;
  return socketRequest(applicationSocket(config.stateRoot),token,'/v1/execute',req,config.requestTimeoutMs,config.cliMaxStreamBytes);
 };
 // Make the recovery identity observable before any possible dispatch. A separate client
 // journal would duplicate owner state; stderr also survives a killed stdout observer.
 if(name==='worker.send'){
  const reference=`main:worker:${request.requestId}`;
  await new Promise<void>((accept,reject)=>{
   const timer=setTimeout(()=>failed(new Fault('OBSERVER_TIMEOUT','Recovery identity could not be written before dispatch')),timeout);
   const failed=(error:Error)=>{clearTimeout(timer);process.stderr.off('error',failed);reject(error);};
   process.stderr.once('error',failed);
   process.stderr.write(JSON.stringify({version:1,kind:'recovery',requestId:request.requestId,operation:reference,action:`harnessctl operation get ${reference}`})+'\n',error=>{if(error)failed(error);else {clearTimeout(timer);process.stderr.off('error',failed);accept();}});
  });
 }
 let result:Record<string,unknown>;try{result=parseResult(name==='environment.publish'&&request.command.kind==='environment.publish'&&request.command.input.preview?'environment.preview':name,await call(request)) as Record<string,unknown>;}catch(error){if(isMutation(request.command)&&(error instanceof z.ZodError||error instanceof SyntaxError||(error instanceof Error&&'code' in error&&['ADMIN_TIMEOUT','ECONNRESET','EPIPE','RESPONSE_LIMIT','OUTPUT_LIMIT'].includes(String(error.code))))){if(name==='canvas.move'){await output({version:1,error:{code:'CANVAS_UNCERTAIN',message:'Transport ended before the browser move outcome was observed',action:`Inspect harnessctl canvas get --project ${values.project} --canvas ${values.canvas}; retain the original request ID and input`}});return 7;}const reference=`${environmentCommand(name)?'environment':name.startsWith('worker.')?'main:worker':'main:research'}:${request.requestId}`;await output({version:1,error:{code:'EXECUTION_UNCERTAIN',message:'Transport ended before the owner outcome was observed',operation:reference,action:`harnessctl operation get ${reference}`}});return 7;}throw error;}
 if(flags.follow){
  const started=Date.now();let sequence=0,total=0;
  while(true){const token=worker??z.object({token:z.string()}).parse(JSON.parse(await readFile(join(config.stateRoot,'application-admin.json'),'utf8'))).token;
   const snapshot=await socketRequest(applicationSocket(config.stateRoot),token,'/v1/observe',{worker:values.target},config.requestTimeoutMs,config.maxFrameBytes);
   const record=FollowRecord.parse({version:1,kind:'snapshot',sequence:sequence++,data:snapshot});total+=Buffer.byteLength(JSON.stringify(record));if(total>config.cliMaxStreamBytes||sequence>config.maxObservationEvents)throw new Fault('STREAM_LIMIT','Follow observation reached its configured bound; reopen for a fresh snapshot');await output(record,Math.max(1,timeout-(Date.now()-started)));
   if(Date.now()-started>=timeout){await output({version:1,kind:'end',reason:'deadline',workCancelled:false},config.cliPollMs);return 0;}
   await new Promise(r=>setTimeout(r,Math.min(config.cliPollMs,timeout-(Date.now()-started))));
  }
 }
 if(flags.wait){
  const ref=typeof result.reference==='string'?result.reference:undefined;
  if(!ref)throw new Fault('INVALID_INPUT','Result has no owner command receipt',400);
  const started=Date.now();while(['accepted','running','waiting'].includes(String(result.state))){if(Date.now()-started>=timeout){await output(present({version:1,data:result,error:{code:'WAIT_TIMEOUT',message:'Observation deadline elapsed; underlying work was not cancelled',action:`harnessctl operation get ${ref}`}}));return 8;}await new Promise(r=>setTimeout(r,config.cliPollMs));result=parseResult('operation.get',await call(Request.parse({version:1,command:{kind:'operation.get',input:{target:ref}}}))) as Record<string,unknown>;}
 }
 if(name==='capability.preview'&&Array.isArray(result.errors)&&result.errors.length){await output({version:1,data:result});return 2;}
 if(flags.output&&exitCode(result)===0){
  const path=resolve(String(flags.output));
  try{const png=name==='canvas.snapshot'?await snapshotBytes(CanvasSnapshotFile.parse(result),config):undefined;const file=await open(path,'wx',0o600);try{if(png)await file.writeFile(png);else if(name==='worker.evidence')await file.writeFile(Buffer.from(String(result.data),'base64'));else await file.writeFile(JSON.stringify(result.connection)+'\n');await file.sync();}finally{await file.close();}}
  catch{const {connection:privateConnection,data:privateBytes,...retained}=result;await output(present({version:1,data:retained,error:{code:'OUTPUT_FAILED',message:name==='canvas.snapshot'?'The temporary PNG could not be exported; inspect its returned path and expiry or capture again to an available destination':'The owner result is retained, but the private output file could not be created or written',...(typeof result.reference==='string'?{operation:result.reference}:{}),action:name==='canvas.snapshot'?'Inspect the temporary output path and expiry; capture again with an available --output destination if needed':'Inspect the retained result; repeat the identical request with an available --output path'}}),timeout);return 6;}
  delete result.connection;delete result.data;result={...result,output:path,...(name==='canvas.snapshot'?{expiresAt:null}:{})};
 }
 await output(present({version:1,data:result}),timeout);return exitCode(result);
}
export async function main(args=process.argv.slice(2)){
 try{process.exitCode=await run(args);}
 catch(error){
  const info=error instanceof z.ZodError?{code:'INVALID_INPUT',message:'Input does not match the command schema; inspect command --help or --help --schema --json'}:faultInfo(error);
  let canvasCommand:string|undefined;
  // Shared error codes (such as request identity conflicts) still belong to the
  // selected command's owner; a canvas edit never acquires a research receipt.
  try{const {words}=parseArguments(args);if(words[0]==='canvas')canvasCommand=words[1];}catch{/* The original lexical error already supplies invocation guidance. */}
  const action=info.code==='INVALID_INPUT'||info.code==='USAGE'?'Correct the invocation using the indicated command help'
   :canvasCommand==='finish'?'Resolve the reported cleanup condition and repeat canvas finish for this project; no browser is required'
   :canvasCommand||info.code.startsWith('CANVAS_')?'Inspect canvas get for the same connected browser; resolve the reported condition and reconsider stale edits before another move'
   :'After possible dispatch, inspect the owner receipt before retrying';
  try{await output({version:1,error:{...info,action}});}catch{}
  process.exitCode=exitCode(info);if(observerClosed)process.exit(process.exitCode);
 }
}
