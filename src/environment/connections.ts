import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { z } from 'zod';
import { Packages, packageLaunch } from './packages.ts';
import {packageTool,toolDirectories,type ToolCandidates} from './toolchains.ts';
import {CapabilitySpec,type SourceSpec,type PackageInstallation} from './preparation-contracts.ts';
import {executionHost} from '../host-support.ts';
import { json } from './storage.ts';
import { ConnectionDefinition, CredentialIdentity, ImportEntry, PreviewInput, Requirements, PackageRequest, RackFault, type RackConfig, type ImportPreview, type ConnectionRevision, type AccessGrant } from './contracts.ts';

const Fields=z.record(z.string(),z.string());
const HttpInput=z.object({type:z.literal('http').optional(),url:z.string(),headers:Fields.default({}),requirements:Requirements.default({files:[],identityFiles:[],execution:'foreground-host'})}).strict();
const StdioInput=z.object({type:z.literal('stdio').optional(),command:z.string().min(1),args:z.array(z.string()).default([]),env:Fields.default({}),requirements:Requirements.default({files:[],identityFiles:[],execution:'foreground-host'})}).strict();
const Credentials=z.object({format:z.literal(1),credentials:z.record(z.string(),CredentialIdentity.extend({value:z.string().min(1),expiresAt:z.iso.datetime().optional()}).strict())}).strict();
type Secrets=z.infer<typeof Credentials>['credentials'];
const sensitive=/authorization|cookie|password|token|secret|api.?key|credential|^key$/i;
const reference=/\$\{([A-Za-z0-9][A-Za-z0-9_.-]{0,95})\}/g;
const runner=/^(?:npx|npm|pnpm|yarn|bun|bunx|uv|uvx|deno|pip|pipx|sh|bash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i;
const workspaceReferences=new Set(['POLARITON_WORKSPACE','POLARITON_RUNTIME','POLARITON_DATA']);
const publicHeaders=/^(accept|content-type|user-agent|mcp-protocol-version)$/i;
const safe=(code:string,message:string)=>new RackFault(code,message,400);
export type DependencyObservation={observedAt:string,installation?:PackageInstallation,error?:{code:string,message:string}};

/** Definitions conceal private resolution and host identity checks. None of these operations
 * launches an MCP server or owns a session. Only explicit preparation may install packages. */
export class Connections {
  private config:RackConfig;
  private packages:Packages;
  private accountCredentials:()=>Secrets;
  private dependencyObservations=new Map<string,{expiresAt:number,result:Promise<DependencyObservation>}>();
  private inspecting=0;
  private now:()=>number;
  constructor(config:RackConfig,accountCredentials:()=>Secrets=()=>({}),now:()=>number=Date.now){this.config=config;this.accountCredentials=accountCredentials;this.packages=new Packages(config);this.now=now;}
  /** Normalize a complete source contract without installing, probing versions or launching.
   * Registry inputs never require callers to locate an incidental npx/uvx executable. */
  async source(raw:z.infer<typeof CapabilitySpec>,signal?:AbortSignal,candidates:ToolCandidates={}):Promise<{definition:ConnectionDefinition,source:SourceSpec,defaults:string[]}>{
    const input=CapabilitySpec.parse(raw),source=input.source;
    if(signal?.aborted)throw safe('PACKAGE_CANCELLED','Source normalization was cancelled');
    if(input.authentication.kind==='oauth')throw safe('AUTHENTICATION_BOUNDARY','OAuth normalization requires the Environment account owner');
    const requirements={files:input.requirements.files,identityFiles:input.requirements.identityFiles,execution:'foreground-host' as const,...input.requirements.storage?{storage:input.requirements.storage}:{}};
    if(source.kind==='endpoint'){
      if(input.runtime.kind!=='external'||input.connection.kind!=='http')throw safe('SOURCE_RUNTIME','An endpoint requires external runtime and HTTP connection');
      const preview=await this.preview({configuration:{mcpServers:{[input.name]:{url:input.connection.url??source.url,headers:input.connection.headers,requirements}}}});if(preview.errors.length)throw safe(preview.errors[0]!.code,preview.errors[0]!.message);
      return {definition:preview.entries[0]!.definition,source,defaults:[]};
    }
    if(source.kind==='installed'){
      if(input.runtime.kind!=='local'||input.connection.kind!=='stdio')throw safe('SOURCE_RUNTIME','An installed program requires local runtime and stdio');
      const preview=await this.preview({configuration:{mcpServers:{[input.name]:{command:source.command,args:input.connection.args,env:input.connection.env,requirements}}}});if(preview.errors.length)throw safe(preview.errors[0]!.code,preview.errors[0]!.message);
      if(preview.entries[0]!.definition.kind==='stdio'&&preview.entries[0]!.definition.package)throw safe('SOURCE_RUNTIME','Existing installations must identify the installed program; use a registry source for package runners');
      return {definition:preview.entries[0]!.definition,source,defaults:[]};
    }
    if(source.kind==='git'||source.kind==='oci')throw safe('SOURCE_RUNTIME','Managed sources require the Environment managed-runtime owner');
    if(input.runtime.kind!=='local'||input.connection.kind!=='stdio')throw safe('SOURCE_RUNTIME','This package adapter requires local runtime and stdio');
    this.arguments(input.connection.args);const refs=this.references(input.connection.env,'environment'),secrets=refs.length?await this.secrets():{};
    let recipe:z.infer<typeof PackageRequest>;
    if(source.kind==='mcpb')recipe={manager:'mcpb',url:source.url,sha256:source.sha256,configuration:source.configuration};
    else{
      if(!/^\d[0-9A-Za-z.+_-]*$/.test(source.version))throw safe('PACKAGE_VERSION','Select an explicit package version; mutable tags and ranges are unresolved choices');
      if(source.kind==='npm'){
        if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(source.identifier))throw safe('PACKAGE_SPECIFIER','Select a named npm registry package');
        recipe={manager:'npm',specifier:`${source.identifier}@${source.version}`,executable:source.executable??basename(source.identifier),...(input.requirements.assets.length?{assets:input.requirements.assets}:{})};
        await Promise.all([packageTool(this.config,'node',candidates),packageTool(this.config,'npm',candidates)]);
      }else if(source.kind==='pypi'){
        if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.identifier))throw safe('PACKAGE_SPECIFIER','Select a named PyPI registry package');
        recipe={manager:'uv',specifier:`${source.identifier}==${source.version}`,executable:source.executable??source.identifier};
        if(input.requirements.assets.length)throw safe('PACKAGE_RECIPE','The PyPI adapter requires wheels and does not run browser download recipes');
        await Promise.all([packageTool(this.config,'uv',candidates),packageTool(this.config,'python',candidates)]);
      }else{
        if(input.requirements.assets.length)throw safe('PACKAGE_RECIPE','This registry adapter does not implement browser asset recipes');
        recipe={manager:source.kind,identifier:source.identifier,version:source.version,...source.executable?{executable:source.executable}:{},...(source.kind==='cargo'?{nativeBuild:input.requirements.nativeBuild}:{})};
        if(source.kind==='cargo'&&!input.requirements.nativeBuild)throw safe('PACKAGE_BUILD_AUTHORITY','Cargo requires nativeBuild: true to declare build-script execution with host-user authority');
        await packageTool(this.config,source.kind==='cargo'?'cargo':'dotnet',candidates);
      }
    }
    const definition:ConnectionDefinition={kind:'stdio',command:`package:${recipe.manager}`,args:input.connection.args,env:input.connection.env,package:PackageRequest.parse(recipe),requirements,credentials:this.identities(refs,secrets),...(requirements.identityFiles.length?{identity:{platform:process.platform,arch:process.arch,files:await this.identity(requirements.identityFiles)}}:{})};
    this.validate(definition);return {definition,source,defaults:[]};
  }
  private async secrets():Promise<Secrets>{
    if(!this.config.credentialFile)return this.accountCredentials();
    let file;
    try{
      file=await open(this.config.credentialFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await file.stat();
      if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.()||info.size>this.config.maxBodyBytes)throw new Error();
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>this.config.maxBodyBytes)throw new Error();chunks.push(chunk);}
      const external=Credentials.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).credentials,managed=this.accountCredentials();
      if(Object.keys(managed).some(key=>Object.hasOwn(external,key)))throw safe('CREDENTIAL_CONFLICT','A reference is defined by both external and managed account stores');
      return {...external,...managed};
    }catch(error){if(error instanceof RackFault)throw error;throw safe('CREDENTIAL_SOURCE','Credential source must be an owner-only mode-0600 file with the documented format');}
    finally{await file?.close();}
  }
  private references(fields:Record<string,string>,kind:'header'|'environment'):string[]{
    const names=new Set<string>(),refs=new Set<string>();
    for(const [name,value] of Object.entries(fields)){
      const key=kind==='header'?name.toLowerCase():name;
      if(names.has(key))throw safe('DUPLICATE_FIELD','Duplicate header or environment name');names.add(key);
      try{if(kind==='header'){validateHeaderName(name);validateHeaderValue(name,value);}else if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||value.includes('\0'))throw new Error();}
      catch{throw safe('INVALID_FIELD','Invalid header or environment entry');}
      const matches=[...value.matchAll(reference)],workspace=matches.filter(match=>workspaceReferences.has(match[1]!));
      if(workspace.length){
        if(kind==='header'||workspace.length!==matches.length||sensitive.test(name))throw safe('WORKSPACE_REFERENCE','Workspace references are permitted only in noncredential stdio environment values');
        if(/[$`]/.test(value.replace(reference,'')))throw safe('REFERENCE_SYNTAX','Use explicit workspace templates; shell expansion is unsupported');
        continue;
      }
      if(/[$`]/.test(value.replace(reference,'')))throw safe('REFERENCE_SYNTAX','Use explicit ${REFERENCE} templates; shell expansion is unsupported');
      if(value&&((kind==='header'&&!publicHeaders.test(name))||sensitive.test(name))&&!matches.length)throw safe('CREDENTIAL_LITERAL','Credential-bearing fields require a private ${REFERENCE}; do not paste secret values');
      if(matches.length&&!(kind==='header'?/^(?:(?:Bearer|Basic) )?\$\{[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\}$/:/^\$\{[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\}$/).test(value))throw safe('CREDENTIAL_LITERAL','Use one credential reference, optionally prefixed by Bearer or Basic for a header; literal credential fragments are unsupported');
      for(const match of matches)refs.add(match[1]!);
    }
    return [...refs].sort();
  }
  private url(value:string){
    let url:URL;try{url=new URL(value);}catch{throw safe('ENDPOINT_INVALID','An absolute HTTP(S) endpoint is required');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||[...url.searchParams.keys()].some(key=>sensitive.test(key)))throw safe('ENDPOINT_INVALID','Use an HTTP(S) URL without credentials or fragments; authentication belongs in referenced headers');
    return url.href;
  }
  private arguments(args:string[],command?:string){
    if(command&&/^(node|python[0-9.]*|ruby|perl)$/.test(basename(command))&&args.length&&(!isAbsolute(args[0]!)||args[0]!.startsWith('-')))throw safe('ENTRYPOINT_PATH','Interpreters require a direct absolute local entry point; eval, module and runner flags are unsupported');
    if(args.some(value=>/^--?(?:daemon(?:ize)?|detach(?:ed)?|background)(?:=|$)/i.test(value)))throw safe('LAUNCH_DAEMON','Daemonizing launch options are unsupported; configure the installed program to remain in the foreground');
    if(args.some(value=>value.includes('\0')||/[`$]/.test(value.replace(/\$\{(?:POLARITON_WORKSPACE|POLARITON_RUNTIME|POLARITON_DATA)\}/g,''))||/(?:password|token|secret|api[-_]?key|key|authorization|credential)(?:\s|=|:)|^--(?:password|token|secret|api[-_]?key|key|authorization|credential)$|\bBearer\s/i.test(value)))throw safe('LAUNCH_ARGUMENT','Shell expansion and credential-bearing arguments are unsupported; use explicit environment references');
    for(const value of args)for(const match of value.matchAll(/https?:\/\/[^\s]+/gi))this.url(match[0]);
  }
  private async identity(paths:string[]){
    const files=[];
    let bytes=0;
    for(const path of [...new Set(paths)]){
      if(!isAbsolute(path))throw safe('IDENTITY_PATH','Identity and prerequisite files require absolute paths');
      let file;
      try{
        const canonical=await realpath(path);file=await open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const before=await file.stat();
        if(!before.isFile()||bytes+before.size>this.config.maxIdentityBytes)throw safe('IDENTITY_LIMIT','Identity files must be regular files within the configured byte budget');
        const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>this.config.maxIdentityBytes)throw safe('IDENTITY_LIMIT','Identity files exceeded the configured byte budget while being inspected');hash.update(chunk);}
        const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw safe('EXECUTABLE_DRIFT','Identity file changed while being inspected');
        files.push({path,realpath:canonical,sha256:hash.digest('hex')});
      }catch(error){if(error instanceof RackFault)throw error;throw safe('IDENTITY_MISSING','An executable or declared identity file is missing or unreadable');}
      finally{await file?.close();}
    }
    return files;
  }
  /** A preview only becomes importable after bare command resolution is confirmed. */
  async preview(raw:unknown):Promise<ImportPreview>{
    const parsed=PreviewInput.safeParse(raw);
    if(!parsed.success)throw safe('IMPORT_SHAPE','Expected {configuration:{mcpServers:{name:configuration}},resolutions:{name:absolutePath}}');
    const {configuration,resolutions}=parsed.data;
    const entries:ImportPreview['entries']=[],errors:ImportPreview['errors']=[],suggestions:Record<string,string>={};
    const items=Object.entries(configuration.mcpServers);
    if(!items.length||items.length>this.config.maxImportEntries)throw safe('IMPORT_LIMIT','Import entry count is outside the configured limit');
    for(const [name,rawEntry] of items){
      try{
        if(!name.trim()||!ImportEntry.shape.name.safeParse(name).success)throw safe('CAPABILITY_NAME','Capability names must fit the display-name limit and contain no control characters');
        let definition:ConnectionDefinition;
        const http=HttpInput.safeParse(rawEntry),stdio=StdioInput.safeParse(rawEntry);
        if(http.success){
          const refs=this.references(http.data.headers,'header'),secrets=refs.length?await this.secrets():{};
          definition={kind:'http',url:this.url(http.data.url),headers:http.data.headers,requirements:http.data.requirements,credentials:this.identities(refs,secrets)};
        }else if(stdio.success){
          const input=stdio.data,launch=packageLaunch(input.command,input.args);this.arguments(launch?.args??input.args,launch?undefined:input.command);
          if(!launch&&runner.test(basename(input.command)))throw safe('LAUNCH_RUNNER','Use an installed foreground executable or supported npx/uvx package configuration; shells and other runners are unsupported');
          let command=input.command;
          if(!isAbsolute(command)){
            if(command.includes('/')||command.includes('\\'))throw safe('EXECUTABLE_PATH','Relative executable paths are unsupported');
            let found:string|undefined;
            for(const directory of await toolDirectories(this.config)){try{const candidate=await realpath(join(directory,command));await access(candidate,constants.X_OK);if((await stat(candidate)).isFile()){found=candidate;break;}}catch{}}
            if(!found)throw safe('EXECUTABLE_MISSING','Executable was not found in configured search paths; provide an installed absolute executable');
            suggestions[name]=found;
            if(resolutions[name]!==found)throw safe('EXECUTABLE_CONFIRM','Confirm the resolved absolute executable path before importing');
            command=found;
          }
          command=await realpath(command);await access(command,constants.X_OK);
          if(!launch&&runner.test(basename(command)))throw safe('LAUNCH_RUNNER','Shells and unsupported package runners are rejected');
          if(launch&&json(packageLaunch(command,input.args)?.recipe)!==json(launch.recipe))throw safe('LAUNCH_RUNNER','Resolved package launcher identity does not match its requested manager');
          const refs=this.references(input.env,'environment'),secrets=refs.length?await this.secrets():{};
          const entry=input.args[0];
          if(/^(node|python[0-9.]*|ruby|perl)$/.test(basename(command))&&entry&&!entry.startsWith('-')&&!isAbsolute(entry))throw safe('ENTRYPOINT_PATH','Runtime entry points require an absolute path');
          const files=await this.identity([command,...(entry&&isAbsolute(entry)&&/^(node|python[0-9.]*|ruby|perl)$/.test(basename(command))?[entry]:[]),...input.requirements.identityFiles]);
          definition={kind:'stdio',command,args:input.args,...(launch?{package:launch.recipe}:{}),env:input.env,requirements:input.requirements,credentials:this.identities(refs,secrets),identity:{platform:process.platform,arch:process.arch,files}};
        }else throw safe('IMPORT_ENTRY','Entry must be supported HTTP or stdio configuration; unknown fields, cwd and other transports are rejected');
        for(const path of [...definition.requirements.files,...definition.requirements.identityFiles])if(!isAbsolute(path))throw safe('REQUIREMENT_PATH','Declared prerequisite and identity paths must be absolute');
        this.validate(definition);
        entries.push({name,definition});
      }catch(error){errors.push({name,code:error instanceof RackFault?error.code:'EXECUTABLE_MISSING',message:error instanceof RackFault?error.message:'Installed executable could not be inspected; provide a readable absolute executable'});}
    }
    return {entries,errors,resolutions:suggestions};
  }
  private identities(refs:string[],secrets:Secrets){
    return Object.fromEntries(refs.map(ref=>{const secret=secrets[ref];if(!secret)throw safe('CREDENTIAL_MISSING',`Configure credential reference ${ref} before registration`);return [ref,{account:secret.account,authority:secret.authority}];}));
  }
  /** Normalized imports are untrusted too; reject unsafe values before a receipt exists. */
  validate(definition:ConnectionDefinition){
    const refs=this.references(definition.kind==='http'?definition.headers:definition.env,definition.kind==='http'?'header':'environment');
    if(definition.kind==='stdio'&&!definition.requirements.storage&&[...definition.args,...Object.values(definition.env),...(definition.package?.manager==='mcpb'?Object.values(definition.package.configuration).flat():[])].some(value=>value.includes('${POLARITON_DATA}')))throw safe('STORAGE_UNDECLARED','POLARITON_DATA requires a declared persistent storage binding');
    if(JSON.stringify(refs)!==JSON.stringify(Object.keys(definition.credentials).sort()))throw safe('CREDENTIAL_IDENTITY','Credential references and pinned account identities must agree');
    if(definition.kind==='http'){
      this.url(definition.url);
      if(definition.account&&new URL(definition.url).href!==new URL(definition.account.resource).href)throw safe('ACCOUNT_RESOURCE','OAuth credentials can only be sent to their exact protected resource');
      if(definition.account&&Object.keys(definition.credentials).length)throw safe('AUTHENTICATION_CONFLICT','OAuth and private static credentials cannot share a connection');
    }
    else{
      if(definition.package&&definition.command===`package:${definition.package.manager}`){
        PackageRequest.parse(definition.package);this.arguments(definition.args);
        if(definition.requirements.identityFiles.length&&!definition.identity)throw safe('IDENTITY_MISSING','Declared dependency identities must be recorded');
        if(definition.identity&&json([...definition.identity.files.map(file=>file.path)].sort())!==json([...new Set(definition.requirements.identityFiles)].sort()))throw safe('PACKAGE_IDENTITY','Registry identities must name exactly their declared external dependency files');
        for(const path of [...definition.requirements.files,...definition.requirements.identityFiles])if(!isAbsolute(path))throw safe('REQUIREMENT_PATH','Declared prerequisite paths must be absolute');
        return;
      }
      const launch=packageLaunch(definition.command,definition.args);
      if(!isAbsolute(definition.command)||(!launch&&runner.test(basename(definition.command))))throw safe('LAUNCH_RUNNER','An installed absolute foreground executable or supported package launcher is required');
      if(json(launch?.recipe)!==json(definition.package))throw safe('PACKAGE_DEFINITION','Package recipe must match the original launcher and arguments');
      this.arguments(launch?.args??definition.args,launch?undefined:definition.command);
      const entry=definition.args[0],expected=[definition.command,...definition.requirements.identityFiles,...(entry&&isAbsolute(entry)&&/^(node|python[0-9.]*|ruby|perl)$/.test(basename(definition.command))?[entry]:[])];
      if(!definition.identity||expected.some(path=>!definition.identity!.files.some(file=>file.path===path)))throw safe('IDENTITY_MISSING','Executable, entry-point and all declared dependency identities must be recorded');
      if(new Set(definition.identity.files.map(file=>file.path)).size!==definition.identity.files.length)throw safe('IDENTITY_DUPLICATE','Identity file paths must be unique');
    }
    for(const path of [...definition.requirements.files,...definition.requirements.identityFiles])if(!isAbsolute(path))throw safe('REQUIREMENT_PATH','Declared prerequisite and identity paths must be absolute');
  }
  /** Explicit capability setup or environment Apply may install reusable dependencies. */
  async prepare(definition:ConnectionRevision,signal?:AbortSignal,candidates:ToolCandidates={}):Promise<PackageInstallation|undefined>{
    this.dependencyObservations.clear();
    try{
    await this.resolveDefinition(definition,'preparation');
    await this.packages.prepare(definition,signal,candidates);
    if(definition.kind==='stdio'&&definition.package)return (await this.packages.resolve(definition)).installation;
    }finally{this.dependencyObservations.clear();}
  }
  /** Verify prerequisites and installed bytes without looking up credentials, probing
   * executable versions, fetching metadata, or creating runtime state. Polls share one
   * bounded-freshness observation; access resolution always checks current bytes. */
  async inspectDependencies(definition:ConnectionRevision):Promise<DependencyObservation>{
    const now=this.now();for(const [key,value]of this.dependencyObservations)if(value.expiresAt<=now)this.dependencyObservations.delete(key);
    const key=`${definition.id}/${definition.revisionId}`,known=this.dependencyObservations.get(key);if(known)return structuredClone(await known.result);
    if(this.inspecting>=this.config.maxObservations)return {observedAt:new Date(now).toISOString(),error:{code:'DEPENDENCY_OBSERVATION_BUSY',message:'Dependency inspection capacity is occupied; inspect again after the current observations settle'}};
    if(this.dependencyObservations.size>=this.config.maxCapabilities)this.dependencyObservations.delete(this.dependencyObservations.keys().next().value!);
    this.inspecting++;
    const entry={expiresAt:Infinity,result:Promise.resolve().then(async()=>{
      let installation:PackageInstallation|undefined,error:DependencyObservation['error'];
      try{await this.inspectHost(definition);if(definition.kind==='stdio'&&definition.package)installation=(await this.packages.resolve(definition)).installation;}
      catch(failure){error=failure instanceof RackFault?{code:failure.code,message:failure.message}:{code:'DEPENDENCY_UNAVAILABLE',message:'Dependency verification could not complete'};}
      const observed=this.now();entry.expiresAt=observed+this.config.observationFreshMs;this.inspecting--;
      return {observedAt:new Date(observed).toISOString(),...(installation?{installation}:{}),...(error?{error}:{})};
    })};
    this.dependencyObservations.set(key,entry);return structuredClone(await entry.result);
  }
  /** Resolve one retained definition, keeping secret bytes exclusively in the returned ACP value.
   * All local launches default temporary state to the owner's access directory; explicit
   * environment bindings take precedence. Without context, templates remain inert. */
  async resolve(definition:ConnectionDefinition|ConnectionRevision,name:string,context?:{workspace:string,runtime:string,data?:string}):Promise<AccessGrant['servers'][number]>{
    let server=await this.resolveDefinition(definition,name,context);
    if(definition.kind==='stdio'&&definition.package){
      if(!('revisionId' in definition))throw safe('PACKAGE_REVISION','Package resolution requires a retained definition revision');
      const prepared=await this.packages.resolve(definition);
      if(!('command' in server))throw safe('PACKAGE_DEFINITION','Package preparation requires stdio');
      server={...server,command:prepared.command,args:prepared.args.map(value=>this.workspace(value,context)),env:[...Object.entries(prepared.env).map(([name,value])=>({name,value:this.workspace(value,context)})),...server.env,{name:'PYTHONDONTWRITEBYTECODE',value:'1'}]};
    }
    if('command' in server)server={...server,env:[...(context?[{name:'HOME',value:context.runtime},{name:'TMPDIR',value:context.runtime}]:[]),...server.env].filter((entry,index,all)=>all.findLastIndex(other=>other.name===entry.name)===index)};
    return server;
  }
  private workspace(value:string,context?:{workspace:string,runtime:string,data?:string}){
    return value.replace(/\$\{(POLARITON_WORKSPACE|POLARITON_RUNTIME|POLARITON_DATA)\}/g,(match,name:string)=>context?(name==='POLARITON_WORKSPACE'?context.workspace:name==='POLARITON_RUNTIME'?context.runtime:context.data??match):match);
  }
  private async inspectHost(definition:ConnectionDefinition|ConnectionRevision):Promise<void>{
    this.validate(definition);
    for(const path of definition.requirements.files){try{await stat(path);}catch{throw safe('PREREQUISITE_MISSING','A declared application or file prerequisite is unavailable');}}
    if(definition.kind==='stdio'&&definition.identity){
      try{executionHost();}catch(error){throw safe('STDIO_PLATFORM',(error as Error).message);}
      const identity=definition.identity;
      if(identity.platform!==process.platform||identity.arch!==process.arch)throw safe('EXECUTABLE_PLATFORM','Registered executable belongs to another platform');
      if(!definition.package)await access(definition.command,constants.X_OK).catch(()=>{throw safe('EXECUTABLE_MISSING','Registered executable is no longer executable');});
      const files=await this.identity(identity.files.map(file=>file.path));
      if(files.length!==identity.files.length||files.some((file,index)=>file.path!==identity.files[index]?.path||file.realpath!==identity.files[index]?.realpath||file.sha256!==identity.files[index]?.sha256))throw safe('EXECUTABLE_DRIFT','Executable or declared dependency identity changed; register a new revision');
    }
  }
  private async resolveDefinition(definition:ConnectionDefinition|ConnectionRevision,name:string,context?:{workspace:string,runtime:string,data?:string}):Promise<AccessGrant['servers'][number]>{
    await this.inspectHost(definition);
    const secrets=Object.keys(definition.credentials).length?await this.secrets():{};
    for(const [ref,expected] of Object.entries(definition.credentials)){
      const value=secrets[ref];
      if(!value)throw safe('CREDENTIAL_MISSING',`Credential reference ${ref} is unavailable`);
      if(value.account!==expected.account||value.authority!==expected.authority)throw safe('CREDENTIAL_IDENTITY','Credential account or authority changed; a definition revision is required');
      if(value.expiresAt&&Date.parse(value.expiresAt)<=Date.now())throw safe('CREDENTIAL_EXPIRED',`Credential reference ${ref} needs renewal`);
    }
    const expand=(fields:Record<string,string>)=>Object.entries(fields).map(([name,value])=>{
      const expanded=value.replace(reference,(match,ref:string)=>workspaceReferences.has(ref)?this.workspace(match,context):secrets[ref]!.value);
      try{if(definition.kind==='http')validateHeaderValue(name,expanded);else if(expanded.includes('\0'))throw new Error();}catch{throw safe('CREDENTIAL_VALUE','A credential value is invalid for its declared transport');}
      return {name,value:expanded};
    });
    if(definition.kind==='http')return {type:'http',name,url:definition.url,headers:expand(definition.headers)};
    return {name,command:definition.command,args:definition.args.map(value=>this.workspace(value,context)),env:expand(definition.env)};
  }
}
