import { execFile } from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAbsolute,join,delimiter } from 'node:path';
import { z } from 'zod';
import { Fault } from './contracts.ts';

const execute = promisify(execFile);
const Selection = z.object({path:z.string().min(1).nullable()}).strict();
type Picker = (signal:AbortSignal) => Promise<string | null>;
export type PickerAvailability={available:true}|{available:false;reason:string};
type PickerHost={platform:string;env:NodeJS.ProcessEnv;executable:(path:string)=>Promise<boolean>};
const host:PickerHost={platform:process.platform,env:process.env,executable:async path=>{try{await access(path,constants.X_OK);return true;}catch{return false;}}};

/** The dialog belongs to Main's host. Headless users retain manual/server-side
 * directory selection; probing availability never starts a graphical program. */
export async function nativePickerAvailability(io:PickerHost=host):Promise<PickerAvailability>{
  if(io.platform==='darwin')return {available:true};
  if(io.platform!=='linux')return {available:false,reason:'Native directory selection is unavailable on this host.'};
  if(!io.env.DISPLAY&&!io.env.WAYLAND_DISPLAY)return {available:false,reason:'This host has no graphical display. Enter a directory path on the Polariton host.'};
  for(const name of ['zenity','kdialog'])for(const directory of (io.env.PATH??'').split(delimiter).filter(isAbsolute)){
    if(await io.executable(join(directory,name)))return {available:true};
  }
  return {available:false,reason:'Install zenity or kdialog on the Polariton host, or enter a directory path.'};
}

/** Direct AppKit avoids the per-click AppleScript/Standard Additions startup path. */
async function nativeDirectory(signal:AbortSignal, maxOutputBytes:number):Promise<string | null> {
  if(process.platform!=='darwin'){
    const availability=await nativePickerAvailability();
    if(!availability.available)throw new Fault('PICKER_UNAVAILABLE',availability.reason,503);
    for(const [command,args] of [['zenity',['--file-selection','--directory','--title=Select Polariton project directory']],['kdialog',['--getexistingdirectory','.','--title','Select Polariton project directory']]] as const){
      let executable:string|undefined;
      for(const directory of (process.env.PATH??'').split(delimiter).filter(isAbsolute)){
        const candidate=join(directory,command);if(await host.executable(candidate)){executable=candidate;break;}
      }
      if(!executable)continue;
      try{
        const {stdout}=await execute(executable,[...args],{signal,encoding:'utf8',maxBuffer:maxOutputBytes});
        const path=stdout.trim();if(!path)return null;
        if(!isAbsolute(path))throw new Error('Folder chooser returned a nonabsolute path');
        return path;
      }catch(error){
        if(signal.aborted)throw signal.reason;
        if((error as NodeJS.ErrnoException).code==='ENOENT')continue;
        if((error as {code?:number}).code===1)return null;
        throw error;
      }
    }
    throw new Fault('PICKER_UNAVAILABLE','Native directory picker is no longer available.',503);
  }
  const helper = fileURLToPath(new URL('../dist/native/Polariton Folder Picker.app/Contents/MacOS/picker', import.meta.url));
  let stdout:string;
  try {({stdout} = await execute(helper, [], {signal,encoding:'utf8',maxBuffer:maxOutputBytes,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}}));}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Native folder picker is missing. Run npm run build before starting Polariton.');throw error;}
  const {path} = Selection.parse(JSON.parse(stdout));
  if (path !== null && !isAbsolute(path)) throw new Error('Folder chooser returned a nonabsolute path');
  return path;
}

/** Owns the single native chooser on Main's host. Cancellation, shutdown and deadlines
 * release the dialog; a second browser cannot open an overlapping chooser. */
export class DirectoryPicker {
  private active: AbortController | undefined;
  private closed = false;
  private timeoutMs: number;
  private pick: Picker;
  constructor(limits:{timeoutMs:number;maxOutputBytes:number}, pick:Picker = signal => nativeDirectory(signal, limits.maxOutputBytes)) {this.timeoutMs = limits.timeoutMs; this.pick = pick;}
  availability():Promise<PickerAvailability>{return nativePickerAvailability();}
  async choose(signal: AbortSignal): Promise<string | null> {
    if (this.closed) throw new Fault('SHUTTING_DOWN', 'Main is shutting down', 503);
    if (this.active) throw new Fault('PICKER_BUSY', 'A folder chooser is already open', 409);
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Fault('PICKER_TIMEOUT', 'Folder selection timed out', 408)), this.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const path = await this.pick(controller.signal);
      controller.signal.throwIfAborted();
      return path;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if(error instanceof Fault)throw error;
      throw new Fault('PICKER_FAILED', `Could not open the folder chooser: ${String(error)}`, 503);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.active = undefined;
    }
  }
  close() {
    this.closed = true;
    this.active?.abort(new Fault('SHUTTING_DOWN', 'Main is shutting down', 503));
  }
}
