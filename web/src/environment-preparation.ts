import {CapabilitySpec,CapabilityAddInput,PreparationInput,PreparationResult,type Authentication,type ComponentView,type PreparationSummary} from '../../src/environment/preparation-contracts.ts';
import {Capability,ConnectionRevision,type Inventory} from '../../src/environment/contracts.ts';
import {Operation} from '../../src/operations.ts';
import {ApiError} from './api.ts';
import {z} from 'zod';
import type {AccountPublic} from '../../src/environment/account-contracts.ts';

export type AccountComponent=Pick<CapabilitySpec,'name'|'connection'|'authentication'>&{source?:CapabilitySpec['source'];bindingEpoch?:string};
const Identity=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/);
const CapabilitySelectionSchema=z.discriminatedUnion('kind',[z.object({kind:z.literal('capability'),id:Identity,revisionId:Identity.optional()}).strict(),z.object({kind:z.literal('pending'),operationId:z.string().regex(/^environment:[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/),componentId:Identity}).strict()]);
export type CapabilitySelection=z.infer<typeof CapabilitySelectionSchema>;
export type PendingCapability={plan:PreparationSummary;component:ComponentView};

/** Pending navigation follows retained component identity. Standalone setup stays
 * visible through dependency preparation; registration alone cannot hide its recovery.
 * A ready definition replaces only its own draft, never an equal name or source. */
export function pendingCapabilities(inventory:Inventory):PendingCapability[]{
 const registered=new Set(inventory.capabilities.map(value=>value.id));
 for(const release of inventory.releases)if(registered.has(release.packageId))registered.add(release.id);
 return inventory.preparations.flatMap(plan=>plan.result.components.filter(component=>plan.result.environmentId===null&&plan.result.status!=='ready'||!component.capabilityId||!registered.has(component.catalogId??component.capabilityId)).map(component=>({plan,component})));
}
/** Catalog selection exposes prepared standalone capabilities. A registered draft
 * still owns setup until it is ready; older completed managed releases stay usable. */
export function selectableCatalog(inventory:Pick<Inventory,'capabilities'|'releases'|'preparations'>):Pick<Inventory,'capabilities'|'releases'>{
 const components=inventory.preparations.filter(plan=>plan.result.environmentId===null&&plan.result.status!=='ready').flatMap(plan=>plan.result.components);
 const pending=new Set(components.flatMap(component=>component.capabilityId?[component.capabilityId]:[]));
 const packages=new Set([...components.flatMap(component=>component.catalogId?[component.catalogId]:[]),...inventory.releases.filter(release=>pending.has(release.id)).map(release=>release.packageId)]);
 return {
  capabilities:inventory.capabilities.filter(capability=>!pending.has(capability.id)&&!packages.has(capability.id)),
  releases:inventory.releases.filter(release=>!pending.has(release.id)&&!pending.has(release.packageId)),
 };
}
export function completedSelection(selection:CapabilitySelection,result:PreparationResult,inventory:Pick<Inventory,'releases'>):CapabilitySelection{
 if(selection.kind!=='pending'||selection.operationId!==result.operationId||result.environmentId===null&&result.status!=='ready')return selection;
 const component=result.components.find(value=>value.id===selection.componentId);
 if(component?.capabilityId&&component.capabilityRevisionId)return {kind:'capability',id:component.capabilityId,revisionId:component.capabilityRevisionId};
 if(component?.capabilityId&&component.catalogId)return {kind:'capability',id:component.catalogId};
 const release=inventory.releases.find(value=>value.id===component?.capabilityId);
 return release?{kind:'capability',id:release.packageId}:selection;
}
/** Reload restores an identity only. Its current state is always read from the owner. */
export function savedCapabilitySelection(value:string|null):CapabilitySelection|null{
 if(!value)return null;
 try{const parsed=CapabilitySelectionSchema.safeParse(JSON.parse(value));return parsed.success?parsed.data:null;}catch{}
 return null;
}
export type CapabilityRestoration=
 |{kind:'ready';selection:CapabilitySelection;pending:PendingCapability|null;capability:Capability|null}
 |{kind:'missing'|'failed';message:string};

/** Restore saved navigation from its owner without treating a filtered inventory or
 * a failed read as deletion. Only a confirmed missing identity may be forgotten;
 * retained completed plans still recover their exact registered capability. */
export async function restoreCapabilitySelection(selection:CapabilitySelection,inventory:Pick<Inventory,'capabilities'|'releases'|'preparations'>,read:(path:string)=>Promise<unknown>):Promise<CapabilityRestoration>{
 try{
  if(selection.kind==='pending'){
   const pendingSelection=selection;
   let plan=inventory.preparations.find(value=>value.result.operationId===pendingSelection.operationId);
   if(!plan){
    const receipt=Operation.parse(await read(`/environment/operations/${selection.operationId.slice('environment:'.length)}`));
    const result=PreparationResult.parse(receipt.result),input=receipt.command==='capability.add'?CapabilityAddInput.parse(receipt.input):PreparationInput.parse(receipt.input);
    if(receipt.reference!==selection.operationId||result.operationId!==selection.operationId)throw new Error('The returned preparation does not match the saved capability.');
    plan={name:input.name,description:input.description,...'target'in input?{target:input.target,expectRevision:input.expectRevision}:{},result};
   }
   const component=plan.result.components.find(value=>value.id===pendingSelection.componentId);
   if(!component)return {kind:'missing',message:'The saved capability is no longer in this preparation. Choose a capability from the sidebar or add one.'};
   const next=completedSelection(selection,plan.result,inventory);
   if(next.kind==='pending')return {kind:'ready',selection:next,pending:{plan,component},capability:null};
   selection=next;
  }
  const capabilitySelection=selection;
  const head=inventory.capabilities.find(value=>value.id===capabilitySelection.id);
  const capability=head&&(head.kind==='managed'||!selection.revisionId||head.revisionId===selection.revisionId)?head:selection.revisionId?ConnectionRevision.parse(await read(`/environment/capabilities/${selection.id}/revisions/${selection.revisionId}`)):Capability.parse(await read(`/environment/capabilities/${selection.id}`));
  if(capability.id!==selection.id||capability.kind!=='managed'&&selection.revisionId&&capability.revisionId!==selection.revisionId)throw new Error('The returned definition does not match the saved capability.');
  return {kind:'ready',selection,pending:null,capability};
 }catch(failure){
  if(failure instanceof ApiError&&failure.status===404&&['NOT_FOUND','OPERATION_NOT_FOUND'].includes(failure.code))return {kind:'missing',message:'The previously selected capability is not available in this installation. Choose a capability from the sidebar or add one.'};
  return {kind:'failed',message:failure instanceof z.ZodError?'The saved capability could not be read from the owner. Retry to load it again.':failure instanceof Error?failure.message:'The saved capability could not be loaded. Retry to load it again.'};
 }
}
/** Setup hints describe verified provider endpoints; they never initiate login or
 * turn an arbitrary Google API URL into a supported MCP resource. */
export function accountSetup(component:AccountComponent){
 const resource=component.connection.kind==='http'?(component.connection.url??(component.source?.kind==='endpoint'?component.source.url:'')):'';
 const google=['gmailmcp','drivemcp','calendarmcp','people','docsmcp','sheetsmcp','slidesmcp','chatmcp'].some(service=>resource===`https://${service}.googleapis.com/mcp/v1`);
 const values=Object.values(component.connection.kind==='http'?component.connection.headers:component.connection.env);
 const references=[...new Set(values.flatMap(value=>{const match=/^(?:Bearer |Basic )?\$\{([^}]+)\}$/.exec(value);return match&&!['POLARITON_WORKSPACE','POLARITON_RUNTIME','POLARITON_DATA'].includes(match[1]!)?[match[1]!]:[];}))];
 return {resource,google,issuer:google?'https://accounts.google.com':'',registration:google?'preregistered' as const:'dynamic' as const,references};
}
/** Public scopes are observed consent, not configuration. Missing consent must keep
 * Connect available; only incompatible identity or resource needs a new binding. */
export function accountMismatch(component:AccountComponent,account:AccountPublic):boolean{
 if(component.authentication.kind==='none')return false;
 if(component.authentication.kind!==account.kind)return true;
 const resource=accountSetup(component).resource;
 return component.authentication.kind==='oauth'&&(!resource||new URL(account.resource).href!==new URL(resource).href);
}
/** Catalog authentication is derived from the selected immutable definition. No
 * environment is synthesized to configure its private account. */
export function capabilityAccount(value:ConnectionRevision):AccountComponent{
 const authentication:Authentication=value.kind==='http'&&value.account?{kind:'oauth',connectionId:value.account.connectionId,scopes:value.account.scopes}:Object.keys(value.credentials).length?{kind:'static'}:{kind:'none'};
 return {name:value.name,authentication,...value.kind==='http'&&value.account?{bindingEpoch:value.account.epoch}:{},connection:value.kind==='http'?{kind:'http',url:value.url,headers:value.headers}:{kind:'stdio',args:value.args,env:value.env}};
}
/** Review inputs contain definitions only. Retained observations and operation identities
 * cannot become authority for a new request, and an update retains its original base. */
export function preparationDraft(value:{name:string;description:string;target?:string;expectRevision?:string;result:PreparationResult}):PreparationInput{
 return PreparationInput.parse({name:value.name,description:value.description,...value.target?{target:value.target,expectRevision:value.expectRevision}:{},components:value.result.components.map(specification)});
}
export function specification(value:ComponentView):CapabilitySpec{
 const {id,name,source,runtime,connection,requirements,authentication,checks}=value;
 return CapabilitySpec.parse({id,name,source,runtime,connection,requirements,authentication,checks});
}
/** Account setup cannot resolve a plan that aliases different protected resources. */
export function conflictingAccounts(components:CapabilitySpec[]):Set<string>{
 const resources=new Map<string,Set<string>>();
 for(const component of components){if(component.authentication.kind!=='oauth'||component.connection.kind!=='http'||component.source.kind!=='endpoint')continue;const id=component.authentication.connectionId,values=resources.get(id)??new Set<string>();values.add(new URL(component.connection.url??component.source.url).href);resources.set(id,values);}
 return new Set([...resources].filter(([,values])=>values.size>1).map(([id])=>id));
}
