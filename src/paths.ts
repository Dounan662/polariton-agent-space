import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';

/** Stable per-user locations independent of the checkout and release. Development
 * has a separate namespace; an explicit data root also isolates control sockets.
 * No directories are created here. Configuration files may override individual
 * locations, while relative XDG values are ignored as required by the XDG spec. */
export function applicationPaths(options:{env?:NodeJS.ProcessEnv;home?:string;platform?:NodeJS.Platform;uid?:number}={}) {
  const env=options.env??process.env,home=options.home??homedir(),platform=options.platform??process.platform;
  const uid=options.uid??process.getuid?.();
  if(platform!=='darwin'&&platform!=='linux')throw new Error('Polariton storage supports macOS and Linux');
  if(uid===undefined||!isAbsolute(home))throw new Error('Polariton requires an absolute home and a POSIX user account');
  const profile=env.POLARITON_PROFILE||'production';
  if(profile!=='production'&&profile!=='development')throw new Error('POLARITON_PROFILE must be production or development');
  const suffix=profile==='development'?'-dev':'',name='polariton'+suffix;
  const xdg=(key:string,fallback:string)=>env[key]&&isAbsolute(env[key]!)?resolve(env[key]!):fallback;
  const support=join(home,'Library','Application Support','Polariton'+suffix);
  const dataBase=xdg('XDG_DATA_HOME',join(home,'.local/share'));
  const override=env.POLARITON_DATA_DIR;
  if(override&&!isAbsolute(override))throw new Error('POLARITON_DATA_DIR must be an absolute directory');
  const data=override?resolve(override):platform==='darwin'?join(support,'data'):join(dataBase,name,'data');
  // Keep Unix socket addresses short even when the data path is long. A root
  // override must never contact a daemon serving a different data directory.
  const instance=createHash('sha256').update(data).digest('hex').slice(0,16);
  const runtime=platform==='linux'&&env.XDG_RUNTIME_DIR&&isAbsolute(env.XDG_RUNTIME_DIR)
    ?join(env.XDG_RUNTIME_DIR,name,instance):join('/tmp',`${name}-${uid}`,instance);
  return {
    data,
    config:platform==='darwin'?join(support,'config'):join(xdg('XDG_CONFIG_HOME',join(home,'.config')),name),
    cache:platform==='darwin'?join(home,'Library/Caches','Polariton'+suffix):join(xdg('XDG_CACHE_HOME',join(home,'.cache')),name),
    state:platform==='darwin'?join(support,'state'):join(xdg('XDG_STATE_HOME',join(home,'.local/state')),name),
    releases:platform==='darwin'?join(support,'releases'):join(dataBase,name,'releases'),
    runtime,
  };
}

/** A changed default must not make retained research appear to disappear. Before
 * using a default, require an explicit storage choice if the old location exists.
 * Never import, merge, rewrite paths, or remove existing state during startup. */
export async function checkLegacyStorage(directory:string):Promise<void>{
  try{await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  throw new Error(`Existing Polariton data preserved at ${directory}. Set stateRoot explicitly in your configuration to keep using it, or select a fresh POLARITON_DATA_DIR. See docs/STORAGE.md before relocating data.`);
}
