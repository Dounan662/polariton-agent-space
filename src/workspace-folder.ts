import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute} from 'node:path';
import {Fault} from './contracts.ts';

const execute=promisify(execFile);
type Host={platform:string;env:NodeJS.ProcessEnv;run:(command:string,args:string[],options:{signal:AbortSignal;maxBuffer:number})=>Promise<unknown>};

/** Opens authoritative workspace paths on Main's desktop. One bounded launch at a
 * time prevents repeated clicks from accumulating processes; close cancels launch. */
export class WorkspaceFolder {
 private active:AbortController|undefined;
 private closed=false;
 private limits:{timeoutMs:number;maxOutputBytes:number};
 private host:Host;
 constructor(limits:{timeoutMs:number;maxOutputBytes:number},host:Host={platform:process.platform,env:process.env,run:execute}){this.limits=limits;this.host=host;}
 async open(path:string,signal:AbortSignal):Promise<void>{
  if(this.closed)throw new Fault('SHUTTING_DOWN','Main is shutting down',503);
  if(this.active)throw new Fault('FOLDER_BUSY','A workspace folder is already opening',409);
  if(!isAbsolute(path))throw new Fault('FOLDER_PATH','Workspace folder must be an absolute path',400);
  const {platform,env}=this.host;
  if(platform!=='darwin'&&platform!=='linux')throw new Fault('FOLDER_UNAVAILABLE','Opening workspace folders is supported on macOS and Linux.',503);
  if(platform==='linux'&&!env.DISPLAY&&!env.WAYLAND_DISPLAY)throw new Fault('FOLDER_UNAVAILABLE','The Polariton host has no graphical desktop. Open the workspace on that host.',503);
  const controller=new AbortController();this.active=controller;
  const abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const timer=setTimeout(()=>controller.abort(new Fault('FOLDER_TIMEOUT','Opening the workspace folder timed out',408)),this.limits.timeoutMs);
  try{
   controller.signal.throwIfAborted();
   await this.host.run(platform==='darwin'?'/usr/bin/open':'xdg-open',[path],{signal:controller.signal,maxBuffer:this.limits.maxOutputBytes});
   controller.signal.throwIfAborted();
  }catch(error){
   if(controller.signal.aborted)throw controller.signal.reason;
   const missing=(error as NodeJS.ErrnoException)?.code==='ENOENT';
   const fault=new Fault('FOLDER_FAILED',missing&&platform==='linux'
    ?'The system file manager could not be started. Install xdg-utils on the Polariton host and try again.'
    :'The workspace folder could not be opened. Check that the folder exists and the desktop file manager is available, then try again.',503);
   fault.cause=error;throw fault;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);this.active=undefined;}
 }
 close(){this.closed=true;this.active?.abort(new Fault('SHUTTING_DOWN','Main is shutting down',503));}
}
