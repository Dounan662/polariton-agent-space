import Fastify from 'fastify';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {chmod,lstat,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {Config} from '../config.ts';
import {Fault} from '../contracts.ts';
import {owner,type Actor} from '../caller.ts';
import {Request} from './contracts.ts';
import type {MainOperations} from './main-operations.ts';
import {parseJsonInput} from '../json-input.ts';
export const applicationSocket=(root:string)=>`/tmp/harnessctl-${createHash('sha256').update(root).digest('hex').slice(0,24)}.sock`;
const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
/** Credentials bind a process launch to its durable worker. Mutable shell hints never determine identity.
 * This is attribution within the trusted OS account, not isolation from that account. */
export class CallerAccess {
 private workers=new Map<string,{token:string;actor:Actor}>();private config:Config;private admin='';
 constructor(config:Config){this.config=config;}
 async initialize(){const path=join(this.config.stateRoot,'application-admin.json');try{this.admin=z.object({token:z.string().min(32)}).parse(JSON.parse(await readFile(path,'utf8'))).token;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;this.admin=randomBytes(32).toString('base64url');
  // Client-side socket discovery must not load the daemon's SQLite-backed storage.
  const {durable}=await import('../environment/storage.ts');await durable(path,{token:this.admin});}}
 issue(worker:string,processId:string):NonNullable<Config['workerCredential']>{const token=randomBytes(32).toString('base64url');this.workers.set(processId,{token,actor:{kind:'worker',id:worker,processId}});return {token,socket:applicationSocket(this.config.stateRoot),config:this.config.configPath!};}
 revoke(processId:string){this.workers.delete(processId);}
 authenticate(header:string|undefined):Actor{const token=header?.startsWith('Bearer ')?header.slice(7):'';if(this.admin&&equal(token,this.admin))return owner;for(const value of this.workers.values())if(equal(token,value.token))return value.actor;throw new Fault('AUTH_REQUIRED','Supply a valid installation or active worker credential',401);}
}
/** Private application transport shares owner operations with the browser, without accepting browser credentials. */
export async function serveApplication(config:Config,access:CallerAccess,operations:MainOperations){
 const app=Fastify({logger:{level:'warn'},bodyLimit:config.maxBodyBytes});
 app.removeContentTypeParser('application/json');app.addContentTypeParser('application/json',{parseAs:'string'},(_r,body,done)=>{try{done(null,parseJsonInput(body as string));}catch(error){done(error as Error);}});
 app.addHook('onRequest',async request=>{if(request.headers.origin)throw new Fault('ORIGIN_DENIED','Browser-origin requests are not supported on this transport',403);access.authenticate(request.headers.authorization);});
 app.setErrorHandler((error,_request,reply)=>{if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_INPUT',message:error.issues.map(i=>i.message).join('; ')}});if(error instanceof Fault)return reply.code(error.status).send({error:{code:error.code,message:error.message}});if(error instanceof Error&&'code' in error&&'status' in error)return reply.code(Number(error.status)).send({error:{code:String(error.code),message:error.message}});app.log.error({code:'APPLICATION_FAILED'},'Application request failed');return reply.code(500).send({error:{code:'APPLICATION_FAILED',message:'Application operation failed; inspect owner receipt and diagnostics'}});});
 app.get('/v1/caller',req=>access.authenticate(req.headers.authorization));
 app.post('/v1/observe',req=>operations.observe(z.object({worker:z.string().uuid()}).strict().parse(req.body).worker));
 app.post('/v1/execute',async (req,reply)=>{const cancellation=new AbortController(),abort=()=>{if(!reply.raw.writableEnded)cancellation.abort();};reply.raw.once('close',abort);try{const result=await operations.execute(Request.parse(req.body),access.authenticate(req.headers.authorization),cancellation.signal);if(Buffer.byteLength(JSON.stringify(result))>config.cliMaxStreamBytes)throw new Fault('OUTPUT_LIMIT','Result exceeds configured output limit');return result;}finally{reply.raw.off('close',abort);}});
 const socket=applicationSocket(config.stateRoot);
 try{const info=await lstat(socket);if(!info.isSocket()||info.uid!==process.getuid?.())throw new Fault('SOCKET_CONFLICT','Application socket path is occupied');await unlink(socket);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await app.listen({path:socket});await chmod(socket,0o600);return app;
}
