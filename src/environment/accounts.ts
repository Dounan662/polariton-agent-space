import {constants} from 'node:fs';
import {mkdir,open,lstat} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {buildDiscoveryUrls,discoverOAuthServerInfo,startAuthorization,exchangeAuthorization,refreshAuthorization,registerClient,selectClientAuthMethod,type AuthorizationServerMetadata,type OAuthTokens,type FetchLike} from '@modelcontextprotocol/client';
import {AccountCreate,AccountReplace,AccountBinding,AccountPublic,AccountUrl} from './account-contracts.ts';
import {RackFault,type RackConfig} from './contracts.ts';
import {durable} from './storage.ts';

const Metadata=z.object({issuer:AccountUrl,authorization_endpoint:AccountUrl,token_endpoint:AccountUrl,registration_endpoint:AccountUrl.optional(),revocation_endpoint:AccountUrl.optional(),response_types_supported:z.array(z.string()),grant_types_supported:z.array(z.string()).optional(),scopes_supported:z.array(z.string()).optional(),token_endpoint_auth_methods_supported:z.array(z.string()).optional(),revocation_endpoint_auth_methods_supported:z.array(z.string()).optional(),code_challenge_methods_supported:z.array(z.string()).optional(),authorization_response_iss_parameter_supported:z.boolean().optional()});
const Revocation=Metadata.pick({revocation_endpoint:true,revocation_endpoint_auth_methods_supported:true});
const Client=z.object({client_id:z.string().min(1),client_secret:z.string().optional(),token_endpoint_auth_method:z.string().optional()});
const Tokens=z.object({access_token:z.string().min(1),token_type:z.string().refine(value=>value.toLowerCase()==='bearer'),expires_in:z.number().positive(),refresh_token:z.string().optional(),scope:z.string().optional()});
const Pending=z.object({state:z.string().min(1),verifier:z.string().nullable(),redirect:z.string(),expiresAt:z.number()}).strict();
const StoredDefinition=z.discriminatedUnion('kind',[AccountCreate.options[0],AccountCreate.options[1].extend({value:z.string().nullable()})]);
const RecordSchema=z.object({definition:StoredDefinition,epoch:z.string(),status:z.enum(['disconnected','connecting','connected','error']),errorCode:z.string().nullable(),client:Client.nullable(),metadata:Metadata.nullable(),tokens:Tokens.nullable(),expiresAt:z.number().nullable(),granted:z.array(z.string()),pending:Pending.nullable()}).strict();
type AccountRecord=z.infer<typeof RecordSchema>;
const State=z.object({format:z.literal(1),accounts:z.array(RecordSchema)}).strict();
type Config=Pick<RackConfig,'stateRoot'|'oauthCallbackPort'|'oauthTimeoutMs'|'oauthLoginTimeoutMs'|'oauthRefreshSkewMs'|'maxAccounts'|'maxAccountBytes'|'maxOAuthResponseBytes'>;
const fault=(code:string,message:string,status=400)=>new RackFault(code,message,status);
const canonical=(value:string)=>new URL(value).href;
const sameSecret=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};

/** Own account authority separately from software revisions. Only this module sees
 * OAuth bytes. Binding epochs prevent re-login/account changes from retargeting
 * active workers; refresh serializes on the same account and preserves its epoch.
 * The maintained SDK owns discovery, registration, PKCE, exchange and refresh.
 * Discovery stays with the selected origins; credential requests use only exact
 * endpoints delegated by validated issuer metadata. Every request is bounded. */
export class Accounts {
  private records=new Map<string,AccountRecord>();
  private locks=new Map<string,Promise<unknown>>();
  private writes:Promise<void>=Promise.resolve();
  private healthy=true;
  private listener?:Server;
  private listening?:Promise<string>;
  private directory:string;
  private file:string;
  private now:()=>number;
  private nonce:()=>string;
  private fetch:typeof fetch;
  private config:Config;
  constructor(config:Config,dependencies:{now?:()=>number;nonce?:()=>string;fetch?:typeof fetch}={}){
    this.config=config;
    this.directory=join(config.stateRoot,'accounts');this.file=join(this.directory,'private.json');
    this.now=dependencies.now??Date.now;this.nonce=dependencies.nonce??(()=>randomBytes(32).toString('base64url'));this.fetch=dependencies.fetch??fetch;
  }
  async open(){
    await mkdir(this.directory,{recursive:true,mode:0o700});const directory=await lstat(this.directory);
    if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o777)!==0o700||directory.uid!==process.getuid?.())throw fault('ACCOUNT_STORE','Account storage requires an owner-only private directory');
    let handle;
    try {
      handle=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();
      if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.()||info.size>this.config.maxAccountBytes)throw fault('ACCOUNT_STORE','Account storage has invalid permissions or exceeds its byte budget');
      const bytes=await handle.readFile();if(bytes.length>this.config.maxAccountBytes)throw fault('ACCOUNT_STORE','Account storage exceeds its byte budget');
      const saved=State.parse(JSON.parse(bytes.toString()));
      if(saved.accounts.length>this.config.maxAccounts||new Set(saved.accounts.map(account=>account.definition.id)).size!==saved.accounts.length)throw fault('ACCOUNT_STORE','Account storage exceeds capacity or has duplicate identities');
      for(const record of saved.accounts){if(record.pending){record.pending=null;record.status=record.tokens?'connected':'disconnected';record.errorCode='LOGIN_INTERRUPTED';}this.records.set(record.definition.id,record);}
    } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw fault('ACCOUNT_STORE','Private account storage could not be opened safely');}
    finally {await handle?.close();}
    await this.persist();return this;
  }
  list():AccountPublic[]{return [...this.records.values()].map(record=>this.public(record));}
  get(id:string):AccountPublic{return this.public(this.record(id));}
  async create(raw:AccountCreate):Promise<AccountPublic>{
    const input=AccountCreate.parse(raw);return this.serial(input.id,async()=>{
      if(this.records.has(input.id))throw fault('ACCOUNT_EXISTS','The account connection identity already exists',409);
      if(this.records.size>=this.config.maxAccounts)throw fault('ACCOUNT_CAPACITY','Account connection capacity reached',409);
      const record:AccountRecord={definition:input,epoch:this.nonce(),status:input.kind==='static'?'connected':'disconnected',errorCode:null,client:null,metadata:null,tokens:null,expiresAt:input.kind==='static'&&input.expiresAt?Date.parse(input.expiresAt):null,granted:[],pending:null};
      if(input.kind==='oauth'&&input.registration.kind==='preregistered')record.client={client_id:input.registration.clientId,...input.registration.clientSecret?{client_secret:input.registration.clientSecret}:{}};
      this.records.set(input.id,record);await this.persist();return this.public(record);
    });
  }
  async replace(id:string,input:AccountReplace):Promise<AccountPublic>{
    const replacement=AccountReplace.parse(input);return this.serial(id,async()=>{
      const record=this.record(id);if(record.definition.kind!=='static')throw fault('ACCOUNT_KIND','Only static credentials can be replaced directly');
      record.definition={...record.definition,value:replacement.value,expiresAt:replacement.expiresAt};record.expiresAt=replacement.expiresAt?Date.parse(replacement.expiresAt):null;record.status='connected';record.errorCode=null;
      await this.persist();return this.public(record);
    });
  }
  async connect(id:string):Promise<{authorizationUrl:string}>{
    return this.serial(id,async()=>{
      const record=this.record(id),definition=record.definition;if(definition.kind!=='oauth')throw fault('ACCOUNT_KIND','Replace a static credential directly');
      const redirect=await this.callback();record.pending={state:this.nonce(),verifier:null,redirect,expiresAt:this.now()+this.config.oauthLoginTimeoutMs};record.status='connecting';record.errorCode=null;await this.persist();
      try {
        // SDK 2.2's OIDC parser drops revocation extensions. Preserve only these
        // typed fields from the successful selected-issuer discovery document;
        // the SDK still validates discovery before any authority is accepted.
        const network=this.network(definition),documents=new Set(buildDiscoveryUrls(definition.issuer).map(entry=>entry.url.href));let revocation:z.infer<typeof Revocation>={};
        const fetchFn:FetchLike=async(input,init)=>{const response=await network(input,init);if(response.ok&&documents.has(canonical(String(input))))revocation=Revocation.parse(await response.clone().json());return response;};
        const discovery=await discoverOAuthServerInfo(definition.resource,{fetchFn});
        if(canonical(String(discovery.authorizationServerUrl))!==canonical(definition.issuer)||!discovery.authorizationServerMetadata)throw fault('OAUTH_ISSUER','Discovered authorization server differs from the selected issuer');
        if(!discovery.resourceMetadata||canonical(discovery.resourceMetadata.resource)!==canonical(definition.resource)||!discovery.resourceMetadata.authorization_servers?.some(issuer=>canonical(issuer)===canonical(definition.issuer)))throw fault('OAUTH_RESOURCE','Protected resource metadata does not match the selected resource and issuer');
        const metadata=this.metadata({...discovery.authorizationServerMetadata,...revocation},definition.issuer);record.metadata=metadata;await this.persist();
        if(!record.client){
          if(definition.registration.kind!=='dynamic'||!metadata.registration_endpoint)throw fault('OAUTH_REGISTRATION','This issuer requires a pre-registered client');
          record.client=Client.parse(await registerClient(definition.issuer,{metadata,scope:definition.scopes.join(' '),clientMetadata:{client_name:'Polariton',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},fetchFn:this.network(definition,metadata)}));await this.persist();
        }
        const started=await startAuthorization(definition.issuer,{metadata,clientInformation:record.client,redirectUrl:redirect,scope:definition.scopes.join(' '),state:record.pending!.state,resource:definition.resource});
        const endpoint=new URL(metadata.authorization_endpoint);
        if(started.authorizationUrl.origin!==endpoint.origin||started.authorizationUrl.pathname!==endpoint.pathname||started.authorizationUrl.searchParams.get('code_challenge_method')!=='S256')throw fault('OAUTH_AUTHORIZATION','Authorization endpoint or PKCE method is unsupported');
        // Google uses these documented parameters rather than the OIDC
        // offline_access scope. An explicit owner login requests renewable
        // credentials without expanding the capability's selected scopes.
        if(canonical(definition.issuer)==='https://accounts.google.com/'){
          started.authorizationUrl.searchParams.set('access_type','offline');started.authorizationUrl.searchParams.set('prompt','consent');
        }
        record.pending!.verifier=started.codeVerifier;await this.persist();return {authorizationUrl:started.authorizationUrl.href};
      } catch(error){record.pending=null;record.status=record.tokens?'connected':'error';record.errorCode=error instanceof RackFault?error.code:'OAUTH_CONNECT_FAILED';await this.persist();throw fault(record.errorCode,'Account login could not start; inspect the account connection');}
    });
  }
  /** Pin current resource and consent. A software revision cannot widen this binding. */
  binding(id:string,resource:string,scopes:string[]):AccountBinding {
    const record=this.record(id),definition=record.definition;
    if(definition.kind!=='oauth'||canonical(definition.resource)!==canonical(resource)||scopes.some(scope=>!definition.scopes.includes(scope)))throw fault('ACCOUNT_BINDING','Account resource or configured scopes do not match the requested binding',409);
    if(!record.tokens||record.status==='disconnected')throw fault('ACCOUNT_DISCONNECTED','Connect this account before preparing its access',409);
    if(scopes.some(scope=>!record.granted.includes(scope)))throw fault('OAUTH_RECONNECT_REQUIRED','Reconnect this account to grant the configured scopes',409);
    return AccountBinding.parse({connectionId:id,epoch:record.epoch,resource:definition.resource,scopes:[...scopes].sort()});
  }
  /** Refresh before dispatch; a failed or ambiguous tool action is never repeated. */
  async token(raw:AccountBinding):Promise<string>{
    const binding=AccountBinding.parse(raw);return this.serial(binding.connectionId,async()=>{
      const record=this.record(binding.connectionId),definition=record.definition;
      if(definition.kind!=='oauth'||record.epoch!==binding.epoch||canonical(definition.resource)!==canonical(binding.resource)||binding.scopes.some(scope=>!record.granted.includes(scope))||record.status==='disconnected'||!record.tokens)throw fault('ACCOUNT_BINDING_REVOKED','The selected account binding is no longer authorized',409);
      if(record.expiresAt!==null&&record.expiresAt-this.config.oauthRefreshSkewMs>this.now())return record.tokens.access_token;
      if(!record.tokens.refresh_token||!record.client||!record.metadata){record.errorCode='OAUTH_RECONNECT_REQUIRED';await this.persist();throw fault('OAUTH_RECONNECT_REQUIRED','Reconnect this account to obtain current credentials',409);}
      try {
        const tokens=await refreshAuthorization(definition.issuer,{metadata:record.metadata,clientInformation:record.client,refreshToken:record.tokens.refresh_token,resource:definition.resource,fetchFn:this.network(definition,record.metadata)});
        this.accept(record,tokens,false);await this.persist();return record.tokens!.access_token;
      } catch(error){record.errorCode=error instanceof RackFault?error.code:'OAUTH_REFRESH_FAILED';await this.persist();throw fault(record.errorCode,'Account credentials could not be refreshed',503);}
    });
  }
  async disconnect(id:string):Promise<{account:AccountPublic;remoteRevocation:'succeeded'|'unsupported'|'failed'|'not_applicable'}>{
    return this.serial(id,async()=>{
      const record=this.record(id),definition=record.definition,tokens=record.tokens;let remoteRevocation:'succeeded'|'unsupported'|'failed'|'not_applicable'=definition.kind==='static'?'not_applicable':'unsupported';
      record.tokens=null;record.pending=null;record.status='disconnected';record.epoch=this.nonce();record.errorCode=null;record.expiresAt=null;record.granted=[];
      if(definition.kind==='static')record.definition={...definition,value:null};
      await this.persist();
      if(definition.kind==='oauth'&&tokens&&record.metadata?.revocation_endpoint&&record.client){
        try {
          const body=new URLSearchParams({token:tokens.refresh_token??tokens.access_token,token_type_hint:tokens.refresh_token?'refresh_token':'access_token'});
          const headers=new Headers({'content-type':'application/x-www-form-urlencoded'});
          // Revocation may advertise a different client method from token
          // exchange. Reuse SDK selection without inventing an OAuth client.
          const methods=record.metadata.revocation_endpoint_auth_methods_supported??[],method=selectClientAuthMethod(record.client,methods);
          if(methods.length&&!methods.includes(method))throw fault('OAUTH_REVOCATION_METHOD','The revocation endpoint requires an unsupported client authentication method');
          if(method!=='none'&&!record.client.client_secret)throw fault('OAUTH_REVOCATION_METHOD','The revocation endpoint requires a confidential client');
          if(method==='client_secret_basic'){
            const credentials=[record.client.client_id,record.client.client_secret!].map(value=>new URLSearchParams({value}).toString().slice('value='.length)).join(':');
            headers.set('authorization',`Basic ${Buffer.from(credentials).toString('base64')}`);
          }else{
            body.set('client_id',record.client.client_id);
            if(method==='client_secret_post')body.set('client_secret',record.client.client_secret!);
          }
          const response=await this.network(definition,record.metadata)(record.metadata.revocation_endpoint,{method:'POST',headers,body});if(!response.ok)throw new Error();remoteRevocation='succeeded';
        } catch {remoteRevocation='failed';record.errorCode='OAUTH_REVOCATION_FAILED';await this.persist();}
      }
      return {account:this.public(record),remoteRevocation};
    });
  }
  /** Legacy references resolve through the same owner. The returned map is private. */
  credentials():Record<string,{account:string;authority:string;value:string;expiresAt?:string}>{
    this.check();return Object.fromEntries([...this.records.values()].flatMap(record=>record.definition.kind==='static'&&record.definition.value!==null&&record.status==='connected'?[[record.definition.id,{account:record.definition.account,authority:record.definition.authority,value:record.definition.value,...record.definition.expiresAt?{expiresAt:record.definition.expiresAt}:{}}]]:[]));
  }
  async close(){await Promise.allSettled([...this.locks.values()]);await this.writes;if(this.listener){const server=this.listener;this.listener=undefined;await new Promise<void>(resolve=>server.close(()=>resolve()));}this.listening=undefined;}
  private check(){if(!this.healthy)throw fault('ACCOUNT_STORE','Account storage failed; restart after resolving the private storage error',503);}
  private record(id:string){this.check();const record=this.records.get(id);if(!record)throw fault('ACCOUNT_NOT_FOUND','Account connection not found',404);return record;}
  private public(record:AccountRecord):AccountPublic {
    const definition=record.definition,loginExpired=record.pending!==null&&record.pending.expiresAt<=this.now();
    return {id:definition.id,name:definition.name,kind:definition.kind,status:loginExpired?'error':record.status==='connected'&&record.expiresAt!==null&&record.expiresAt<=this.now()?'expired':record.status,epoch:record.epoch,resource:definition.kind==='oauth'?definition.resource:definition.authority,scopes:definition.kind==='oauth'?[...record.granted]:[],account:definition.kind==='static'?definition.account:null,errorCode:loginExpired?'OAUTH_LOGIN_EXPIRED':record.errorCode};
  }
  private async persist(){
    const pending=this.writes.then(async()=>{this.check();const value={format:1,accounts:[...this.records.values()]};if(Buffer.byteLength(JSON.stringify(value))>this.config.maxAccountBytes)throw fault('ACCOUNT_CAPACITY','Private account storage exceeds its byte budget',409);await durable(this.file,value);});
    this.writes=pending.catch(()=>{this.healthy=false;});await pending;
  }
  private serial<T>(id:string,work:()=>Promise<T>):Promise<T>{
    const prior=this.locks.get(id)??Promise.resolve(),pending=prior.catch(()=>{}).then(()=>{this.check();return work();});this.locks.set(id,pending);
    void pending.then(()=>{if(this.locks.get(id)===pending)this.locks.delete(id);},()=>{if(this.locks.get(id)===pending)this.locks.delete(id);});return pending;
  }
  private metadata(input:AuthorizationServerMetadata,issuer:string){
    const metadata=Metadata.parse(input);if(canonical(metadata.issuer)!==canonical(issuer)||!metadata.code_challenge_methods_supported?.includes('S256'))throw fault('OAUTH_ISSUER','Issuer metadata must match the selected authority and support S256 PKCE');
    // Issuers may delegate endpoints to other HTTPS hosts (Google's token host
    // is oauth2.googleapis.com). Loopback HTTP is only for a selected local
    // issuer; remote metadata cannot delegate credentials into that exception.
    const authority=new URL(issuer);
    for(const endpoint of [metadata.authorization_endpoint,metadata.token_endpoint,metadata.registration_endpoint,metadata.revocation_endpoint].filter((value):value is string=>Boolean(value))){
      const url=new URL(endpoint),host=url.hostname.replace(/\.$/,''),loopback=host==='localhost'||host.endsWith('.localhost')||host.startsWith('127.')||host==='[::1]'||host.startsWith('[::ffff:7f');
      if(url.origin!==authority.origin&&(url.protocol!=='https:'||loopback))throw fault('OAUTH_ENDPOINT','Delegated OAuth endpoints require HTTPS and cannot target loopback');
    }
    return metadata;
  }
  private network(definition:Extract<AccountCreate,{kind:'oauth'}>,metadata?:z.infer<typeof Metadata>):FetchLike {
    const origins=[new URL(definition.resource).origin,new URL(definition.issuer).origin],endpoints=[metadata?.token_endpoint,metadata?.registration_endpoint,metadata?.revocation_endpoint].filter((value):value is string=>Boolean(value)).map(canonical);
    return async(input,init)=>{
      const url=new URL(input),method=(init?.method??'GET').toUpperCase();
      if(!AccountUrl.safeParse(url.href).success||!(method==='GET'?origins.includes(url.origin):method==='POST'&&endpoints.includes(url.href)))throw fault('OAUTH_ENDPOINT','OAuth request escaped selected discovery origins or delegated endpoints');
      const signal=AbortSignal.timeout(this.config.oauthTimeoutMs),response=await this.fetch(url,{...init,redirect:'manual',signal:init?.signal?AbortSignal.any([init.signal,signal]):signal});
      if(response.status>=300&&response.status<400){await response.body?.cancel();throw fault('OAUTH_REDIRECT','OAuth HTTP redirects require an explicitly configured endpoint');}
      const chunks:Uint8Array[]=[];let bytes=0;
      if(response.body){const reader=response.body.getReader();try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>this.config.maxOAuthResponseBytes){await reader.cancel();throw fault('OAUTH_RESPONSE_LIMIT','OAuth response exceeds its byte budget');}chunks.push(next.value);}}finally{reader.releaseLock();}}
      return new Response(response.status===204?null:Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});
    };
  }
  private accept(record:AccountRecord,input:OAuthTokens,relogin:boolean){
    const definition=record.definition;if(definition.kind!=='oauth')throw fault('ACCOUNT_KIND','OAuth tokens require an OAuth connection');
    const tokens=Tokens.parse(input),granted=tokens.scope===undefined?definition.scopes:[...new Set(tokens.scope.split(' ').filter(Boolean))];
    if(definition.scopes.some(scope=>!granted.includes(scope))||granted.some(scope=>!definition.scopes.includes(scope)))throw fault('OAUTH_SCOPE','Granted scopes differ from the explicitly selected authority');
    record.tokens=tokens;record.expiresAt=this.now()+tokens.expires_in*1000;record.granted=[...granted].sort();record.status='connected';record.errorCode=null;if(relogin)record.epoch=this.nonce();
  }
  private callback():Promise<string>{
    if(this.listening)return this.listening;
    this.listening=new Promise((resolve,reject)=>{
      const server=createServer({requestTimeout:this.config.oauthTimeoutMs,headersTimeout:this.config.oauthTimeoutMs,keepAliveTimeout:this.config.oauthTimeoutMs,maxHeaderSize:this.config.maxOAuthResponseBytes},(request,response)=>{void (async()=>{
        response.setHeader('cache-control','no-store');response.setHeader('content-type','text/plain; charset=utf-8');response.setHeader('content-security-policy',"default-src 'none'");
        const address=server.address(),port=typeof address==='object'&&address?address.port:0;
        if(request.method!=='GET'||request.headers.host!==`127.0.0.1:${port}`||(request.url?.length??0)>this.config.maxOAuthResponseBytes){response.writeHead(400).end('Invalid account callback.');return;}
        const url=new URL(request.url??'/',`http://127.0.0.1:${port}`),state=url.searchParams.get('state');
        const record=state?[...this.records.values()].find(candidate=>candidate.pending&&sameSecret(candidate.pending.state,state)):undefined;
        if(url.pathname!=='/oauth/callback'||!record||url.searchParams.getAll('state').length!==1){response.writeHead(400).end('Invalid or expired account login.');return;}
        try {await this.serial(record.definition.id,async()=>{
          const pending=record.pending,definition=record.definition;
          if(definition.kind!=='oauth'||!pending||!sameSecret(pending.state,state!)||pending.expiresAt<=this.now()||!pending.verifier||!record.client||!record.metadata)throw fault('OAUTH_STATE','Account login is expired or incomplete');
          const code=url.searchParams.get('code'),iss=url.searchParams.get('iss');
          record.pending=null;await this.persist();
          try {
            if(url.searchParams.has('error')||!code||url.searchParams.getAll('code').length!==1||url.searchParams.getAll('iss').length>1)throw fault('OAUTH_CALLBACK','Account login was denied or returned an invalid callback');
            const tokens=await exchangeAuthorization(definition.issuer,{metadata:record.metadata,clientInformation:record.client,authorizationCode:code,...iss?{iss}:{},codeVerifier:pending.verifier,redirectUri:pending.redirect,resource:definition.resource,fetchFn:this.network(definition,record.metadata)});this.accept(record,tokens,true);await this.persist();
          } catch(error) {record.status=record.tokens?'connected':'error';record.errorCode=error instanceof RackFault?error.code:'OAUTH_EXCHANGE_FAILED';await this.persist();throw fault(record.errorCode,'Account login could not complete');}
        });response.writeHead(200).end('Account connected. Return to Polariton and validate the capability.');}
        catch {response.writeHead(400).end('Account login failed. Return to Polariton to inspect the account connection.');}
      })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end('Account login failed.');});});
      this.listener=server;server.maxConnections=this.config.maxAccounts;server.once('error',()=>{this.listener=undefined;this.listening=undefined;reject(fault('OAUTH_CALLBACK_UNAVAILABLE','The configured loopback callback port is unavailable'));});
      server.listen(this.config.oauthCallbackPort,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){reject(fault('OAUTH_CALLBACK_UNAVAILABLE','Callback listener is unavailable'));return;}resolve(`http://127.0.0.1:${address.port}/oauth/callback`);});
    });return this.listening;
  }
}
