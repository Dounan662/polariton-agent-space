import {constants} from 'node:fs';
import {access,open,realpath,readdir,stat} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {RackFault,type RackConfig,type FileIdentity} from './contracts.ts';
import type {z} from 'zod';

export type ToolName=keyof RackConfig['packageTools'];
export type ToolCandidates=Partial<Record<ToolName,string>>;

/** Discover ordinary user toolchains without importing shell startup files or changing PATH.
 * Explicit configuration and per-operation candidates take precedence over these defaults. */
export async function toolDirectories(config:RackConfig):Promise<string[]>{
  const home=homedir(),directories=[...config.executablePaths,dirname(process.execPath),join(home,'.local','bin'),join(home,'.cargo','bin'),join(home,'.dotnet'),'/opt/homebrew/bin','/usr/local/share/dotnet'];
  const nvm=join(home,'.nvm','versions','node');
  try{const versions=await readdir(nvm);if(versions.length>config.maxPackageEntries)throw new RackFault('PACKAGE_LIMIT','Toolchain discovery exceeds the configured directory limit');directories.push(...versions.filter(value=>/^v\d+\.\d+\.\d+$/.test(value)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(value=>join(nvm,value,'bin')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return [...new Set(directories)];
}

/** A readable executable identity is a host observation, not a claim that its installation
 * is immutable. Resolve uses the retained bytes to reject relevant runtime drift. */
export async function fileIdentity(path:string,limit:number):Promise<z.infer<typeof FileIdentity>>{
  const canonical=await realpath(path),file=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await file.stat();if(!before.isFile()||before.size>limit)throw new RackFault('PACKAGE_IDENTITY','Tool identity must be a bounded regular file');
    const hash=createHash('sha256');let size=0;for await(const chunk of file.createReadStream({autoClose:false})){size+=chunk.length;if(size>limit)throw new RackFault('PACKAGE_LIMIT','Tool identity exceeds its byte budget');hash.update(chunk);}
    const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new RackFault('PACKAGE_DRIFT','Tool bytes changed during identity inspection');
    return {path,realpath:canonical,sha256:hash.digest('hex')};
  }finally{await file.close();}
}

/** Candidates confer no extra authority. The same canonical-path, executable and bounded
 * identity checks apply to configured, discovered and worker-proposed installations. */
export async function packageTool(config:RackConfig,name:ToolName,candidates:ToolCandidates={}):Promise<string>{
  const explicit=candidates[name]??config.packageTools[name],names=name==='python'?['python3','python']:[name];
  let directories=await toolDirectories(config);
  if(name==='python'&&!explicit){
    const root=join(homedir(),'.local','share','uv','python');let versions:string[]=[];
    try{versions=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(versions.length>config.maxPackageEntries)throw new RackFault('PACKAGE_LIMIT','Python discovery exceeds the configured directory limit');
    const managed=versions.filter(value=>/^cpython-\d+\.\d+\.\d+-/.test(value)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).map(value=>join(root,value,'bin'));
    const system=new Set(['/usr/bin','/bin']);directories=[...directories.filter(value=>!system.has(value)),...managed,...directories.filter(value=>system.has(value))];
  }
  const paths=explicit?[explicit]:directories.flatMap(directory=>names.map(value=>join(directory,value)));
  for(const path of paths){
    try{if(!isAbsolute(path)||path.includes('\0'))continue;const canonical=await realpath(path);await access(canonical,constants.X_OK);if(!(await stat(canonical)).isFile())continue;await fileIdentity(canonical,config.maxIdentityBytes);return basename(canonical)==='rustup'&&(name==='cargo'||name==='rustc')?resolve(path):canonical;}
    catch(error){if(error instanceof RackFault)throw error;}
  }
  throw new RackFault('PACKAGE_TOOL_MISSING',`Preparation requires ${name}; install it in a standard toolchain location or continue with an absolute ${name} candidate`,400);
}
