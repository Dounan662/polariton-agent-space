import { createServer } from 'node:http';
import { mkdir, readFile, chmod, lstat, unlink } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { durable } from './environment/storage.ts';
import { socketRequest } from './environment/daemon.ts';

export function controlSocket(stateRoot:string){return `/tmp/polariton-main-${createHash('sha256').update(stateRoot).digest('hex').slice(0,24)}.sock`;}
/** Private process control is independent of browser login and domain operations. */
export async function serveControl(stateRoot:string,status:()=>unknown,stop:()=>Promise<void>){
  const path=controlSocket(stateRoot);await mkdir(stateRoot,{recursive:true,mode:0o700});
  try{const stat=await lstat(path);if(!stat.isSocket()||stat.uid!==process.getuid?.())throw new Error('Control socket path is occupied');await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const token=randomBytes(32).toString('base64url');await durable(join(stateRoot,'control.json'),{token});
  const server=createServer((req,res)=>{
    const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);
    if(req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401);res.end();return;}
    res.setHeader('content-type','application/json');
    if(req.method==='GET'&&req.url==='/status')res.end(JSON.stringify(status()));
    else if(req.method==='POST'&&req.url==='/stop'){res.end(JSON.stringify({stopping:true}));setImmediate(()=>void stop().catch(error=>console.error(error)));}
    else {res.writeHead(404);res.end('{}');}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});await chmod(path,0o600);
  return ()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
export async function mainControl<T>(stateRoot:string,path:string,timeout:number,maxBytes:number){const {token}=JSON.parse(await readFile(join(stateRoot,'control.json'),'utf8')) as {token:string};return socketRequest<T>(controlSocket(stateRoot),token,path,path==='/stop'?{}:undefined,timeout,maxBytes);}
