import {mkdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import {credentialRef} from '@deepseek-ai/dsh-credentials';
import Llm from '@deepseek-ai/dsh-llm';
import * as Pi from '@deepseek-ai/dsh-llm-pi-ai';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key';
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write';
import {z} from 'zod';
import {DiscoverProvider,ProviderDefinition,SaveProvider,type ProviderCatalogEntry,type ProviderModel,type ProviderSnapshot} from './provider-contracts.ts';

const StoredProvider=ProviderDefinition.extend({credentialRef:z.string(),pending:z.boolean().default(false)});
const Document=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),defaultRoute:z.string().nullable(),providers:z.array(StoredProvider)}).strict();
type Document=z.infer<typeof Document>;
type StoredProvider=z.infer<typeof StoredProvider>;
const links:Readonly<Record<string,string>>={'deepseek-official':'https://platform.deepseek.com/api_keys',openai:'https://platform.openai.com/api-keys',anthropic:'https://console.anthropic.com/settings/keys'};
const refs:Readonly<Record<string,string>>={'deepseek-official':'DEEPSEEK_API_KEY',openai:'OPENAI_API_KEY',anthropic:'ANTHROPIC_API_KEY'};

/** Public failures deliberately exclude upstream diagnostics, which may contain endpoint responses. */
export class ProviderSettingsError extends Error {
  code:string;
  constructor(code:string,message:string){super(message);this.name='ProviderSettingsError';this.code=code;}
}
export interface ProviderRuntime {
  revision:number;credentialPath:string;deepseek:boolean;deepseekConfig?:DeepSeek.Options;
  providers:Record<string,Pi.PiAiProviderProfile>;defaultModel:string|null;
  choices:ProviderSnapshot['choices'];
}
export interface ProviderSettingsOptions {discoveryTimeoutMs:number;lockTimeoutMs:number}

function parse<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if(!result.success)throw new ProviderSettingsError('INVALID_SETTINGS','Check the provider fields and try again.');
  return result.data;
}
function reference(id:string){return Object.hasOwn(refs,id)?refs[id]:`POLARITON_PROVIDER_${id.toUpperCase().replaceAll('-','_')}_API_KEY`;}
function endpoint(value:string|undefined){
  if(!value)return;
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ProviderSettingsError('INVALID_ENDPOINT','Use an HTTP or HTTPS endpoint without credentials, query parameters, or a fragment.');
}
function profiles(providers:StoredProvider[]):Record<string,Pi.PiAiProviderProfile>{
  return Object.fromEntries(providers.filter(p=>p.id!=='deepseek-official'&&!p.pending).map(p=>[p.id,{
    // Pinned pi transports require an auth marker even for local servers. This
    // public constant expresses keyless intent only; it is never a stored key.
    displayName:p.name,...(p.keyless?{headers:{Authorization:'Bearer local-keyless'}}:{apiKeyEnv:p.credentialRef}),
    ...(p.baseURL?{baseURL:p.baseURL}:{}),...(p.protocol?{api:p.protocol}:{}),
    models:p.models.map(m=>({id:m.id,...(m.name?{name:m.name}:{}),...(m.image!==undefined?{input:m.image?['text','image'] as ['text','image']:['text'] as ['text']}:{}),...(m.contextWindow?{contextWindow:m.contextWindow}:{}),...(m.maxTokens?{maxTokens:m.maxTokens}:{})})),
    retryPolicy:{mode:'normal',maxRetries:0},
  }]));
}

/** Installation-wide provider authority. Each mutation re-reads under a cross-process
 * lock; credential values only enter DSH's write-only service and never settings.
 * A staged credential mutation disables its route until both stores commit, so a
 * partial write remains visible and retryable rather than masquerading as usable. */
export class ProviderSettings {
  readonly credentialPath:string;
  private filename:string;private options:ProviderSettingsOptions;
  private tail:Promise<unknown>=Promise.resolve();private defaultRoute:string|null=null;private revision=0;
  private catalog:ProviderCatalogEntry[]=[];private catalogIds=new Set<string>();
  private constructor(directory:string,options:ProviderSettingsOptions){this.filename=join(directory,'settings.json');this.credentialPath=join(directory,'.credentials.yaml');this.options=options;}

  static async open(directory:string,options:ProviderSettingsOptions){
    const service=new ProviderSettings(directory,options);
    await mkdir(directory,{recursive:true,mode:0o700});
    if(process.platform!=='win32'&&((await stat(directory)).mode&0o077)!==0)throw new ProviderSettingsError('STORAGE_PERMISSIONS','Provider settings directory must be private to its owner (mode 700).');
    await service.host([],async ctx=>{
      const directory=ctx.llm.listConfigurableProviders();service.catalogIds=new Set(directory.map(p=>p.provider));
      for(const [id,keyUrl] of Object.entries(links)){
        const entry=directory.find(p=>p.provider===id);
        if(!entry)throw new ProviderSettingsError('CATALOG_UNAVAILABLE','The installed provider catalog is incomplete.');
        const models=id==='deepseek-official'?await ctx.llm.listModels(id):await ctx.llm.discoverModels('llm-pi-ai',{provider:id});
        service.catalog.push({id,name:id==='openai'?'OpenAI':id==='anthropic'?'Anthropic':entry.displayName,keyUrl,models:models.map(m=>({id:m.id,name:m.name,image:m.inputModalities?.includes('image')??false,...('contextWindow' in m&&m.contextWindow?{contextWindow:m.contextWindow}:{}),...('maxTokens' in m&&m.maxTokens?{maxTokens:m.maxTokens}:{})}))});
      }
    });
    await service.read();
    return service;
  }

  /** Saved default for callers that create worker records synchronously. */
  currentDefault(){return this.defaultRoute;}
  get currentRevision(){return this.revision;}
  async choices(){return (await this.snapshot()).choices;}
  async close(){await this.tail;}
  snapshot(){return this.exclusive(async()=>this.describe(await this.read()));}
  runtime(){return this.withRuntime(async value=>value);}
  /** Keep worker startup and credential snapshot loading in the same mutation gate. */
  withRuntime<T>(effect:(runtime:ProviderRuntime)=>Promise<T>):Promise<T>{
    return this.exclusive(async()=>{
      const document=await this.read(),snapshot=await this.describe(document);
      const available=new Set(snapshot.providers.filter(p=>p.configured).map(p=>p.id));
      const usable=document.providers.filter(p=>available.has(p.id));
      const deepseek=usable.find(p=>p.id==='deepseek-official');
      try{return {ok:true as const,value:await effect({revision:document.revision,credentialPath:this.credentialPath,deepseek:!!deepseek,
        ...(deepseek?{deepseekConfig:{apiKeyEnv:deepseek.credentialRef,models:deepseek.models.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,inputModalities:m.image?['text','image'] as ['text','image']:['text'] as ['text']})),...(deepseek.baseURL?{baseURL:deepseek.baseURL}:{})}}:{}),
        providers:profiles(usable),defaultModel:snapshot.defaultRoute,choices:snapshot.choices})};}catch(error){return {ok:false as const,error};}
    }).then(result=>{if(result.ok)return result.value;throw result.error;});
  }

  save(input:SaveProvider):Promise<ProviderSnapshot>{
    return this.exclusive(async()=>{
      const request=parse(SaveProvider,input);endpoint(request.baseURL);
      if(request.apiKey&&request.keyless)throw new ProviderSettingsError('INVALID_SETTINGS','A keyless endpoint does not need a saved API key.');
      if(request.apiKey&&request.removeKey)throw new ProviderSettingsError('INVALID_SETTINGS','Choose either replacing or removing the saved key.');
      if(request.apiKey&&!/^[\x21-\x7e]+$/.test(request.apiKey))throw new ProviderSettingsError('INVALID_KEY','API keys must contain printable ASCII characters without spaces.');
      const document=await this.read();this.checkRevision(document,request.revision);
      const builtin=this.catalog.find(p=>p.id===request.id);
      if((request.kind==='builtin')!==!!builtin)throw new ProviderSettingsError('INVALID_PROVIDER','Choose a supported provider or use a distinct custom provider ID.');
      if(request.kind==='custom'&&this.catalogIds.has(request.id))throw new ProviderSettingsError('INVALID_PROVIDER','Use a distinct ID for a custom API, such as custom-local.');
      if(request.kind==='custom'&&(!request.baseURL||!request.protocol||!request.models?.length))throw new ProviderSettingsError('INVALID_SETTINGS','Custom providers require an endpoint, protocol, and at least one model.');
      if(request.kind==='builtin'&&request.keyless)throw new ProviderSettingsError('INVALID_SETTINGS','Built-in providers require an API key.');
      if(request.kind==='builtin'&&request.protocol)throw new ProviderSettingsError('INVALID_SETTINGS','Built-in providers use their catalog protocol. Use a custom API to change protocol.');
      const models=request.models?.map(model=>({...builtin?.models.find(known=>known.id===model.id),...model}))??builtin!.models;
      if(new Set(models.map(m=>m.id)).size!==models.length)throw new ProviderSettingsError('INVALID_SETTINGS','Model IDs must be unique within a provider.');
      if(builtin&&models.some(m=>!builtin.models.some(known=>known.id===m.id)))throw new ProviderSettingsError('INVALID_MODEL','Choose a model from the provider catalog, or configure a custom API.');
      const item:StoredProvider={id:request.id,kind:request.kind,name:request.name??builtin?.name??request.id,models,keyless:request.keyless??false,credentialRef:reference(request.id),pending:false,...(request.baseURL?{baseURL:request.baseURL}:{}),...(request.protocol?{protocol:request.protocol}:{})};
      await this.host([item],async ctx=>{for(const model of item.models)await ctx.llm.resolveModelInfo(item.id,model.id);});
      const changesKey=request.apiKey!==undefined||request.removeKey===true||item.keyless;
      if(!changesKey&&document.providers.some(p=>p.id===item.id&&p.pending))throw new ProviderSettingsError('CREDENTIAL_UPDATE_REQUIRED','The previous key update was interrupted. Replace or remove the key to finish repairing this provider.');
      await this.host([],async ctx=>{
        if(changesKey&&!(await ctx.credentials.describe(credentialRef(item.credentialRef))).writable)throw new ProviderSettingsError('READ_ONLY_CREDENTIAL','This key is supplied by the launch environment. Remove that override and restart before editing it here.');
        document.providers=document.providers.filter(p=>p.id!==item.id);document.providers.push({...item,pending:changesKey});
        await this.commit(document);
        if(changesKey){
          try{
            if(request.apiKey!==undefined)await ctx.credentials.set(credentialRef(item.credentialRef),request.apiKey);
            else await ctx.credentials.unset(credentialRef(item.credentialRef));
            document.providers=document.providers.map(p=>p.id===item.id?item:p);
            await this.commit(document);
          }catch{throw new ProviderSettingsError('CREDENTIAL_SAVE_FAILED','The credential update did not complete. This provider is unavailable until you retry saving it.');}
        }
      });
      return this.describe(document);
    });
  }

  remove(id:string,revision?:number):Promise<ProviderSnapshot>{
    return this.exclusive(async()=>{
      parse(SaveProvider.shape.id,id);
      const document=await this.read();this.checkRevision(document,revision);
      await this.host([],async ctx=>{
        const info=await ctx.credentials.describe(credentialRef(reference(id)));
        if(!info.writable)throw new ProviderSettingsError('READ_ONLY_CREDENTIAL','Remove the launch-environment key and restart before removing this provider.');
        document.providers=document.providers.filter(p=>p.id!==id);
        if(document.defaultRoute&&JSON.parse(document.defaultRoute)[0]===id)document.defaultRoute=null;
        await this.commit(document);
        try{await ctx.credentials.unset(credentialRef(reference(id)));}catch{throw new ProviderSettingsError('CREDENTIAL_REMOVE_FAILED','The provider was removed, but deleting its saved key failed. Retry removal to finish.');}
      });
      return this.describe(document);
    });
  }

  setDefault(route:string|null,revision?:number):Promise<ProviderSnapshot>{
    return this.exclusive(async()=>{
      const document=await this.read();this.checkRevision(document,revision);
      const snapshot=await this.describe(document);
      if(route!==null&&!snapshot.choices.some(m=>m.value===route))throw new ProviderSettingsError('MISSING_ROUTE','Choose a configured model for new workers.');
      document.defaultRoute=route;await this.commit(document);return this.describe(document);
    });
  }

  /** Discovery never saves drafts or sends a generation request. Abort propagates to DSH. */
  async discover(input:DiscoverProvider,signal?:AbortSignal):Promise<ProviderModel[]>{
    const request=parse(DiscoverProvider,input);endpoint(request.baseURL);
    const builtin=this.catalog.find(p=>p.id===request.id);if(builtin)return structuredClone(builtin.models);
    const document=await this.read(),stored=document.providers.find(p=>p.id===request.id);
    if(stored&&request.baseURL&&stored.baseURL!==request.baseURL&&!request.apiKey)throw new ProviderSettingsError('NEW_ENDPOINT_KEY_REQUIRED','Supply a key explicitly when discovering models at a different endpoint.');
    const abort=AbortSignal.any([AbortSignal.timeout(this.options.discoveryTimeoutMs),...(signal?[signal]:[])]);
    try{return await this.host(document.providers,async ctx=>{
      const models=await ctx.llm.discoverModels('llm-pi-ai',{provider:request.id,baseURL:request.baseURL??stored?.baseURL,api:request.protocol??stored?.protocol,apiKey:request.apiKey},abort);
      return models.map(m=>({id:m.id,name:m.name,image:m.inputModalities?.includes('image')??false,...(m.contextWindow?{contextWindow:m.contextWindow}:{}),...(m.maxTokens?{maxTokens:m.maxTokens}:{})}));
    });}catch{throw new ProviderSettingsError(abort.aborted?'DISCOVERY_CANCELLED':'DISCOVERY_FAILED',abort.aborted?'Model discovery was cancelled or timed out. You can enter model IDs manually.':'Model discovery failed. Check the endpoint and key, or enter model IDs manually.');}
  }

  private checkRevision(document:Document,revision:number|undefined){if(revision!==undefined&&revision!==document.revision)throw new ProviderSettingsError('SETTINGS_CONFLICT','Settings changed in another window. Reload them before saving.');}
  private async read():Promise<Document>{
    let document:Document;
    try{document=parse(Document,JSON.parse(await readFile(this.filename,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')document={version:1,revision:0,defaultRoute:null,providers:[]};else throw new ProviderSettingsError('SETTINGS_UNREADABLE','Provider settings could not be read. Repair the settings file before continuing.');}
    this.defaultRoute=document.defaultRoute;this.revision=document.revision;
    return document;
  }
  private async commit(document:Document){document.revision++;await writeFileAtomic(this.filename,JSON.stringify(document,null,2)+'\n',{mode:0o600,dirMode:0o700});this.defaultRoute=document.defaultRoute;this.revision=document.revision;}
  private exclusive<T>(operation:()=>Promise<T>):Promise<T>{
    const next=this.tail.then(()=>withFileLock(this.filename,operation,{waitMs:this.options.lockTimeoutMs}));
    this.tail=next.then(()=>undefined,()=>undefined);
    return next.catch(error=>{if(error instanceof ProviderSettingsError)throw error;throw new ProviderSettingsError('SETTINGS_FAILED','Provider settings could not be updated. Check storage permissions and retry.');});
  }
  private async describe(document:Document):Promise<ProviderSnapshot>{
    return this.host([],async ctx=>{
      const providers=await Promise.all(document.providers.map(async p=>{
        const {credentialRef:ref,pending,...definition}=p;
        const credential=p.keyless?{configured:true,source:'keyless',writable:true}:await ctx.credentials.describe(credentialRef(ref));
        return {...definition,credential,configured:!pending&&credential.configured};
      }));
      const choices=providers.filter(p=>p.configured).flatMap(p=>p.models.map(m=>({value:JSON.stringify([p.id,m.id]),name:`${m.name??m.id} · ${p.name}`,image:m.image??false})));
      const catalog=await Promise.all(this.catalog.map(async entry=>({...structuredClone(entry),credential:await ctx.credentials.describe(credentialRef(reference(entry.id)))})));
      return {revision:document.revision,defaultRoute:document.defaultRoute,catalog,providers,choices};
    });
  }
  private async host<T>(providers:StoredProvider[],operation:(ctx:Context)=>Promise<T>):Promise<T>{
    const ctx=new Context();
    try{
      await ctx.plugin(LocalCredentials,{path:this.credentialPath,watch:false});
      await ctx.plugin(Llm);
      await ctx.plugin(Pi,{providers:profiles(providers)});
      const deepseek=providers.find(p=>p.id==='deepseek-official');
      await ctx.plugin(DeepSeek,deepseek?{apiKeyEnv:deepseek.credentialRef,models:deepseek.models.map(m=>({id:m.id,name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,inputModalities:m.image?['text','image'] as ['text','image']:['text'] as ['text']})),...(deepseek.baseURL?{baseURL:deepseek.baseURL}:{})}:{});
      return await operation(ctx);
    }finally{await ctx.fiber.dispose();}
  }
}
