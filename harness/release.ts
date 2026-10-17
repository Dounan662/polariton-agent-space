import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {executionProfiles} from '../src/host-support.ts';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const Digest=z.string().regex(/^[a-f0-9]{64}$/);
const Qualification=z.object({
  adapter:z.literal('polariton-harness/1'),inspection:z.literal('polariton-source/1'),readableFormats:z.array(z.number().int().positive()).nonempty(),
  profiles:z.array(z.object({host:z.enum(executionProfiles),node:z.string(),evidence:z.array(z.string()).nonempty()}).strict()),
}).strict();
const Dependency=z.object({version:z.string(),integrity:z.string(),os:z.array(z.string()).optional(),cpu:z.array(z.string()).optional(),optional:z.boolean().optional()}).strict();
const Release=z.object({
  format:z.literal(1),version:z.string(),lockSha256:Digest,presentation:z.object({revision:z.string(),sha256:Digest}).strict(),
  dependencies:z.record(z.string(),Dependency),qualification:Qualification,
}).strict();

/** Derive provenance from owned release inputs. Qualification claims are explicit
 * reviewed evidence; package versions cannot establish behavioral compatibility.
 * Runtime, development contracts and copied presentation must select one release. */
export async function releaseInputs(directory=root){
  const [packageBytes,lockBytes,originBytes,qualificationBytes]=await Promise.all(['package.json','package-lock.json','web/src/native/ORIGIN.json','harness/qualification.json'].map(path=>readFile(join(directory,path))));
  const pkg=z.object({version:z.string(),dependencies:z.record(z.string(),z.string()),devDependencies:z.record(z.string(),z.string())}).parse(JSON.parse(packageBytes.toString()));
  const lock=z.object({packages:z.record(z.string(),z.object({version:z.string().optional(),integrity:z.string().optional(),os:z.array(z.string()).optional(),cpu:z.array(z.string()).optional(),optional:z.boolean().optional()}).passthrough())}).parse(JSON.parse(lockBytes.toString()));
  const origin=z.object({revision:z.string(),release:z.string()}).parse(JSON.parse(originBytes.toString()));
  const harnessVersion=pkg.dependencies['@deepseek-ai/dsh'];
  if(!harnessVersion||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(harnessVersion))throw new Error('DSH execution owner must have an exact release pin');
  if(origin.release!==harnessVersion)throw new Error('Presentation and runtime must select the same DSH release');
  for(const [name,version]of Object.entries({...pkg.dependencies,...pkg.devDependencies})){
    if(!/^@deepseek-ai\/dsh(?:-|$)/.test(name))continue;
    if(version!==harnessVersion||lock.packages[`node_modules/${name}`]?.version!==harnessVersion)throw new Error(`Mixed DSH release selection: ${name}`);
  }
  const dependencies:Record<string,z.infer<typeof Dependency>>={};
  for(const [path,entry]of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){
    const name=path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length);
    if(!pkg.dependencies[name]&&!name.startsWith('@deepseek-ai/')&&!name.startsWith('@modelcontextprotocol/')&&!name.startsWith('@img/'))continue;
    if(!entry.version||!entry.integrity)throw new Error(`Incomplete locked dependency provenance: ${path}`);
    if(/^@deepseek-ai\/dsh(?:-|$)/.test(name)&&entry.version!==harnessVersion)throw new Error(`Mixed DSH release selection: ${path}`);
    dependencies[path]={version:entry.version,integrity:entry.integrity,...(entry.os?{os:entry.os}:{}),...(entry.cpu?{cpu:entry.cpu}:{}),...(entry.optional?{optional:true}:{})};
  }
  if(!dependencies['node_modules/@deepseek-ai/dsh'])throw new Error('Release has no locked DSH execution owner');
  return Release.parse({format:1,version:pkg.version,lockSha256:hash(lockBytes),presentation:{revision:origin.revision,sha256:hash(originBytes)},dependencies,qualification:Qualification.parse(JSON.parse(qualificationBytes.toString()))});
}

/** Refuse a mixed runtime before any execution state is written. A build validates
 * every installed upstream package against the exact qualified lock; no global DSH
 * selection or automatic data conversion is permitted. */
export async function verifyRelease(directory=root){
  const [declared,actual]=await Promise.all([readFile(join(directory,'harness/release.json'),'utf8').then(text=>Release.parse(JSON.parse(text))),releaseInputs(directory)]);
  if(JSON.stringify(declared)!==JSON.stringify(actual))throw new Error('Harness release inputs changed: rebuild and qualify the release manifest');
  if(!declared.qualification.readableFormats.includes(SESSION_FORMAT_VERSION))throw new Error('Installed DSH session format is outside the qualified reader contract');
  const versions=new Set<string>();
  for(const [path,expected]of Object.entries(declared.dependencies)){
    const matches=(values:string[]|undefined,current:string)=>!values||(!values.includes('!'+current)&&(values.every(value=>value.startsWith('!'))||values.includes(current)));
    if(!matches(expected.os,process.platform)||!matches(expected.cpu,process.arch))continue;
    let bytes:string;
    try{bytes=await readFile(join(directory,path,'package.json'),'utf8');}
    catch(error){if(expected.optional&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const installed=z.object({version:z.string()}).parse(JSON.parse(bytes));
    if(installed.version!==expected.version)throw new Error(`Harness dependency mismatch: ${path}; run locked installation`);
    if(/\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path))versions.add(installed.version);
  }
  if(versions.size!==1)throw new Error('Mixed DSH releases are not supported');
  return declared;
}
let checked:ReturnType<typeof verifyRelease>|undefined;
/** The immutable running release is checked once; failed checks remain failures. */
export function requireRelease(){return checked??=verifyRelease();}
