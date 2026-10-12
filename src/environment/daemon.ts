import Fastify from 'fastify';
import {Request as CliRequest} from '../cli/contracts.ts';
import {Actor,owner} from '../caller.ts';
import {environmentOperation} from '../cli/environment-operations.ts';
import { homedir } from 'node:os';
import { readFile, mkdir, chmod, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';
import {parseJsonInput, JsonInputError} from '../json-input.ts';
import {applicationPaths,checkLegacyStorage} from '../paths.ts';
import { RackConfig, RackFault, Key, AccessRequest, AccessRelease, AccessGrant, EnvironmentChoice, PreviewInput, type EnvironmentAccess } from './contracts.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function loadRackConfig(path=join(root,'config/environment.json')):Promise<RackConfig>{
  const locations=applicationPaths();
  const document=z.record(z.string(),z.unknown()).parse(JSON.parse(await readFile(path,'utf8')));
  if(document.stateRoot===undefined&&!process.env.POLARITON_DATA_DIR&&process.env.POLARITON_PROFILE!=='development'&&resolve(path)===join(root,'config/environment.json'))await checkLegacyStorage(join(root,'.local/environment'));
  const stateRoot=typeof document.stateRoot==='string'?resolve(dirname(path),document.stateRoot):join(locations.data,'environment');
  const runtime=document.stateRoot===undefined?locations.runtime:applicationPaths({env:{...process.env,POLARITON_DATA_DIR:stateRoot}}).runtime;
  // Explicit roots identify existing/custom installations. Their omitted engine
  // fields retain RackConfig's external-runtime contract; never retarget a saved
  // Docker context merely because the source launch acquired platform defaults.
  const defaults=document.stateRoot===undefined?{dockerConfig:join(stateRoot,'docker'),
    dockerContext:process.env.POLARITON_PROFILE==='development'?'polariton-dev':'polariton',
    dockerSocket:process.platform==='darwin'?join(homedir(),'.colima/polariton/docker.sock'):'/var/run/docker.sock',
    runtime:process.platform==='darwin'?{kind:'colima',profile:'polariton'}:{kind:'external'}}:{};
  const config=RackConfig.parse({stateRoot,socketPath:join(runtime,'environment.sock'),...defaults,...document});
  return {...config,catalogSources:Object.fromEntries(Object.entries(config.catalogSources).map(([name,pathValue])=>[name,resolve(dirname(path),pathValue)])),stateRoot:resolve(dirname(path),config.stateRoot),socketPath:resolve(dirname(path),config.socketPath),credentialFile:config.credentialFile?resolve(dirname(path),config.credentialFile):undefined,executablePaths:config.executablePaths.map(value=>resolve(dirname(path),value)),dockerConfig:config.dockerConfig?resolve(dirname(path),config.dockerConfig):undefined,dockerSocket:config.dockerSocket?(config.dockerSocket.startsWith('~/')?resolve(homedir(),config.dockerSocket.slice(2)):resolve(dirname(path),config.dockerSocket)):undefined};
}
/** Same-user, authenticated control plane. Browser sessions and capability grants are separate credentials. */
export class EnvironmentClient implements EnvironmentAccess {
  readonly config:RackConfig;
  constructor(config:RackConfig){this.config=config;}
  async call<T>(path:string,body?:unknown):Promise<T>{
    const token=JSON.parse(await readFile(join(this.config.stateRoot,'admin.json'),'utf8')) as {token:string};
    return socketRequest<T>(this.config.socketPath,token.token,path,body,this.config.operationTimeoutMs,this.config.maxArtifactBytes);
  }
  async callAs<T>(path:string,body:unknown):Promise<T>{const {token}=JSON.parse(await readFile(join(this.config.stateRoot,'peer.json'),'utf8')) as {token:string};return socketRequest<T>(this.config.socketPath,token,path,body,this.config.operationTimeoutMs,this.config.maxArtifactBytes);}
  async choices(){return z.array(EnvironmentChoice).parse(await this.call('/v1/access/choices'));}
  async acquire(input:AccessRequest){return AccessGrant.parse(await this.call('/v1/access/acquire',AccessRequest.parse(input)));}
  async release(input:z.infer<typeof AccessRelease>){await this.call('/v1/access/release',AccessRelease.parse(input));}
}
export async function socketRequest<T>(socketPath:string,token:string,path:string,body:unknown,timeoutMs:number,maxBytes:number):Promise<T>{
  return new Promise((resolveResult,reject)=>{
    const req=request({socketPath,path,method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>{
      const chunks:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(new RackFault('RESPONSE_LIMIT','Administrative response exceeded budget'));}else chunks.push(chunk);});res.on('error',reject);
      res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if((res.statusCode??500)>=400)reject(new RackFault(value.error?.code??'ADMIN_FAILED',value.error?.message??'Administrative operation failed',res.statusCode));else resolveResult(value as T);}catch(error){reject(error);}});
    });
    req.setTimeout(timeoutMs,()=>req.destroy(new RackFault('ADMIN_TIMEOUT','Administrative operation timed out; inspect its receipt before retry')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
export async function createEnvironmentDaemon(config:RackConfig){
  const {EnvironmentRack}=await import('./rack.ts');
  const {durable}=await import('./storage.ts');
  await mkdir(config.stateRoot,{recursive:true,mode:0o700});
  // Installed runtime directories disappear at reboot. Recreate a private parent
  // before opening the control socket; never accept a symlink or another owner.
  const socketParent=dirname(config.socketPath);
  if(socketParent!=='/tmp'){
    await mkdir(socketParent,{recursive:true,mode:0o700});
    const directory=await lstat(socketParent);
    if(!directory.isDirectory()||directory.uid!==process.getuid?.()||(directory.mode&0o077)!==0)throw new RackFault('SOCKET_DIRECTORY','Administrative socket directory must be private and owned by the current user');
  }
  const rack=await new EnvironmentRack(config).open();
  const app=Fastify({logger:{level:'warn'},bodyLimit:config.maxBodyBytes});
  app.addHook('onClose',()=>rack.close());
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(_request,body,done)=>{try{done(null,parseJsonInput(body as string));}catch(error){done(error as Error);}});
  try{
    let token:string;try{token=(JSON.parse(await readFile(join(config.stateRoot,'admin.json'),'utf8')) as {token:string}).token;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('base64url');await durable(join(config.stateRoot,'admin.json'),{token});}
    let peer:string;try{peer=(JSON.parse(await readFile(join(config.stateRoot,'peer.json'),'utf8')) as {token:string}).token;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;peer=randomBytes(32).toString('base64url');await durable(join(config.stateRoot,'peer.json'),{token:peer});}
    app.addHook('onRequest',async req=>{const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);if((actual.length!==expected.length||(!timingSafeEqual(actual,expected)&&!timingSafeEqual(actual,Buffer.from(`Bearer ${peer}`))))||req.headers.origin)throw new RackFault('AUTH_REQUIRED','Private administrative credential required',401);});
    app.setErrorHandler((error,_request,reply)=>{if(error instanceof JsonInputError)return reply.code(400).send({error:{code:error.code,message:error.message}});if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_INPUT',message:'Administrative input does not match the supported contract'}});if(error instanceof RackFault)return reply.code(error.status).send({error:{code:error.code,message:error.message}});app.log.error({code:'RACK_FAILED'},'Administrative operation failed');return reply.code(500).send({error:{code:'RACK_FAILED',message:'Administrative operation failed; inspect retained operation status'}});});
    app.post('/v1/cli',req=>{const body=z.object({request:CliRequest,actor:Actor.default(owner)}).strict().parse(req.body);if(body.actor.kind!=='owner'&&req.headers.authorization!==`Bearer ${peer}`)throw new RackFault('ACTOR_DENIED','Worker attribution requires the authenticated Main peer',403);return environmentOperation(rack,body.request,body.actor);});
    app.get('/v1/health',()=>({ready:true,daemon:'environment',pid:process.pid,stateRoot:config.stateRoot}));
    app.get('/v1/inventory',()=>rack.inventory());
    app.post('/v1/capabilities/preview',req=>rack.preview(PreviewInput.parse(req.body)));
    app.get('/v1/capabilities/:id',req=>rack.capability(z.object({id:Key}).parse(req.params).id));
    app.get('/v1/capabilities/:id/revisions/:revision',req=>{const p=z.object({id:Key,revision:Key}).parse(req.params);return rack.capability(p.id,p.revision);});
    app.get('/v1/access/choices',()=>rack.choices());
    app.post('/v1/access/acquire',req=>rack.acquireAccess(AccessRequest.parse(req.body)));
    app.post('/v1/access/release',async req=>{await rack.releaseAccess(AccessRelease.parse(req.body));return {released:true};});
    app.get('/v1/releases/:release/provenance',req=>rack.provenance(z.object({release:Key}).parse(req.params).release));
    app.get('/v1/revisions/:environment/:revision',req=>{const p=z.object({environment:Key,revision:Key}).parse(req.params);return rack.revision(p.environment,p.revision);});
    app.post('/v1/command',req=>rack.execute(req.body));
    app.post('/v1/shutdown',(_req,reply)=>{reply.send({stopping:true});setImmediate(()=>void app.close().catch(error=>{console.error(error);process.exitCode=1;}));});
    try{const prior=await lstat(config.socketPath);if(!prior.isSocket()||prior.uid!==process.getuid?.())throw new RackFault('SOCKET_CONFLICT','Administrative socket path is occupied');
      try{await socketRequest(config.socketPath,token,'/v1/health',undefined,config.observationTimeoutMs,config.maxBodyBytes);throw new RackFault('SOCKET_OWNED','Administrative socket is already serving');}catch(error){if((error as NodeJS.ErrnoException).code!=='ECONNREFUSED'&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await unlink(config.socketPath);}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await app.listen({path:config.socketPath});await chmod(config.socketPath,0o600);return {app,rack};
  }catch(error){await app.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=await loadRackConfig(process.argv[2]);const {app}=await createEnvironmentDaemon(config);
  console.log(JSON.stringify({daemon:'environment',ready:true,socket:config.socketPath}));
  const stop=()=>void app.close().catch(error=>{console.error(error);process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
