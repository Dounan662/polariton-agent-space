import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Accounts} from '../src/environment/accounts.ts';
import {Connections} from '../src/environment/connections.ts';
import {RackConfig,type AccessGrant,type ConnectionRevision,type Revision,type Inventory} from '../src/environment/contracts.ts';
import type {PreparationResult} from '../src/environment/preparation-contracts.ts';
import {createEnvironmentDaemon,EnvironmentClient} from '../src/environment/daemon.ts';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import * as McpClient from '../harness/native/mcp-client.mjs';
import {credentialProvider} from '../harness/mcp-credentials.ts';
import {capability} from './fixtures/adr011/server.mjs';
import {testDeadline} from './fixtures/timing.ts';

/** Controlled issuer independently verifies PKCE, audience, state forwarding, and
 * effect counts. It contains no real identity, external login, or token material. */
async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'pauth-'));let now=1000000,sequence=0,currentAccess='';
  const grants=new Map<string,{challenge:string;redirect:string;scope:string}>();
  const observed={registration:0,exchange:0,refresh:0,revocation:0,toolCalls:0,mcpRequests:0},behavior={issuerOverride:'',scopeOverride:'',unavailable:false,redirectMetadata:false};
  let origin='';
  const server=createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url!,origin);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const text=Buffer.concat(chunks).toString();
    const json=(value:unknown,status=200)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));
    if(behavior.unavailable){json({error:'temporarily_unavailable'},503);return;}
    if(url.pathname.startsWith('/.well-known/oauth-protected-resource')){json({resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['read']});return;}
    if(url.pathname==='/.well-known/oauth-authorization-server'){
      if(behavior.redirectMetadata){res.writeHead(302,{location:origin+'/redirected-metadata'}).end();return;}
      json({issuer:behavior.issuerOverride||origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',revocation_endpoint:origin+'/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true});return;
    }
    if(url.pathname==='/register'){observed.registration++;const input=JSON.parse(text);assert.equal(input.token_endpoint_auth_method,'none');assert.equal(input.redirect_uris.length,1);json({...input,client_id:'controlled-client',token_endpoint_auth_method:'none'});return;}
    if(url.pathname==='/authorize'){
      assert.equal(url.searchParams.get('resource'),origin+'/mcp');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('response_type'),'code');
      const code=`controlled-code-${++sequence}`,redirect=url.searchParams.get('redirect_uri')!;grants.set(code,{challenge:url.searchParams.get('code_challenge')!,redirect,scope:url.searchParams.get('scope')!});
      const target=new URL(redirect);target.searchParams.set('code',code);target.searchParams.set('state',url.searchParams.get('state')!);target.searchParams.set('iss',origin);res.writeHead(302,{location:target.href}).end();return;
    }
    if(url.pathname==='/token'){
      const input=new URLSearchParams(text);assert.equal(input.get('resource'),origin+'/mcp');assert.equal(input.get('client_id'),'controlled-client');
      if(input.get('grant_type')==='authorization_code'){
        observed.exchange++;const grant=grants.get(input.get('code')!);assert(grant);grants.delete(input.get('code')!);assert.equal(input.get('redirect_uri'),grant.redirect);assert.equal(createHash('sha256').update(input.get('code_verifier')!).digest('base64url'),grant.challenge);
      }else {observed.refresh++;assert.equal(input.get('grant_type'),'refresh_token');assert(input.get('refresh_token')?.startsWith('private-refresh-'));}
      const current=++sequence;currentAccess=`private-access-${current}`;json({access_token:currentAccess,refresh_token:`private-refresh-${current}`,token_type:'Bearer',expires_in:60,scope:behavior.scopeOverride||'read'});return;
    }
    if(url.pathname==='/revoke'){observed.revocation++;const input=new URLSearchParams(text);assert.equal(input.get('token_type_hint'),'refresh_token');assert(input.get('token')?.startsWith('private-refresh-'));json({});return;}
    if(url.pathname==='/mcp'){
      observed.mcpRequests++;if(!currentAccess||req.headers.authorization!==`Bearer ${currentAccess}`){json({error:'unauthorized'},401);return;}
      const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true}),mcp=capability({record:(entry:Record<string,unknown>)=>{if(entry.phase==='invoked')observed.toolCalls++;}});
      try{await mcp.connect(transport);const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
        const response=await transport.handleRequest(new Request(url,{method:req.method,headers,...text?{body:text}:{}}));res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body)res.write(chunk);res.end();
      }finally{await mcp.close();}return;
    }
    json({},404);
  })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;
  const config=RackConfig.parse({stateRoot:root,socketPath:join(root,'env.sock'),oauthCallbackPort:0,oauthTimeoutMs:testDeadline(2000),oauthLoginTimeoutMs:10000,oauthRefreshSkewMs:0});
  const accounts=await new Accounts(config,{now:()=>now}).open();
  t.after(async()=>{await accounts.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  const create=async(id='test',registration:{kind:'dynamic'}|{kind:'preregistered';clientId:string}={kind:'dynamic'})=>accounts.create({kind:'oauth',id,name:'Controlled OAuth',resource:origin+'/mcp',issuer:origin,scopes:['read'],registration});
  const login=async(id='test')=>{const result=await accounts.connect(id),authorize=await fetch(result.authorizationUrl,{redirect:'manual'});assert.equal(authorize.status,302);return new URL(authorize.headers.get('location')!);};
  return {root,origin,config,accounts,observed,behavior,create,login,advance:(milliseconds:number)=>{now+=milliseconds;}};
}

test('controlled OAuth uses discovery, dynamic registration, PKCE, scoped refresh races, durable epochs and remote disconnect',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t);await f.create();assert.equal(f.accounts.get('test').status,'disconnected');
  const callback=await f.login();assert.equal((await fetch(callback)).status,200);assert.equal(f.observed.registration,1);assert.equal(f.observed.exchange,1);
  const binding=f.accounts.binding('test',f.origin+'/mcp',['read']),token=await f.accounts.token(binding);assert.match(token,/^private-access-/);
  assert(!JSON.stringify(f.accounts.list()).includes(token));assert.equal(f.accounts.get('test').account,null,'Generic OAuth makes no claim to know a human account subject');
  f.advance(61000);const refreshed=await Promise.all(Array.from({length:6},()=>f.accounts.token(binding)));assert.equal(new Set(refreshed).size,1);assert.notEqual(refreshed[0],token);assert.equal(f.observed.refresh,1);assert.equal(f.accounts.get('test').epoch,binding.epoch);
  assert.equal((await stat(join(f.root,'accounts'))).mode&0o777,0o700);assert.equal((await stat(join(f.root,'accounts','private.json'))).mode&0o777,0o600);
  await f.accounts.close();const restored=await new Accounts(f.config).open();t.after(()=>restored.close());assert.equal(restored.get('test').epoch,binding.epoch);
  const disconnected=await restored.disconnect('test');assert.equal(disconnected.remoteRevocation,'succeeded');assert.equal(f.observed.revocation,1);await assert.rejects(restored.token(binding),{code:'ACCOUNT_BINDING_REVOKED'});
  const bytes=await readFile(join(f.root,'accounts','private.json'),'utf8');assert(!bytes.includes('private-access-'));assert(!bytes.includes('private-refresh-'));
});

test('state, issuer mix-up, replay and insufficient consent fail without widening an account binding',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t);await f.create('test',{kind:'preregistered',clientId:'controlled-client'});
  assert.throws(()=>f.accounts.binding('test',f.origin+'/mcp',['read']),{code:'ACCOUNT_DISCONNECTED'});
  assert.throws(()=>f.accounts.binding('test',f.origin+'/different',['read']),{code:'ACCOUNT_BINDING'});
  assert.throws(()=>f.accounts.binding('test',f.origin+'/mcp',['write']),{code:'ACCOUNT_BINDING'});
  let callback=await f.login();const wrongState=new URL(callback);wrongState.searchParams.set('state','wrong');assert.equal((await fetch(wrongState)).status,400);assert.equal(f.observed.exchange,0);
  const wrongIssuer=new URL(callback);wrongIssuer.searchParams.set('iss','https://unexpected.example');assert.equal((await fetch(wrongIssuer)).status,400);assert.equal(f.observed.exchange,0);
  callback=await f.login();assert.equal((await fetch(callback)).status,200);const binding=f.accounts.binding('test',f.origin+'/mcp',['read']);assert.equal((await fetch(callback)).status,400);assert.equal(f.observed.exchange,1);
  assert.throws(()=>f.accounts.binding('test',f.origin+'/different',['read']),{code:'ACCOUNT_BINDING'});assert.throws(()=>f.accounts.binding('test',f.origin+'/mcp',['write']),{code:'ACCOUNT_BINDING'});
  callback=await f.login();assert.equal((await fetch(callback)).status,200);assert.notEqual(f.accounts.get('test').epoch,binding.epoch);await assert.rejects(f.accounts.token(binding),{code:'ACCOUNT_BINDING_REVOKED'});
  f.behavior.scopeOverride='read write';callback=await f.login();assert.equal((await fetch(callback)).status,400);assert.deepEqual(f.accounts.get('test').scopes,['read']);
  assert.equal(f.observed.registration,0);
});

test('expired login, unavailable issuer and redirected metadata remain observable and recoverable',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t);await f.create();const callback=await f.login();f.advance(10001);assert.equal((await fetch(callback)).status,400);assert.equal(f.observed.exchange,0);
  f.behavior.redirectMetadata=true;await assert.rejects(f.accounts.connect('test'));assert.equal(f.accounts.get('test').status,'error');
  f.behavior.redirectMetadata=false;f.behavior.unavailable=true;await assert.rejects(f.accounts.connect('test'));assert(f.accounts.get('test').errorCode);
  f.behavior.unavailable=false;assert.equal((await fetch(await f.login())).status,200);assert.equal(f.accounts.get('test').status,'connected');
  const denied=await f.login();denied.searchParams.delete('code');denied.searchParams.set('error','access_denied');assert.equal((await fetch(denied)).status,400);assert.equal(f.accounts.get('test').status,'connected');assert.equal(f.accounts.get('test').errorCode,'OAUTH_CALLBACK');
});

test('daemon access handles bind consent, refresh live MCP credentials and deny released or disconnected access',{timeout:testDeadline(30000)},async t=>{
  const f=await fixture(t);await f.accounts.close();
  // A skew equal to token lifetime forces deterministic proactive refresh through
  // the real daemon clock, without reaching into its private account owner.
  const config=RackConfig.parse({...f.config,oauthRefreshSkewMs:60000,monitorMs:3600000}),daemon=await createEnvironmentDaemon(config),client=new EnvironmentClient(config);
  t.after(()=>daemon.app.close());
  await client.call('/v1/accounts',{kind:'oauth',id:'remote-account',name:'Controlled account',resource:f.origin+'/mcp',issuer:f.origin,scopes:['read'],registration:{kind:'dynamic'}});t.diagnostic('Owner account definition created');
  const {authorizationUrl}=await client.call<{authorizationUrl:string}>('/v1/accounts/remote-account/connect',{}),authorization=await fetch(authorizationUrl,{redirect:'manual'});assert.equal((await fetch(authorization.headers.get('location')!)).status,200);t.diagnostic('Explicit owner login completed');
  const component={id:'remote',name:'Remote',source:{kind:'endpoint',url:f.origin+'/mcp'},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'remote-account',scopes:['read']}};
  const blocked=await client.call<PreparationResult>('/v1/command',{kind:'environment.prepare',operationId:'00000000-0000-4000-8000-000000000001',input:{name:'Bad consent',components:[{...component,authentication:{...component.authentication,scopes:['write']}}]}});assert.equal(blocked.status,'blocked');assert.equal(blocked.actions[0]?.kind,'review');assert.equal(blocked.actions[0]?.code,'ACCOUNT_BINDING');
  const prepared=await client.call<PreparationResult>('/v1/command',{kind:'environment.prepare',operationId:'00000000-0000-4000-8000-000000000002',input:{name:'Consented',components:[component]}});assert.equal(prepared.status,'ready');assert(prepared.revisionId);
  const workspace=join(f.root,'workspace');await mkdir(workspace);
  const acquire=(id:string)=>client.acquire({id,owner:'main',principal:id,workspace,environment:{environmentId:prepared.environmentId!,revisionId:prepared.revisionId!,name:'Consented'},requireHead:true});
  const open=async(grant:AccessGrant)=>{
    const server=grant.servers[0]!;assert('type'in server&&server.credential);const handle=server.credential,provider=credentialProvider(handle,{timeoutMs:config.oauthTimeoutMs,maxBytes:config.maxOAuthResponseBytes});
    const ctx=new Context();await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);
    const fiber=ctx.plugin(McpClient,{transport:'streamable-http',serverName:server.name,url:server.url,headers:{},cleanupTimeoutMs:config.oauthTimeoutMs,toolCallTimeoutMs:config.oauthTimeoutMs,failOnStartupError:true,reconnect:{enabled:false},credentialProvider:provider});await fiber;
    const close=async()=>{await McpClient.drainMcp(ctx);await fiber.dispose();await ctx.fiber.dispose();};t.after(close);
    return {server,handle,provider,close,call:()=>ctx.tools.execute({callId:ToolCallId('check'),name:`mcp__${server.name}__transform`,arguments:{value:6,label:'checked'},signal:new AbortController().signal})};
  };
  const grant=await acquire('worker-one'),first=await open(grant),refreshes=f.observed.refresh;assert.equal((await first.call()).isError,false);assert(f.observed.refresh>refreshes);assert.equal(f.observed.toolCalls,1);
  for(const altered of [{...first.handle,serverName:'other'},{...first.handle,accessId:'unknown'},{...first.handle,token:'incorrect'}])await assert.rejects(credentialProvider(altered,{timeoutMs:config.oauthTimeoutMs,maxBytes:config.maxOAuthResponseBytes}).token(),{code:'MCP_CREDENTIAL_UNAVAILABLE'});
  const inventory=await client.call('/v1/inventory'),accounts=await client.call('/v1/accounts');assert(!JSON.stringify({prepared,grant,inventory,accounts}).match(/private-access-|private-refresh-|controlled-code-/),'Definitions, public receipts and the exact Main access handoff contain no OAuth bytes');
  await client.release({id:'worker-one',owner:'main'});let requests=f.observed.mcpRequests;assert.equal((await first.call()).isError,true);assert.equal(f.observed.mcpRequests,requests);await first.close();
  const second=await open(await acquire('worker-two'));assert.equal((await second.call()).isError,false);await client.call('/v1/accounts/remote-account/disconnect',{});requests=f.observed.mcpRequests;assert.equal((await second.call()).isError,true);assert.equal(f.observed.mcpRequests,requests);await second.close();await client.release({id:'worker-two',owner:'main'});
});

test('static credential replacement preserves identity and disconnect deletes bytes across restart',async t=>{
  const f=await fixture(t);await f.accounts.create({kind:'static',id:'static-key',name:'Credential',account:'account-a',authority:'service-a',value:'private-static-first'});
  const epoch=f.accounts.get('static-key').epoch;await f.accounts.replace('static-key',{value:'private-static-second'});assert.equal(f.accounts.get('static-key').epoch,epoch);assert.equal(f.accounts.credentials()['static-key'].value,'private-static-second');
  assert(!JSON.stringify(f.accounts.list()).includes('private-static'));await f.accounts.disconnect('static-key');assert.deepEqual(f.accounts.credentials(),{});await f.accounts.close();
  const restored=await new Accounts(f.config).open();t.after(()=>restored.close());assert.equal(restored.get('static-key').status,'disconnected');assert(!String(await readFile(join(f.root,'accounts','private.json'))).includes('private-static'));
});

test('duplicate static references identify the conflicting credential owners without exposing secret values',async t=>{
  const f=await fixture(t),credentialFile=join(f.root,'credentials.json');
  await f.accounts.create({kind:'static',id:'shared',name:'Managed',account:'managed-account',authority:'service',value:'private-managed-value'});
  await writeFile(credentialFile,JSON.stringify({format:1,credentials:{shared:{account:'external-account',authority:'service',value:'private-external-value'}}}),{mode:0o600});
  const connections=new Connections({...f.config,credentialFile},()=>f.accounts.credentials());
  const result=await connections.preview({configuration:{mcpServers:{service:{url:f.origin+'/mcp',headers:{Authorization:'Bearer ${shared}'}}}}});
  assert.equal(result.errors[0]?.code,'CREDENTIAL_CONFLICT');assert(!JSON.stringify(result).includes('private-'));
  await f.accounts.disconnect('shared');
  const recovered=await connections.preview({configuration:{mcpServers:{service:{url:f.origin+'/mcp',headers:{Authorization:'Bearer ${shared}'}}}}});
  assert.deepEqual(recovered.errors,[]);assert.equal(recovered.entries[0]?.definition.credentials.shared.account,'external-account');
});

test('capability authentication is owner-only, revision-pinned and independent of environment publication',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t);await f.accounts.close();let daemon=await createEnvironmentDaemon({...f.config,monitorMs:3600000});const client=new EnvironmentClient(f.config);t.after(()=>daemon.app.close());
  const command=(value:Record<string,unknown>)=>client.call('/v1/command',value);
  const imported=await command({kind:'capability.import',operationId:'catalog-import',entries:[{name:'Catalog endpoint',definition:{kind:'http',url:f.origin+'/mcp',headers:{Accept:'application/json'},credentials:{},requirements:{files:[],identityFiles:[],execution:'foreground-host'}}}]}) as {capabilities:ConnectionRevision[]};
  const original=imported.capabilities[0]!;
  const environment=await command({kind:'environment.publish',operationId:'environment-before',expectedBase:null,document:{format:2,environmentId:'stable-environment',name:'Stable',description:'Pinned environment',components:[{id:'endpoint',name:'Endpoint',definition:{capabilityId:original.id,revisionId:original.revisionId},resource:{identity:'retained-resource',exclusive:true}}]}}) as Revision;
  const authentication={kind:'oauth',connectionId:'catalog-account',scopes:['read']},authenticate={kind:'capability.authenticate',operationId:'catalog-login',id:original.id,expectedBase:original.revisionId,authentication};
  await client.call('/v1/accounts',{kind:'oauth',id:'catalog-account',name:'Catalog account',resource:f.origin+'/mcp',issuer:f.origin,scopes:['read'],registration:{kind:'dynamic'}});
  await assert.rejects(command({...authenticate,operationId:'before-login'}),{code:'ACCOUNT_DISCONNECTED'});
  const worker={kind:'worker',id:'00000000-0000-4000-8000-000000000001',processId:'00000000-0000-4000-8000-000000000002'};
  await assert.rejects(client.callAs('/v1/cli',{request:{version:1,requestId:'00000000-0000-4000-8000-000000000003',command:{kind:'capability.authenticate',input:{target:original.id,expectRevision:original.revisionId,authentication}}},actor:worker}),{code:'ACTOR_DENIED'});
  await assert.rejects(client.callAs('/v1/command',authenticate),{code:'ACTOR_DENIED'});
  assert(original.kind==='http');const {id:initialId,name:initialName,revisionId:initialRevision,baseRevisionId:initialBase,operationId:initialOperation,createdAt:initialCreation,...initialDefinition}=original;
  const workerEdit={request:{version:1,requestId:'00000000-0000-4000-8000-000000000004',command:{kind:'capability.revise',input:{target:original.id,expectRevision:original.revisionId,entry:{name:'Worker revised endpoint',definition:initialDefinition}}}},actor:worker};
  const edited=await client.callAs<{result:ConnectionRevision}>('/v1/cli',workerEdit);authenticate.expectedBase=edited.result.revisionId;
  const {authorizationUrl}=await client.call<{authorizationUrl:string}>('/v1/accounts/catalog-account/connect',{}),authorization=await fetch(authorizationUrl,{redirect:'manual'});assert.equal((await fetch(authorization.headers.get('location')!)).status,200);
  const revised=await command(authenticate) as ConnectionRevision;assert.equal(revised.kind,'http');assert(revised.kind==='http'&&revised.account);assert.equal(revised.account.connectionId,'catalog-account');assert(revised.account.epoch);assert.deepEqual(revised.headers,{Accept:'application/json'});assert.deepEqual(revised.requirements,original.requirements);
  assert.deepEqual((await client.callAs<{result:ConnectionRevision}>('/v1/cli',workerEdit)).result,edited.result,'A successful original worker operation remains replayable after an owner adds OAuth');assert.deepEqual(await client.call(`/v1/capabilities/${original.id}`),revised);
  const {id,name,revisionId,baseRevisionId,operationId,createdAt,...bound}=revised,misdirected={...bound,url:f.origin+'/wrong-resource'};
  const connections=new Connections(f.config);assert.throws(()=>connections.validate(misdirected),{code:'ACCOUNT_RESOURCE'});await assert.rejects(connections.resolve(misdirected,'misdirected'),{code:'ACCOUNT_RESOURCE'});await assert.rejects(connections.prepare({...revised,...misdirected}),{code:'ACCOUNT_RESOURCE'});
  await assert.rejects(command({kind:'capability.import',operationId:'wrong-audience-import',entries:[{name:'Wrong resource',definition:misdirected}]}),{code:'ACCOUNT_RESOURCE'});
  await assert.rejects(command({kind:'capability.revise',operationId:'wrong-audience-revise',id,expectedBase:revisionId,entry:{name,definition:misdirected}}),{code:'ACCOUNT_RESOURCE'});
  const withoutAccount={...bound};delete withoutAccount.account;
  for(const [index,definition]of [withoutAccount,{...bound,account:{...bound.account!,epoch:'different'}}].entries())await assert.rejects(client.callAs('/v1/cli',{request:{version:1,requestId:`00000000-0000-4000-8000-00000000002${index}`,command:{kind:'capability.revise',input:{target:id,expectRevision:revisionId,entry:{name,definition}}}},actor:worker}),{code:'ACTOR_DENIED'});
  await assert.rejects(client.callAs('/v1/cli',{request:{version:1,requestId:'00000000-0000-4000-8000-000000000022',command:{kind:'capability.import',input:{entries:[{name:'Copied binding',definition:bound}]}}},actor:worker}),{code:'ACTOR_DENIED'});
  assert.equal(f.observed.mcpRequests,0,'Rejected audience changes never contact a tool server');
  assert.deepEqual(await command(authenticate),revised);await assert.rejects(command({...authenticate,operationId:'stale-authentication'}),{code:'STALE_REVISION'});
  const inventory=await client.call<Inventory>('/v1/inventory');assert.deepEqual(inventory.environments,[{id:environment.environmentId,head:environment}]);assert.deepEqual(inventory.realizations,[]);assert.deepEqual(inventory.bindings,[]);
  assert.deepEqual(await client.call(`/v1/capabilities/${original.id}/revisions/${original.revisionId}`),original);
  await daemon.app.close();daemon=await createEnvironmentDaemon({...f.config,monitorMs:3600000});assert.deepEqual(await client.call(`/v1/capabilities/${original.id}`),revised);assert.deepEqual((await client.call<Inventory>('/v1/inventory')).environments,inventory.environments);
  const removed=await command({kind:'capability.authenticate',operationId:'remove-oauth-binding',id:original.id,expectedBase:revised.revisionId,authentication:{kind:'none'}}) as ConnectionRevision;assert(removed.kind==='http'&&!removed.account);assert.deepEqual(removed.headers,revised.headers);assert.deepEqual((await client.call<Inventory>('/v1/inventory')).environments,inventory.environments);
});

test('owner completion registers exactly one pending capability through the daemon without creating an environment',{timeout:testDeadline(20000)},async t=>{
  const f=await fixture(t);await f.accounts.close();const daemon=await createEnvironmentDaemon({...f.config,monitorMs:3600000}),client=new EnvironmentClient(f.config);t.after(()=>daemon.app.close());
  const operationId='00000000-0000-4000-8000-000000000010',component={id:'selected',name:'Selected',source:{kind:'endpoint',url:f.origin+'/mcp'},runtime:{kind:'external'},connection:{kind:'http'},requirements:{},authentication:{kind:'oauth',connectionId:'selected-account',scopes:['read']}};
  const first=await client.call<PreparationResult>('/v1/command',{kind:'environment.prepare',operationId,input:{name:'Pending composition',components:[component,{...component,id:'sibling',name:'Sibling',authentication:{...component.authentication,connectionId:'missing-sibling'}}]}});assert.equal(first.components.length,2);assert(first.components.every(value=>!value.capabilityId));
  await client.call('/v1/accounts',{kind:'oauth',id:'selected-account',name:'Selected account',resource:f.origin+'/mcp',issuer:f.origin,scopes:['read'],registration:{kind:'dynamic'}});
  const {authorizationUrl}=await client.call<{authorizationUrl:string}>('/v1/accounts/selected-account/connect',{}),authorization=await fetch(authorizationUrl,{redirect:'manual'});assert.equal((await fetch(authorization.headers.get('location')!)).status,200);
  const completion={kind:'capability.complete',operationId:'00000000-0000-4000-8000-000000000011',input:{target:first.operationId,expectedVersion:first.version,componentId:'selected'}};
  const result=await client.call<PreparationResult>('/v1/command',completion);assert(result.components[0]!.capabilityId);assert.equal(result.components[1]!.capabilityId,null);assert.equal(result.revisionId,null);assert.deepEqual(await client.call('/v1/command',completion),result);
  const inventory=await client.call<Inventory>('/v1/inventory');assert.equal(inventory.capabilities.length,1);assert.deepEqual(inventory.environments,[]);assert.deepEqual(inventory.realizations,[]);assert.equal(inventory.preparations[0]!.result.components[0]!.capabilityId,inventory.capabilities[0]!.id);
  assert(!JSON.stringify({result,inventory}).match(/private-access-|private-refresh-/));
  const worker={kind:'worker',id:'00000000-0000-4000-8000-000000000012',processId:'00000000-0000-4000-8000-000000000013'},requestId='00000000-0000-4000-8000-000000000014';
  const receipt=await client.callAs<{result:PreparationResult}>('/v1/cli',{request:{version:1,requestId,command:{kind:'environment.prepare',input:{name:'Preauthorized worker capability',components:[component]}}},actor:worker});
  assert.equal(receipt.result.status,'ready');assert.equal(receipt.result.components[0]!.authentication.kind,'oauth');
  const capability=await client.call<ConnectionRevision>(`/v1/capabilities/${receipt.result.components[0]!.capabilityId}`);assert(capability.kind==='http'&&capability.account);assert.equal(capability.account.connectionId,'selected-account');
});

/** Published Google metadata shape, served by an injected HTTP boundary. Only
 * the owner callback uses a local socket; no Google login or data is accessed. */
async function delegatedIssuer(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'pauth-delegated-'));let now=1000000,authorization:URL|undefined;
  const scope='https://www.googleapis.com/auth/gmail.readonly',resource='https://gmailmcp.googleapis.com/mcp/v1',issuer='https://accounts.google.com/';
  const resourceMetadata={resource,authorization_servers:[issuer],bearer_methods_supported:['header'],scopes_supported:[scope]};
  const metadata={issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',revocation_endpoint:'https://oauth2.googleapis.com/revoke',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic'],scopes_supported:['openid','email','profile'],code_challenge_methods_supported:['plain','S256'],authorization_response_iss_parameter_supported:true};
  const observed={exchange:0,refresh:0,revocation:0},behavior={redirectToken:false,revocationMethods:undefined as string[]|undefined},requests:{url:string;method:string}[]=[];
  const config=RackConfig.parse({stateRoot:root,socketPath:join(root,'env.sock'),oauthCallbackPort:0,oauthTimeoutMs:testDeadline(2000),oauthLoginTimeoutMs:10000,oauthRefreshSkewMs:0});
  const fakeFetch:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),method=init?.method??'GET';requests.push({url:url.href,method});assert.equal(init?.redirect,'manual');
    const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(url.href==='https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1')return json(resourceMetadata);
    if(url.href==='https://accounts.google.com/.well-known/oauth-authorization-server')return json({},404);
    if(url.href==='https://accounts.google.com/.well-known/openid-configuration')return json({...metadata,...behavior.revocationMethods?{revocation_endpoint_auth_methods_supported:behavior.revocationMethods}:{}});
    if(url.href===metadata.token_endpoint||url.href===metadata.revocation_endpoint){
      assert.equal(method,'POST');const headers=new Headers(init?.headers),body=new URLSearchParams(String(init?.body));
      if(url.href===metadata.revocation_endpoint&&behavior.revocationMethods?.includes('client_secret_post')){
        assert.equal(headers.get('authorization'),null);assert.equal(body.get('client_id'),'synthetic-client');assert.equal(body.get('client_secret'),'synthetic-secret');
      }else assert.equal(headers.get('authorization'),`Basic ${Buffer.from('synthetic-client:synthetic-secret').toString('base64')}`);
      if(url.href===metadata.revocation_endpoint){observed.revocation++;assert.equal(body.get('token'),'synthetic-refresh');return json({});}
      if(behavior.redirectToken)return new Response(null,{status:307,headers:{location:'https://unselected.example/token'}});
      assert.equal(body.get('resource'),resource);
      if(body.get('grant_type')==='authorization_code'){
        observed.exchange++;assert(authorization);assert.equal(body.get('code'),'synthetic-code');assert.equal(body.get('redirect_uri'),authorization.searchParams.get('redirect_uri'));
        assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),authorization.searchParams.get('code_challenge'));
        return json({access_token:'synthetic-access-initial',refresh_token:'synthetic-refresh',token_type:'Bearer',expires_in:60,scope});
      }
      observed.refresh++;assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'synthetic-refresh');
      // Google commonly returns only the new access token on refresh.
      return json({access_token:`synthetic-access-${observed.refresh}`,token_type:'Bearer',expires_in:60,scope});
    }
    throw new Error('Unexpected endpoint in controlled OAuth test');
  };
  const accounts=await new Accounts(config,{now:()=>now,fetch:fakeFetch}).open();
  t.after(async()=>{await accounts.close();await rm(root,{recursive:true,force:true});});
  const create=(id='google',dynamic=false)=>accounts.create({kind:'oauth',id,name:'Controlled Google profile',resource,issuer,scopes:[scope],registration:dynamic?{kind:'dynamic'}:{kind:'preregistered',clientId:'synthetic-client',clientSecret:'synthetic-secret'}});
  const login=async(id='google')=>{authorization=new URL((await accounts.connect(id)).authorizationUrl);const callback=new URL(authorization.searchParams.get('redirect_uri')!);callback.searchParams.set('code','synthetic-code');callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('iss',metadata.issuer);return {authorization,callback};};
  return {accounts,config,root,resource,scope,metadata,resourceMetadata,observed,behavior,requests,create,login,advance:(ms:number)=>{now+=ms;}};
}

test('Google issuer delegation supports confidential PKCE login and repeat refresh without replacement refresh tokens',{timeout:testDeadline(20000)},async t=>{
  const f=await delegatedIssuer(t);await f.create('dynamic',true);await assert.rejects(f.accounts.connect('dynamic'),{code:'OAUTH_REGISTRATION'});
  await f.create();const {authorization,callback}=await f.login();
  assert.equal(authorization.origin,'https://accounts.google.com');assert.equal(authorization.pathname,'/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('access_type'),'offline');assert.equal(authorization.searchParams.get('prompt'),'consent');
  assert.equal(authorization.searchParams.get('scope'),f.scope);assert.equal(authorization.searchParams.get('resource'),f.resource);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await fetch(callback)).status,200);assert.equal(f.observed.exchange,1);
  const binding=f.accounts.binding('google',f.resource,[f.scope]);assert.equal(await f.accounts.token(binding),'synthetic-access-initial');
  for(let count=1;count<=2;count++){f.advance(61000);assert.equal(await f.accounts.token(binding),`synthetic-access-${count}`);assert.equal(f.accounts.get('google').epoch,binding.epoch);}
  assert.equal(f.observed.refresh,2);assert(!JSON.stringify(f.accounts.list()).includes('synthetic-'));
  const disconnected=await f.accounts.disconnect('google');assert.equal(disconnected.remoteRevocation,'succeeded');assert.equal(f.observed.revocation,1);
  assert(!String(await readFile(join(f.root,'accounts','private.json'))).includes('synthetic-refresh'));
});

test('delegated endpoints require exact issuer/resource metadata and reject downgrade, loopback and redirect escape',{timeout:testDeadline(20000)},async t=>{
  const f=await delegatedIssuer(t);await f.create();
  f.metadata.issuer='https://unselected.example';await assert.rejects(f.accounts.connect('google'));assert.equal(f.observed.exchange,0);f.metadata.issuer='https://accounts.google.com';
  f.resourceMetadata.resource='https://gmailmcp.googleapis.com/other';await assert.rejects(f.accounts.connect('google'),{code:'OAUTH_RESOURCE'});f.resourceMetadata.resource=f.resource;
  for(const endpoint of ['http://127.0.0.1:4329/token','https://127.0.0.1/token','https://localhost/token','https://[::ffff:127.0.0.1]/token']){
    f.metadata.token_endpoint=endpoint;await assert.rejects(f.accounts.connect('google'),{code:'OAUTH_ENDPOINT'});assert(!f.requests.some(request=>request.url===new URL(endpoint).href));
  }
  f.metadata.token_endpoint='https://oauth2.googleapis.com/token';f.behavior.redirectToken=true;
  const {callback}=await f.login();assert.equal((await fetch(callback)).status,400);assert.equal(f.accounts.get('google').errorCode,'OAUTH_REDIRECT');assert.equal(f.observed.exchange,0);assert(!f.requests.some(request=>request.url.startsWith('https://unselected.example/')));
  f.behavior.redirectToken=false;assert.equal((await fetch((await f.login()).callback)).status,200);assert.equal(f.accounts.get('google').status,'connected');
});

test('disconnect honors separate revocation client methods and retains local revocation when a method is unsupported',{timeout:testDeadline(20000)},async t=>{
  const f=await delegatedIssuer(t);await f.create();f.behavior.revocationMethods=['client_secret_post'];
  assert.equal((await fetch((await f.login()).callback)).status,200);
  const binding=f.accounts.binding('google',f.resource,[f.scope]);
  assert.equal((await f.accounts.disconnect('google')).remoteRevocation,'succeeded');assert.equal(f.observed.revocation,1);
  await assert.rejects(f.accounts.token(binding),{code:'ACCOUNT_BINDING_REVOKED'});
  f.behavior.revocationMethods=['private_key_jwt'];assert.equal((await fetch((await f.login()).callback)).status,200);
  const result=await f.accounts.disconnect('google');assert.equal(result.remoteRevocation,'failed');assert.equal(result.account.status,'disconnected');assert.equal(result.account.errorCode,'OAUTH_REVOCATION_FAILED');
  assert.equal(f.observed.revocation,1,'Unsupported revocation methods never dispatch credentials');
  assert(!String(await readFile(join(f.root,'accounts','private.json'))).includes('synthetic-refresh'));
});
