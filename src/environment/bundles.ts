import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {chmod,mkdir,readFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import * as yauzl from 'yauzl';
import {z} from 'zod';
import {RackFault,type RackConfig} from './contracts.ts';

const ConfigValue=z.union([z.string(),z.array(z.string())]);
const Manifest=z.object({manifest_version:z.literal('0.3'),name:z.string().min(1),version:z.string().min(1),server:z.object({type:z.enum(['node','python','binary']),entry_point:z.string().min(1),mcp_config:z.object({command:z.string(),args:z.array(z.string()).default([]),env:z.record(z.string(),z.string()).default({})}).optional()}),compatibility:z.object({platforms:z.array(z.string()).optional(),runtimes:z.record(z.string(),z.string()).optional()}).optional(),user_config:z.record(z.string(),z.object({type:z.enum(['string','directory','file']),multiple:z.boolean().optional(),required:z.boolean().optional(),sensitive:z.boolean().optional(),default:ConfigValue.optional()})).default({})});
export type BundlePlan={name:string,version:string,runtime:'node'|'python'|'binary',entry:string,args:string[],env:Record<string,string>,constraint:string|undefined};

/** Downloads and expands one digest-pinned bundle. ZIP paths, links, entry counts and
 * actual inflated bytes are checked before publication; no manifest command is executed. */
export async function prepareBundle(input:{url:string,sha256:string,configuration:Record<string,string|string[]>},directory:string,config:RackConfig,signal:AbortSignal):Promise<BundlePlan>{
  let url=input.url,response:Response|undefined;
  // Release hosts redirect to signed object storage. Resolve only credential-free HTTPS
  // redirects, under the same byte/deadline budget, without passing headers or authority.
  for(let redirects=0;redirects<=config.maxPackageRedirects;redirects++){
    response=await fetch(url,{signal,redirect:'manual'});if(response.status<300||response.status>=400)break;
    const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===config.maxPackageRedirects)throw new RackFault('BUNDLE_DOWNLOAD','Bundle redirect chain exceeds its declared budget');
    const next=new URL(location,url);if(next.protocol!=='https:'||next.username||next.password||next.hash)throw new RackFault('BUNDLE_DOWNLOAD','Bundle redirect must use credential-free HTTPS');url=next.href;
  }
  if(!response?.ok||!response.body)throw new RackFault('BUNDLE_DOWNLOAD',`Bundle download failed with HTTP ${response?.status}`);
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>config.maxPackageBytes)throw new RackFault('PACKAGE_LIMIT','Bundle download exceeds its byte budget');chunks.push(Buffer.from(chunk));}
  const archive=Buffer.concat(chunks);if(createHash('sha256').update(archive).digest('hex')!==input.sha256)throw new RackFault('BUNDLE_INTEGRITY','Bundle bytes do not match the selected SHA-256');
  await mkdir(directory,{recursive:true,mode:0o700});
  await new Promise<void>((complete,reject)=>{
    yauzl.fromBuffer(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
      if(error||!zip){reject(new RackFault('BUNDLE_ARCHIVE','Bundle is not a valid ZIP archive'));return;}
      let count=0,total=0,settled=false;const seen=new Set<string>();
      const fail=(cause:unknown)=>{if(settled)return;settled=true;zip.close();signal.removeEventListener('abort',abort);reject(cause);};
      const abort=()=>fail(new RackFault('PACKAGE_CANCELLED','Bundle preparation was cancelled'));signal.addEventListener('abort',abort,{once:true});
      zip.on('error',()=>fail(new RackFault('BUNDLE_ARCHIVE','Bundle ZIP data is invalid')));
      zip.on('end',()=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);complete();});
      zip.on('entry',(entry:yauzl.Entry)=>{void(async()=>{
        if(signal.aborted){abort();return;}
        const name=entry.fileName,path=resolve(directory,name),mode=(entry.externalFileAttributes>>>16)&0xffff,type=mode&0o170000,directoryEntry=name.endsWith('/');
        if(++count>config.maxPackageEntries||entry.uncompressedSize>config.maxPackageBytes-total)throw new RackFault('PACKAGE_LIMIT','Bundle expansion exceeds its configured budget');
        if(!name||isAbsolute(name)||name.includes('\\')||name.includes('\0')||name.split('/').some(part=>part==='..'||part==='.'||part==='.git')||!path.startsWith(resolve(directory)+sep)||seen.has(path)||entry.isEncrypted()||type!==0&&type!==(directoryEntry?0o040000:0o100000))throw new RackFault('BUNDLE_PATH','Bundle contains an unsafe path, duplicate, link or special file');
        seen.add(path);await mkdir(directoryEntry?path:dirname(path),{recursive:true,mode:0o700});
        if(!directoryEntry){
          const stream=await new Promise<import('node:stream').Readable>((accept,decline)=>zip.openReadStream(entry,(error,stream)=>error||!stream?decline(error):accept(stream)));
          const budget=new Transform({transform(chunk:Buffer,_encoding,callback){total+=chunk.length;if(total>config.maxPackageBytes)callback(new RackFault('PACKAGE_LIMIT','Bundle expansion exceeds its byte budget'));else callback(null,chunk);}});
          await pipeline(stream,budget,createWriteStream(path,{flags:'wx',mode:mode&0o111?0o700:0o600}),{signal});
        }
        zip.readEntry();
      })().catch(fail);});
      if(signal.aborted)abort();else zip.readEntry();
    });
  });
  const metadata=await readFile(join(directory,'manifest.json'));if(metadata.length>config.maxBodyBytes)throw new RackFault('BUNDLE_MANIFEST','Bundle manifest exceeds its metadata budget');
  const parsed=Manifest.safeParse(JSON.parse(metadata.toString('utf8')));if(!parsed.success)throw new RackFault('BUNDLE_MANIFEST','Supported bundles require manifest 0.3 and a bundled Node, Python or native entry point');
  const manifest=parsed.data;if(manifest.compatibility?.platforms&&!manifest.compatibility.platforms.includes(process.platform))throw new RackFault('BUNDLE_PLATFORM','Bundle does not support this host platform');
  const entry=resolve(directory,manifest.server.entry_point);if(!entry.startsWith(resolve(directory)+sep)||isAbsolute(manifest.server.entry_point)||manifest.server.entry_point.includes('\\'))throw new RackFault('BUNDLE_PATH','Bundle entry point must belong to the verified bundle');
  const values:Record<string,string|string[]>={};
  for(const name of Object.keys(input.configuration))if(!(name in manifest.user_config))throw new RackFault('BUNDLE_CONFIGURATION',`Bundle does not declare configuration ${name}`);
  for(const [name,field] of Object.entries(manifest.user_config)){
    const value=input.configuration[name]??field.default;
    if(field.sensitive)throw new RackFault('BUNDLE_CREDENTIAL','Sensitive bundle configuration must use a separately supported credential binding');
    if(value===undefined){if(field.required)throw new RackFault('BUNDLE_CONFIGURATION',`Bundle requires configuration ${name}`);continue;}
    if(Boolean(field.multiple)!==Array.isArray(value)||[value].flat().some(item=>item.includes('\0')||/[$`]/.test(item.replace(/\$\{(?:POLARITON_WORKSPACE|POLARITON_RUNTIME|POLARITON_DATA)\}/g,''))))throw new RackFault('BUNDLE_CONFIGURATION',`Bundle configuration ${name} has an unsupported value`);
    values[name]=value;
  }
  const substitute=(value:string):string|string[]=>{
    const single=/^\$\{user_config\.([^}]+)\}$/.exec(value);if(single){const found=values[single[1]!];if(found===undefined)throw new RackFault('BUNDLE_CONFIGURATION',`Bundle configuration ${single[1]} is unresolved`);return found;}
    const expanded=value.replaceAll('${__dirname}',directory);if(/\$\{(?!POLARITON_WORKSPACE\}|POLARITON_RUNTIME\}|POLARITON_DATA\})/.test(expanded)||expanded.includes('\0'))throw new RackFault('BUNDLE_CONFIGURATION','Bundle uses an unsupported or unresolved template');return expanded;
  };
  const launch=manifest.server.mcp_config;
  if(launch&&launch.command!==(manifest.server.type==='binary'?'${__dirname}/'+manifest.server.entry_point:manifest.server.type)&&!(manifest.server.type==='python'&&launch.command==='python3'))throw new RackFault('BUNDLE_LAUNCH','Bundle command must directly name its declared runtime or verified binary');
  const args=launch?launch.args.flatMap(substitute):manifest.server.type==='binary'?[]:[entry];
  if(manifest.server.type!=='binary'&&(args[0]!==entry||args[0].startsWith('-')))throw new RackFault('BUNDLE_LAUNCH','Bundle runtime must execute its declared entry point directly');
  const env:Record<string,string>={};for(const [name,value] of Object.entries(launch?.env??{})){const expanded=substitute(value);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||Array.isArray(expanded)||/token|secret|password|credential|api.?key/i.test(name))throw new RackFault('BUNDLE_CREDENTIAL','Bundle environment requires a supported nonsecret string binding');env[name]=expanded;}
  if(manifest.server.type==='binary')await chmod(entry,0o700);
  return {name:manifest.name,version:manifest.version,runtime:manifest.server.type,entry,args,env,constraint:manifest.compatibility?.runtimes?.[manifest.server.type]};
}
