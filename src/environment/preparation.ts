import {z} from 'zod';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {Actor,type Actor as Caller} from '../caller.ts';
import {Operation as Receipt} from '../operations.ts';
import {ConnectionDefinition,RecordSchemas,RackFault,type Revision,type Component,type ConnectionRevision,type RackConfig,type AccessGrant} from './contracts.ts';
import {PreparationInput,PreparationResult,CapabilitySpec,SourceSpec,ContinueInput,ValidationInput,ValidationResult,Inspection,CapabilityCompleteInput,CapabilityAddInput,type PreparationSummary,type ComponentView,type PendingAction} from './preparation-contracts.ts';
import {RackStore,digest,json} from './storage.ts';

const Selection=z.object({componentId:z.string(),definition:ConnectionDefinition.optional(),releaseId:z.string().optional()}).strict();
const Plan=z.object({id:z.string(),kind:z.enum(['environment','capability']).default('environment'),actor:Actor,input:PreparationInput,result:PreparationResult,selections:z.array(Selection),candidates:z.record(z.string(),z.string()),phase:z.enum(['preparation','settled','interrupted'])}).strict();
type Plan=z.infer<typeof Plan>;
RecordSchemas['preparation-plan']=Plan;
RecordSchemas['preparation-operation']=Receipt;
RecordSchemas['validation']=ValidationResult;

/** The owner supplies durable catalog/access operations. Preparation never exposes their
 * ordering to a CLI, starts inference, or repurposes a caller's request identity. */
export interface PreparationOwner {
 source(spec:CapabilitySpec,signal:AbortSignal,candidates:Record<string,string>):Promise<{definition:ConnectionDefinition,source:SourceSpec,defaults:string[]}>;
 register(id:string,name:string,definition:ConnectionDefinition,actor:Caller,previous?:{capabilityId:string,revisionId:string}):Promise<ConnectionRevision>;
 registered(id:string):ConnectionRevision|undefined;
 /** Prepare reusable capability dependencies without creating runtime membership. */
 dependencies(component:Component,signal:AbortSignal,candidates:Record<string,string>):Promise<void>;
 git(id:string,spec:CapabilitySpec,actor:Caller,registered:(catalogId:string)=>void):Promise<string>;
 publish(id:string,input:PreparationInput,environmentId:string,components:Component[],actor:Caller):Promise<Revision>;
 apply(id:string,environmentId:string,revisionId:string,actor:Caller,signal:AbortSignal,candidates:Record<string,string>):Promise<Array<{componentId:string,error:string|null,errorCode?:string,readiness:string}>>;
 revision(id:string,revision?:string):Promise<Revision>;
 describe(revision:Revision):Promise<ComponentView[]>;
 acquire(id:string,revision:Revision,workspace:string):Promise<AccessGrant>;
 release(id:string):Promise<void>;
}
const identity=(id:string,part:string)=>`p-${digest(`${id}:${part}`).slice(0,40)}`;
const sameActor=(a:Caller,b:Caller)=>a.kind===b.kind&&a.id===b.id;
const detail=(error:unknown)=>error instanceof RackFault?{code:error.code,message:error.message}:{code:'PREPARATION_FAILED',message:'Preparation failed; inspect the retained operation'};
const authenticationFailure=(code:string)=>/AUTH|CREDENTIAL|ACCOUNT|OAUTH/.test(code);
const replacementCodes=new Set(['SOURCE_RUNTIME','REQUIREMENT_UNSUPPORTED','RESOURCE_REQUIREMENT','PACKAGE_BUILD_AUTHORITY','PACKAGE_VERSION','OCI_REQUIREMENT','STORAGE_UNDECLARED','ACCOUNT_BINDING','ACCOUNT_BINDING_REVOKED','ACCOUNT_RESOURCE','ACCOUNT_RESOURCE_CONFLICT','AUTHENTICATION_CONFLICT']);

/** Durable plan, actor attribution and continuation are one boundary. Only an explicit
 * continuation retries a settled failure. Inspection and client disconnects have no effects. */
export class Preparation {
 private pending=new Map<string,Promise<unknown>>();
 private controllers=new Map<string,AbortController>();
 private config:RackConfig;private store:RackStore;private port:PreparationOwner;
 constructor(config:RackConfig,store:RackStore,port:PreparationOwner){this.config=config;this.store=store;this.port=port;}
 async recover(){for(const plan of this.store.list<Plan>('preparation-plan'))if(plan.phase==='preparation'){
  plan.phase='interrupted';plan.result.status='blocked';plan.result.version++;
  plan.result.actions=[{id:'interrupted',componentId:null,code:'PREPARATION_INTERRUPTED',message:'Daemon stopped during preparation. Continue explicitly after reviewing retained effects; adapters reconcile their exact artifacts.',actor:'owner',kind:'review',next:`harnessctl operation get environment:${plan.id} --details`}];
  this.store.put('preparation-plan',plan.id,plan);this.update(plan);
 }
 for(const receipt of this.store.list<Receipt>('preparation-operation')){
  if(receipt.command==='environment.validate'&&(receipt.state==='running'||receipt.state==='uncertain'||receipt.error?.code==='VALIDATION_CLEANUP_PENDING')){
   try{
    const {recoverMcpValidation}=await import('../../harness/mcp-validation.ts');
    await recoverMcpValidation(join(this.config.stateRoot,'validation',receipt.requestId),this.validationLimits());
    await this.port.release(identity(receipt.requestId,'validation'));
    const observation=this.store.get<ValidationResult>('validation',receipt.requestId);
    if(observation){for(const component of observation.components)component.cleanup='settled';this.store.put('validation',receipt.requestId,observation);receipt.result=JSON.parse(json(observation));}
    receipt.state='uncertain';receipt.error={code:'VALIDATION_INTERRUPTED',message:'Validation ownership settled after restart; functional effects are not repeated automatically'};
   }catch{receipt.state='failed';receipt.error={code:'VALIDATION_CLEANUP_PENDING',message:'Prior validation ownership could not be settled; access remains retained'};console.error(json({event:'environment.validation.cleanup.pending',operationId:receipt.requestId}));}
   this.putReceipt(receipt);
  }else if(receipt.state==='running'){
  receipt.state='uncertain';receipt.error={code:'OPERATION_INTERRUPTED',message:'Daemon interrupted this operation; inspect retained effects before continuing'};this.store.put('preparation-operation',receipt.requestId,receipt);
 }}}
 operation(id:string){return this.store.get<Receipt>('preparation-operation',id);}
 /** Retained declarations are selected only by exact catalog identity. Callers may
  * supply proven compatible ancestors, newest first, after checking their definitions. */
 declarations(id:string,revisions:Array<string|null>,scope:'any'|'capability'='any'):ComponentView|undefined{
  const known=this.store.list<Plan>('preparation-plan').filter(plan=>scope==='any'||plan.kind==='capability').flatMap(plan=>plan.result.components);
  for(const revision of revisions){const view=known.findLast(component=>component.capabilityId===id&&component.capabilityRevisionId===revision);if(view)return structuredClone(view);}
 }
 /** Older compound plans generated a display name from internal identities. Correct
  * that exact derived value at the read boundary without rewriting durable revisions. */
 displayName(id:string,revision:string,name:string):string{
  for(const plan of this.store.list<Plan>('preparation-plan')){
   const view=plan.result.components.find(component=>component.capabilityId===id&&component.capabilityRevisionId===revision);
   if(view&&name===`${view.name} (${plan.result.environmentId}/${view.id})`)return view.name;
  }
  return name;
 }
 /** Listing retained work never resumes it or depends on successful publication. */
 attention():PreparationSummary[]{
  return this.store.list<Plan>('preparation-plan').filter(plan=>plan.kind==='capability'||['preparing','blocked','partial'].includes(plan.result.status)).map(plan=>({name:plan.input.name,description:plan.input.description,...plan.input.target?{target:plan.input.target,expectRevision:plan.input.expectRevision}:{},result:{...structuredClone(plan.result),components:plan.result.components.map(component=>this.observation(component))}}));
 }
 /** A retained account failure is no evidence of missing software. Interpret that
  * observation without rewriting its historical receipt or claiming a successful check. */
 private observation(component:ComponentView):ComponentView{
  const view=structuredClone(component);
  if(view.error&&authenticationFailure(view.error.code)){
   view.evidence.authentication='action-needed';
   if(view.evidence.dependencies==='unavailable')view.evidence.dependencies='unprepared';
  }
  return view;
 }
 private putReceipt(receipt:Receipt){this.store.put('preparation-operation',receipt.requestId,receipt);}
 private begin(id:string,actor:Caller,command:string,input:unknown):Receipt{
  const prior=this.operation(id);
  if(prior){if(!sameActor(prior.actor,actor)||prior.command!==command||json(prior.input)!==json(input))throw new RackFault('OPERATION_CONFLICT','Request identity belongs to different input or actor');return prior;}
  const value:Receipt={reference:`environment:${id}`,requestId:id,actor,command,input:JSON.parse(json(input)),state:'running',result:null,error:null,attempts:[{at:Date.now(),state:'running'}]};this.putReceipt(value);return value;
 }
 private async serial<T>(id:string,work:()=>Promise<T>):Promise<T>{
  const previous=this.pending.get(id)??Promise.resolve();const task=previous.catch(()=>{}).then(work);this.pending.set(id,task);
  try{return await task;}finally{if(this.pending.get(id)===task)this.pending.delete(id);}
 }
 private specs(input:PreparationInput):{components:CapabilitySpec[],defaults:string[]}{
  if(input.components){
   const defaults:string[]=[];
   const components=input.components.map(spec=>{
    // Referenced credentials must expose the owner setup UI even when a caller
    // omitted the authentication declaration. Runtime paths are not credentials.
    const fields=spec.connection.kind==='http'?spec.connection.headers:spec.connection.env;
    const referenced=Object.values(fields).some(value=>[...value.matchAll(/\$\{([^}]+)\}/g)].some(match=>!['POLARITON_WORKSPACE','POLARITON_RUNTIME','POLARITON_DATA'].includes(match[1]!)));
    if(spec.authentication.kind!=='none'||!referenced)return spec;
    defaults.push(`${spec.name}: private references select static authentication`);
    return {...spec,authentication:{kind:'static' as const}};
   });
   return {components,defaults};
  }
  let source:SourceSpec;
  if(typeof input.source!=='string')source=SourceSpec.parse(input.source);
  else{
   const text=input.source;
   if(/^https?:\/\//.test(text))source={kind:'endpoint',url:text};
   else if(text.startsWith('oci:'))source={kind:'oci',image:text.slice(4)};
   else{
    const match=/^(npm|pypi|nuget|cargo):(.+)@([^@/]+)$/.exec(text);
    if(!match)throw new RackFault('SOURCE_SYNTAX','Use npm:PACKAGE@VERSION, pypi:PACKAGE@VERSION, nuget:PACKAGE@VERSION, cargo:CRATE@VERSION, oci:IMAGE or an HTTP endpoint; bundles and Git use --input',400);
    source=SourceSpec.parse({kind:match[1],identifier:match[2],version:match[3]});
   }
  }
  const local=source.kind!=='endpoint'&&source.kind!=='oci'&&source.kind!=='git';
  const browser=source.kind==='npm'&&source.identifier==='@playwright/mcp';
  const spec=CapabilitySpec.parse({id:'tool',name:input.name,source,runtime:{kind:local?'local':source.kind==='endpoint'?'external':'container'},connection:source.kind==='endpoint'||source.kind==='git'?{kind:'http',...(source.kind==='endpoint'?{url:source.url}:{}),headers:{}}:{kind:'stdio',args:browser?['--headless','--isolated','--browser','chromium']:[],env:{}},requirements:{assets:browser?[{kind:'playwright-browser',browser:'chromium'}]:[]},authentication:{kind:'none'}});
  return {components:[spec],defaults:[`Runtime: ${spec.runtime.kind}`,`Connection: ${spec.connection.kind}`,...browser?['Playwright: matching Chromium asset, headless, isolated profile']:[]]};
 }
 private view(spec:CapabilitySpec):ComponentView{return {...spec,catalogId:null,capabilityId:null,capabilityRevisionId:null,error:null,evidence:{registered:false,dependencies:'unprepared',connection:'untested',tools:[],authentication:spec.authentication.kind==='none'?'not-required':spec.authentication.kind==='static'?'referenced':'action-needed',checks:spec.checks.map(check=>({name:check.name,status:'not-run'})),observedAt:null}};}
 preview(raw:PreparationInput):PreparationResult{
  const input=PreparationInput.parse(raw),{components,defaults}=this.specs(input);
  if(components.length>this.config.maxImportEntries)throw new RackFault('PREPARATION_LIMIT','Too many capability components');
  const resources=new Map<string,Set<string>>();
  for(const spec of components)if(spec.authentication.kind==='oauth'&&spec.source.kind==='endpoint'&&spec.connection.kind==='http'){
   const selected=resources.get(spec.authentication.connectionId)??new Set<string>();selected.add(new URL(spec.connection.url??spec.source.url).href);resources.set(spec.authentication.connectionId,selected);
  }
  const actions=components.flatMap<PendingAction>(spec=>{
   const valid=spec.source.kind==='endpoint'?spec.runtime.kind==='external'&&spec.connection.kind==='http':spec.source.kind==='oci'?spec.runtime.kind==='container'&&spec.connection.kind==='stdio':spec.source.kind==='git'?spec.runtime.kind==='container'&&spec.connection.kind==='http':spec.runtime.kind==='local'&&spec.connection.kind==='stdio';
   const supported=valid&&(!spec.runtime.configuration||spec.source.kind==='git')&&(!spec.requirements.storage||spec.runtime.kind==='local')&&(spec.source.kind!=='git'||spec.authentication.kind==='none')&&(spec.authentication.kind!=='oauth'||spec.source.kind==='endpoint');
   if(!supported)return [{id:`runtime-${spec.id}`,componentId:spec.id,code:'SOURCE_RUNTIME',message:'The selected source/runtime/connection, authentication or storage combination is unsupported',actor:'initiator' as const,kind:'review' as const,next:'Submit a new preparation with a supported complete specification'}];
   const unsupported=spec.requirements.assets.length&&spec.source.kind!=='npm'?'Browser assets require the npm preparation recipe':spec.requirements.nativeBuild&&spec.source.kind!=='cargo'?'Native builds require the explicit Cargo recipe':spec.source.kind==='endpoint'&&spec.requirements.identityFiles.length?'External endpoints do not support local executable identity requirements':spec.source.kind==='git'&&(spec.requirements.files.length||spec.requirements.identityFiles.length)?'Git runtime prerequisites belong in the committed build recipe':spec.source.kind==='git'&&spec.connection.kind==='http'&&(spec.connection.url||Object.keys(spec.connection.headers).length)?'Managed Git connections derive their endpoint and authentication from the installed release':null;
   if(unsupported)return [{id:`requirements-${spec.id}`,componentId:spec.id,code:'REQUIREMENT_UNSUPPORTED',message:unsupported,actor:'initiator',kind:'review',next:'Submit a complete specification whose requirements are supported by its source adapter'}];
   if(spec.authentication.kind==='static'&&!Object.values(spec.connection.kind==='http'?spec.connection.headers:spec.connection.env).some(value=>[...value.matchAll(/\$\{([^}]+)\}/g)].some(match=>!['POLARITON_WORKSPACE','POLARITON_RUNTIME','POLARITON_DATA'].includes(match[1]!))))return [{id:`authentication-${spec.id}`,componentId:spec.id,code:'AUTHENTICATION_CONFLICT',message:'Static authentication requires private credential references in the connection',actor:'owner' as const,kind:'review' as const,next:`Open Environment → Capabilities → ${spec.name} → Authentication settings or revise the connection references`}];
   if(spec.authentication.kind==='oauth'&&(resources.get(spec.authentication.connectionId)?.size??0)>1)return [{id:`account-${spec.id}`,componentId:spec.id,code:'ACCOUNT_RESOURCE_CONFLICT',message:`Account connection ${spec.authentication.connectionId} is assigned to different service URLs. Use a separate connection ID for each resource.`,actor:'owner' as const,kind:'review' as const,next:`Open Environment → Capabilities → ${spec.name} → Authentication settings and choose this resource's account connection ID`}];
   return [];
  });
  return {status:'preview',version:0,environmentId:input.target??'unreserved',revisionId:null,components:components.map(spec=>this.view(spec)),actions,defaults:[...defaults,'Remote selections and host prerequisites are unresolved until preparation'],connection:'untested',operationId:'unreserved'};
 }
 async prepare(id:string,actor:Caller,raw:PreparationInput):Promise<PreparationResult>{
  const input=PreparationInput.parse(raw);if(input.preview)return this.preview(input);
  const preview=this.preview(input);
  return this.serial(id,async()=>{
   const prior=this.operation(id);this.begin(id,actor,'environment.prepare',input);
   if(prior){const saved=this.store.get<Plan>('preparation-plan',id);if(saved)return saved.result;throw new RackFault('PREPARATION_INTERRUPTED','Request was admitted before planning; inspect its receipt');}
   const result=preview;result.status='preparing';result.operationId=`environment:${id}`;result.environmentId=input.target??identity(id,'environment');result.defaults=result.defaults.filter(v=>!v.startsWith('Remote selections'));
   const plan:Plan={id,kind:'environment',actor,input,result,selections:[],candidates:{},phase:'preparation'};this.store.put('preparation-plan',id,plan);
   if(result.actions.length){plan.phase='settled';result.status='blocked';this.update(plan);return result;}
   return this.work(plan);
  });
 }
 /** Retain intent first. A source draft is independently addressable even while
  * installation, authentication or the container runtime is unavailable. */
 async add(id:string,actor:Caller,raw:CapabilityAddInput):Promise<PreparationResult>{
  const input=CapabilityAddInput.parse(raw);
  const normalized=PreparationInput.parse({name:input.name,description:input.description,...input.specification?{components:[{...input.specification,name:input.name}]}:{source:input.source}});
  const result=this.preview(normalized);
  return this.serial(id,async()=>{
   const prior=this.operation(id);this.begin(id,actor,'capability.add',input);
   if(prior){const saved=this.store.get<Plan>('preparation-plan',id);if(saved)return saved.result;throw new RackFault('PREPARATION_INTERRUPTED','Request was admitted before planning; inspect its receipt');}
   result.status=result.actions.length?'blocked':'draft';result.operationId=`environment:${id}`;result.environmentId=null;
   const plan:Plan={id,kind:'capability',actor,input:normalized,result,selections:[],candidates:{},phase:'settled'};this.update(plan);return result;
  });
 }
 private update(plan:Plan){
  this.store.put('preparation-plan',plan.id,plan);
  const receipt=this.operation(plan.id)!;receipt.state=plan.result.status==='ready'?'succeeded':plan.result.status==='preparing'?'running':plan.result.status==='partial'?'partial':plan.result.status==='cancelled'?'failed':'waiting';receipt.result=JSON.parse(json(plan.result));receipt.error=plan.result.status==='cancelled'?{code:'PREPARATION_CANCELLED',message:'Preparation was explicitly cancelled'}:null;this.putReceipt(receipt);
 }
 private action(plan:Plan,componentId:string|null,error:{code:string,message:string}){
  const component=plan.result.components.find(view=>view.id===componentId),authentication=authenticationFailure(error.code);
  if(replacementCodes.has(error.code))return {id:identity(plan.id,`${componentId}:${error.code}`),componentId,...error,actor:authentication?'owner':'initiator',kind:'review',next:authentication&&component&&!component.capabilityId?`Open Environment → Capabilities → ${component.name} → Authentication settings; capability complete can amend this unregistered component's authentication`:'Submit a new complete preparation/revision with the corrected source, requirements or account binding; continuation cannot change the approved plan'} as PendingAction;
  const tool=/\b(node|npm|uv|python|dotnet|cargo|rustc)\b/.exec(error.message)?.[1] as PendingAction['tool'];
  const toolchain=/TOOL_MISSING/.test(error.code)&&!!tool;
  return {id:identity(plan.id,`${componentId??'plan'}:${error.code}`),componentId,...error,actor:authentication?'owner':'initiator',kind:authentication?'authentication':toolchain?'toolchain':'retry',...(toolchain?{tool}:{}),next:authentication?`Open Environment → Capabilities → ${component?.name??plan.input.name} and set up or connect the selected account`:`harnessctl operation continue environment:${plan.id} --input resolution.json`} as PendingAction;
 }
 /** Login failure does not invalidate installed bytes or prove missing dependencies.
  * Keep those observations independent while retaining the exact recovery cause. */
 private failedComponent(plan:Plan,view:ComponentView,error:{code:string,message:string}){
  view.error=error;
  if(authenticationFailure(error.code))view.evidence.authentication='action-needed';
  else view.evidence.dependencies='unavailable';
  plan.result.actions.push(this.action(plan,view.id,error));
 }
 /** Original source/effect authority stays immutable. Only attributed owner
  * authentication amendments live in the effective component view. */
 private effective(plan:Plan):PreparationInput{return {...plan.input,source:undefined,components:this.specs(plan.input).components.map(spec=>({...spec,authentication:plan.result.components.find(view=>view.id===spec.id)!.authentication}))};}
 /** Resolve one exact component and retain its selection before registration.
  * Both full preparation and capability setup share these recovery identities.
  * Standalone setup also prepares dependencies, without creating runtime membership. */
 private async resolveComponent(plan:Plan,view:ComponentView,signal:AbortSignal):Promise<Component>{
  signal.throwIfAborted();view.error=null;
  let selection=plan.selections.find(s=>s.componentId===view.id);
  if(!selection){
   const {catalogId,capabilityId,capabilityRevisionId,evidence,error,...spec}=view;
   if(spec.source.kind==='git')selection={componentId:view.id,releaseId:await this.port.git(identity(plan.id,`git:${view.id}`),spec,plan.actor,catalogId=>{view.catalogId=catalogId;view.evidence.registered=true;this.update(plan);})};
   else{const resolved=await this.port.source(spec,signal,plan.candidates);view.source=resolved.source;plan.result.defaults.push(...resolved.defaults);selection={componentId:view.id,definition:resolved.definition};}
   plan.selections.push(selection);this.update(plan);
  }
  let component:Component;
  if(selection.definition){
   const base=plan.input.target?await this.port.revision(plan.input.target,plan.input.expectRevision):undefined,previous=base?.components.find(component=>component.id===view.id);
   const cap=await this.port.register(identity(plan.id,`capability:${view.id}`),view.name,selection.definition,plan.actor,previous&&'definition'in previous?previous.definition:undefined);
   view.catalogId=cap.id;view.capabilityId=cap.id;view.capabilityRevisionId=cap.revisionId;if(view.authentication.kind==='oauth')view.evidence.authentication='connected';view.evidence.registered=true;
   component={id:view.id,name:view.name,definition:{capabilityId:cap.id,revisionId:cap.revisionId},...(view.requirements.resource?{resource:view.requirements.resource}:{})};
  }else{
   view.capabilityId=selection.releaseId!;view.evidence.registered=true;
   component={id:view.id,name:view.name,releaseId:selection.releaseId!,configuration:view.runtime.configuration??{},...(view.requirements.resource?{resource:view.requirements.resource}:{})};
  }
  if(plan.kind==='capability'){await this.port.dependencies(component,signal,plan.candidates);view.evidence.dependencies='ready';view.evidence.observedAt=new Date().toISOString();}
  return component;
 }
 /** Complete one pending capability without publishing or applying its parent.
  * Owner authentication changes are durable and attributed even when login is
  * still missing. Sibling source resolution is never part of this operation. */
 async complete(id:string,actor:Caller,raw:CapabilityCompleteInput):Promise<PreparationResult>{
  const input=CapabilityCompleteInput.parse(raw),target=input.target.slice('environment:'.length);
  return this.serial(target,async()=>{
   const existing=this.operation(id);this.begin(id,actor,'capability.complete',input);
   if(existing){if(existing.result)return PreparationResult.parse(existing.result);throw new RackFault(existing.error?.code??'OPERATION_UNCERTAIN',existing.error?.message??'Capability completion was interrupted; inspect the parent operation');}
   const receipt=this.operation(id)!;
   try{
    const plan=this.store.get<Plan>('preparation-plan',target);if(!plan)throw new RackFault('NOT_FOUND','Preparation operation does not exist',404);
    if(plan.result.version!==input.expectedVersion)throw new RackFault('STALE_OPERATION','Preparation version changed');
    const view=plan.result.components.find(component=>component.id===input.componentId);if(!view)throw new RackFault('NOT_FOUND','Pending capability component does not exist',404);
    if(input.authentication!==undefined||view.authentication.kind!=='none'){
     if(actor.kind!=='owner')throw new RackFault('ACTOR_DENIED','Capability authentication requires the administrative owner',403);
    }else if(actor.kind!=='owner'&&!sameActor(plan.actor,actor))throw new RackFault('ACTOR_DENIED','Only the initiator or administrative owner may complete this capability',403);
    const registered=this.port.registered(identity(plan.id,`capability:${view.id}`));
    if(registered&&!view.capabilityId){view.catalogId=registered.id;view.capabilityId=registered.id;view.capabilityRevisionId=registered.revisionId;view.evidence.registered=true;plan.result.version++;this.update(plan);}
    if((view.capabilityId&&plan.kind==='environment')||((view.catalogId||view.capabilityId)&&input.authentication!==undefined)||plan.result.revisionId||!(plan.kind==='capability'?['draft','blocked','partial','failed','cancelled']:['blocked','partial']).includes(plan.result.status))throw new RackFault('CAPABILITY_REGISTERED','Use the registered capability to change its authentication');
    if(input.authentication){view.authentication=input.authentication;plan.selections=plan.selections.filter(selection=>selection.componentId!==view.id);view.evidence.authentication=input.authentication.kind==='none'?'not-required':input.authentication.kind==='static'?'referenced':'action-needed';}
    const controller=new AbortController();this.controllers.set(plan.id,controller);const timer=setTimeout(()=>controller.abort(new RackFault('PREPARATION_TIMEOUT','Capability completion exceeded its operation budget')),this.config.operationTimeoutMs);
    plan.phase='preparation';plan.result.status='preparing';plan.result.version++;view.error=null;
    const review=this.preview(this.effective(plan));
    view.authentication=review.components.find(component=>component.id===view.id)!.authentication;
    view.evidence.authentication=view.authentication.kind==='none'?'not-required':view.authentication.kind==='static'?'referenced':'action-needed';
    plan.result.actions=plan.kind==='capability'?[]:plan.result.actions.filter(action=>action.componentId!==view.id&&!['SOURCE_RUNTIME','REQUIREMENT_UNSUPPORTED','ACCOUNT_RESOURCE_CONFLICT','AUTHENTICATION_CONFLICT','CAPABILITY_COMPLETED'].includes(action.code));plan.result.actions.push(...review.actions);
    this.update(plan);
    let completed=false;
    try{
     if(!review.actions.some(action=>action.componentId===view.id)){await this.resolveComponent(plan,view,controller.signal);completed=true;}
    }catch(error){this.failedComponent(plan,view,detail(error));}
    finally{
     clearTimeout(timer);this.controllers.delete(plan.id);plan.phase='settled';plan.result.status=controller.signal.aborted?'cancelled':plan.kind==='capability'&&completed?'ready':'blocked';plan.result.version++;
     if(view.capabilityId&&plan.kind==='environment')plan.result.actions.push({id:identity(plan.id,'capability-completed'),componentId:null,code:'CAPABILITY_COMPLETED',message:'Capability registered. Continue the parent preparation explicitly to publish and apply its composition.',actor:'owner',kind:'retry',next:`harnessctl operation continue environment:${plan.id} --help`});
     this.update(plan);
    }
    receipt.result=JSON.parse(json(plan.result));receipt.state='succeeded';this.putReceipt(receipt);return PreparationResult.parse(receipt.result);
   }catch(error){receipt.state='failed';receipt.error=detail(error);this.putReceipt(receipt);throw error;}
  });
 }
 private async work(plan:Plan):Promise<PreparationResult>{
  const controller=new AbortController();this.controllers.set(plan.id,controller);const timer=setTimeout(()=>controller.abort(new RackFault('PREPARATION_TIMEOUT','Preparation exceeded its operation budget')),this.config.operationTimeoutMs);
  plan.phase='preparation';plan.result.status='preparing';plan.result.actions=[];plan.result.version++;this.update(plan);
  try{
   const review=this.preview(this.effective(plan));
   if(review.actions.length){plan.result.actions=review.actions;plan.result.status='blocked';return plan.result;}
   const components:Component[]=[];
   for(const view of plan.result.components){
    controller.signal.throwIfAborted();view.error=null;
    try{
     components.push(await this.resolveComponent(plan,view,controller.signal));
    }catch(error){this.failedComponent(plan,view,detail(error));}
    this.update(plan);
   }
   controller.signal.throwIfAborted();
   // A blocked definition cannot silently disappear from the intended composition.
   if(components.length!==plan.result.components.length||plan.result.actions.length){plan.result.status='blocked';return plan.result;}
   if(plan.kind==='capability'){plan.result.status='ready';return plan.result;}
   const revision=await this.port.publish(identity(plan.id,'revision'),plan.input,plan.result.environmentId!,components,plan.actor);plan.result.revisionId=revision.revisionId;this.update(plan);
   const outcomes=await this.port.apply(identity(plan.id,`apply:${plan.result.version}`),revision.environmentId,revision.revisionId,plan.actor,controller.signal,plan.candidates);
   for(const view of plan.result.components){const outcome=outcomes.find(o=>o.componentId===view.id);view.evidence.observedAt=new Date().toISOString();if(outcome?.error)this.failedComponent(plan,view,{code:outcome.errorCode??'PREPARATION_UNAVAILABLE',message:outcome.error});else view.evidence.dependencies=outcome?'ready':'unavailable';}
   plan.result.status=plan.result.actions.length?'partial':'ready';return plan.result;
  }catch(error){const failure=detail(error);plan.result.status=controller.signal.aborted?'cancelled':'blocked';plan.result.actions.push(this.action(plan,null,failure));return plan.result;}
  finally{clearTimeout(timer);this.controllers.delete(plan.id);plan.phase='settled';plan.result.version++;this.update(plan);}
 }
 async continue(id:string,actor:Caller,raw:ContinueInput):Promise<PreparationResult>{
  const input=ContinueInput.parse(raw),target=input.target.slice('environment:'.length);
  return this.serial(target,async()=>{
   const existing=this.operation(id);this.begin(id,actor,'operation.continue',input);if(existing){if(existing.result)return PreparationResult.parse(existing.result);throw new RackFault(existing.error?.code??'OPERATION_UNCERTAIN',existing.error?.message??'Continuation was interrupted; inspect its original operation');}
   const receipt=this.operation(id)!;
   try{
    const plan=this.store.get<Plan>('preparation-plan',target);if(!plan)throw new RackFault('NOT_FOUND','Preparation operation does not exist',404);
    const action=plan.result.actions.find(a=>a.id===input.actionId);
    if(action&&replacementCodes.has(action.code))throw new RackFault('RESOLUTION_SCOPE','A changed source, requirements or account binding requires a new reviewed preparation');
    if(!action||plan.result.version!==input.expectedVersion)throw new RackFault('STALE_OPERATION','Pending action or operation version changed');
    if(!sameActor(plan.actor,actor)&&!(actor.kind==='owner'&&action.actor==='owner'))throw new RackFault('ACTOR_DENIED','Only the initiator or owner resolving an owner action may continue this operation',403);
    if(input.resolution.kind==='toolchain'){
     if(action.kind!=='toolchain'||action.tool!==input.resolution.tool)throw new RackFault('RESOLUTION_SCOPE','Toolchain candidate must resolve this exact requirement');
     plan.candidates[input.resolution.tool]=input.resolution.path;
    }else if(input.resolution.kind==='authentication-complete'&&action.kind!=='authentication')throw new RackFault('RESOLUTION_SCOPE','This action is not an account connection');
    else if(input.resolution.kind==='retry'&&action.kind==='authentication')throw new RackFault('RESOLUTION_SCOPE','Complete the account connection before continuing');
    receipt.result=JSON.parse(json(await this.work(plan)));receipt.state='succeeded';this.putReceipt(receipt);return PreparationResult.parse(receipt.result);
   }catch(error){receipt.state='failed';receipt.error=detail(error);this.putReceipt(receipt);throw error;}
  });
 }
 async cancel(id:string,actor:Caller,target:string){
  const receipt=this.begin(id,actor,'operation.cancel',{target}),parent=target.replace(/^environment:/,'');
  if(receipt.result)return receipt.result as {cancelled:boolean,operation:string};
  try{
  const plan=this.store.get<Plan>('preparation-plan',parent);if(!plan)throw new RackFault('NOT_FOUND','Preparation operation does not exist',404);
  if(!sameActor(plan.actor,actor)&&actor.kind!=='owner')throw new RackFault('ACTOR_DENIED','Only initiator or owner can cancel preparation',403);
  this.controllers.get(parent)?.abort(new RackFault('PREPARATION_CANCELLED','Explicitly cancelled'));
  await this.pending.get(parent);
  const settled=this.store.get<Plan>('preparation-plan',parent)!;
  if(['draft','blocked','partial'].includes(settled.result.status)){settled.result.status='cancelled';settled.result.actions=[];settled.result.version++;settled.phase='settled';this.update(settled);}
  receipt.state='succeeded';receipt.result={cancelled:settled.result.status==='cancelled',operation:target};this.putReceipt(receipt);return receipt.result;
  }catch(error){receipt.state='failed';receipt.error=detail(error);this.putReceipt(receipt);throw error;}
 }
 async inspect(environmentId:string,revisionId?:string):Promise<Inspection>{
  const revision=await this.port.revision(environmentId,revisionId),plans=this.store.list<Plan>('preparation-plan').filter(p=>p.result.environmentId===environmentId&&p.result.revisionId===revision.revisionId);
  const latest=plans.at(-1);
  const observations=this.store.list<ValidationResult>('validation').filter(v=>v.environmentId===environmentId&&v.revisionId===revision.revisionId).sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
  const components=(latest?latest.result.components:await this.port.describe(revision)).map(component=>this.observation(component));
  if(!latest){
   const known=this.store.list<Plan>('preparation-plan').flatMap(plan=>plan.result.components);
   for(const component of components){const prepared=known.find(value=>value.capabilityId===component.capabilityId&&value.capabilityRevisionId===component.capabilityRevisionId);if(prepared){component.source=prepared.source;component.checks=structuredClone(prepared.checks);component.evidence.checks=prepared.checks.map(check=>({name:check.name,status:'not-run'}));}}
  }
  // Each observation has exact revision scope. Discovery refreshes connection facts;
  // it cannot erase a separately performed functional check or rewrite preparation.
  for(const observation of observations)for(const observed of observation.components){const component=components.find(c=>c.id===observed.componentId);if(!component)continue;component.evidence.connection=observed.connected?'connected':'failed';component.evidence.tools=observed.tools;component.evidence.observedAt=observation.observedAt;if(observed.check){const check=component.evidence.checks.find(c=>c.name===observed.check!.name);if(check)check.status=observed.check.status;}}
  return {environmentId,revisionId:revision.revisionId,name:revision.name,components,operations:plans.map(p=>`environment:${p.id}`),observations};
 }
 private validationLimits(){return {startupMs:this.config.startupTimeoutMs,callMs:this.config.observationTimeoutMs,cleanupMs:this.config.shutdownTimeoutMs,maxTools:this.config.maxArchiveEntries,maxChecks:this.config.maxBuildCommands,maxOutputBytes:this.config.maxObservationBytes};}
 async validate(id:string,actor:Caller,raw:ValidationInput):Promise<ValidationResult>{
  const input=ValidationInput.parse(raw);
  return this.serial(id,async()=>{
   const prior=this.operation(id),receipt=this.begin(id,actor,'environment.validate',input);if(prior){if(prior.result)return ValidationResult.parse(prior.result);throw new RackFault('VALIDATION_UNCERTAIN','An interrupted functional check must not be repeated automatically');}
   const directory=join(this.config.stateRoot,'validation',id);
   let result:ValidationResult|undefined,acquired=false;
   try{
    const revision=await this.port.revision(input.target,input.revision),view=await this.inspect(input.target,input.revision);
    if(input.check&&!view.components.some(c=>c.checks.some(k=>k.name===input.check)))throw new RackFault('CHECK_UNKNOWN','The selected revision declares no functional check with that name',400);
    if(view.components.flatMap(component=>component.checks.filter(check=>check.name===input.check).flatMap(check=>check.steps)).length>this.config.maxBuildCommands)throw new RackFault('CHECK_LIMIT','Functional check exceeds the configured validation step budget');
    await mkdir(directory,{recursive:true,mode:0o700});
    acquired=true;const grant=await this.port.acquire(identity(id,'validation'),revision,directory);
    const checks=view.components.flatMap(c=>{const server=grant.components.find(g=>g.componentId===c.id);if(!server||!grant.servers.some(value=>value.name===server.serverName))return [];return c.checks.filter(k=>k.name===input.check).flatMap(k=>k.steps.map((step,index)=>({name:`${c.id}:${k.name}:${index}`,serverName:server.serverName,toolName:step.tool,arguments:step.arguments})));});
    const {validateMcp}=await import('../../harness/mcp-validation.ts');
    const validated=await validateMcp({cwd:directory,servers:grant.servers,checks},this.validationLimits());
    result={environmentId:input.target,revisionId:input.revision,observedAt:new Date().toISOString(),scope:input.check?`functional:${input.check}`:'connection-and-discovery',components:grant.components.map(c=>{const server=validated.servers.find(s=>s.serverName===c.serverName),checks=validated.checks.filter(k=>k.serverName===c.serverName),requested=view.components.find(value=>value.id===c.componentId)?.checks.some(check=>check.name===input.check);return {componentId:c.componentId,connected:server?.connection==='connected',tools:server?.tools??[],check:requested?{name:input.check!,status:checks.length&&checks.every(k=>k.status==='passed')?'passed':'failed'}:null,error:checks.find(check=>check.code)?.code??server?.code??c.code??null,cleanup:validated.cleanup.status==='settled'?'settled':'pending'};})};
    if(validated.cleanup.status!=='settled')throw new RackFault('VALIDATION_CLEANUP_PENDING','Harness could not confirm validation process cleanup; access is retained');
    await this.port.release(identity(id,'validation'));acquired=false;
    this.store.put('validation',id,result);receipt.result=JSON.parse(json(result));receipt.state=result.components.every(c=>c.connected&&!c.error&&c.check?.status!=='failed')?'succeeded':'partial';this.putReceipt(receipt);return result;
   }catch(error){if(acquired&&(!result||result.components.every(c=>c.cleanup==='settled')))try{await this.port.release(identity(id,'validation'));}catch{if(result)for(const component of result.components)component.cleanup='pending';receipt.error={code:'VALIDATION_CLEANUP_PENDING',message:'Validation access cleanup remains pending'};}
    if(result){this.store.put('validation',id,result);receipt.result=JSON.parse(json(result));}receipt.state='failed';receipt.error??=detail(error);this.putReceipt(receipt);throw error;}
  });
 }
 async close(){for(const controller of this.controllers.values())controller.abort(new RackFault('SHUTTING_DOWN','Daemon is shutting down'));await Promise.allSettled(this.pending.values());}
}
