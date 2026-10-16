import React,{useEffect,useState} from 'react';
import {Select} from './select.tsx';
import {CapabilityAccounts} from './environment-accounts.tsx';
import {Authentication,type PreparationResult} from '../../src/environment/preparation-contracts.ts';
import type {ConnectionRevision} from '../../src/environment/contracts.ts';
import {accountSetup,capabilityAccount,conflictingAccounts,type AccountComponent,type PendingCapability} from './environment-preparation.ts';

type Subject={kind:'pending';value:PendingCapability}|{kind:'registered';value:ConnectionRevision};
/** One capability owns its authentication workflow. Saving private account material,
 * recording a binding and composing an environment are separate owner decisions. */
export function CapabilityAuthentication({subject,active,pollMs,command,onPrepared,onAuthenticated}:{subject:Subject;active:boolean;pollMs:number;command:<T>(input:Record<string,unknown>)=>Promise<T>;onPrepared:(result:PreparationResult)=>void;onAuthenticated:(result:ConnectionRevision)=>void}){
 const original:AccountComponent=subject.kind==='pending'?subject.value.component:capabilityAccount(subject.value);
 const [authentication,setAuthentication]=useState(original.authentication),[scopeText,setScopeText]=useState(original.authentication.kind==='oauth'?original.authentication.scopes.join('\n'):''),[settingsOpen,setSettingsOpen]=useState(false),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[candidatePath,setCandidatePath]=useState('');
 useEffect(()=>{if(!dirty){setAuthentication(original.authentication);setScopeText(original.authentication.kind==='oauth'?original.authentication.scopes.join('\n'):'');}},[JSON.stringify(original.authentication),dirty]);
 const component={...original,authentication,...dirty?{bindingEpoch:undefined}:{}},setup=accountSetup(component);
 const conflict=subject.kind==='pending'&&authentication.kind==='oauth'&&conflictingAccounts(subject.value.plan.result.components.map(value=>value.id===subject.value.component.id?{...value,authentication}:value)).has(authentication.connectionId);
 useEffect(()=>{if(conflict)setSettingsOpen(true);},[conflict]);
 const fixed=subject.kind==='pending'&&Boolean(subject.value.component.catalogId??subject.value.component.capabilityId);
 const valid=Authentication.safeParse(authentication).success;
 const update=(next:Authentication)=>{if(next.kind==='oauth'&&authentication.kind!=='oauth')setScopeText(next.scopes.join('\n'));setAuthentication(next);setDirty(true);setError('');setNotice('');};
 const save=async()=>{if(busy||!valid)return;setBusy(true);setError('');setNotice('');try{
  if(subject.kind==='pending'){
   const {plan,component:selected}=subject.value,result=await command<PreparationResult>({kind:'capability.complete',input:{target:plan.result.operationId,expectedVersion:plan.result.version,componentId:selected.id,...dirty?{authentication}:{}}});
   const next=result.components.find(value=>value.id===selected.id);if(next)setAuthentication(next.authentication);setDirty(false);onPrepared(result);setNotice(result.status==='ready'||result.environmentId!==null&&next?.capabilityId?'Capability setup finished. Add it to an environment when needed.':result.status==='blocked'?'Setup needs attention. Review the requirements below.':'Setup saved. Continue when the required connection is available.');
  }else{
   const value=subject.value,result=await command<ConnectionRevision>({kind:'capability.authenticate',id:value.id,expectedBase:value.revisionId,authentication});setDirty(false);onAuthenticated(result);setNotice('Account binding saved. Environments keep their existing selected versions.');
  }
 }catch(failure){setError((failure as Error).message);}finally{setBusy(false);}};
 const pending=subject.kind==='pending'?subject.value:null;
 if(pending&&!['draft','blocked','partial','failed','cancelled'].includes(pending.plan.result.status))return <div><p>{pending.plan.result.status==='preparing'?'Preparation is in progress.':`This preparation is ${pending.plan.result.status}.`}</p>{pending.plan.result.environmentId!==null&&<p className="muted">Open the environment preparation for its retained result.</p>}</div>;
 return <div className="capability-authentication">
  {pending&&dirty?<p className="muted">Save authentication setup to retain this choice before adding private account credentials.</p>:!conflict&&valid&&<CapabilityAccounts key={`${authentication.kind}:${authentication.kind==='oauth'?authentication.connectionId:setup.references.join(',')}`} component={component} active={active} pollMs={pollMs}/>}
  {!fixed&&<details open={settingsOpen} onToggle={event=>setSettingsOpen(event.currentTarget.open)}><summary>Authentication settings</summary>
  <Select label="Authentication method" value={authentication.kind} options={[{value:'none',label:'No authentication configured'},{value:'static',label:'Referenced static credentials'},...component.connection.kind==='http'?[{value:'oauth',label:'OAuth account connection'}]:[]]} onChange={value=>update(value==='oauth'?{kind:'oauth',connectionId:'',scopes:[]}:{kind:value as 'none'|'static'})}/>
  {authentication.kind==='oauth'&&<><label>Account connection ID<input value={authentication.connectionId} onChange={event=>update({...authentication,connectionId:event.target.value})} placeholder="account-resource"/></label><label>Required scopes<textarea rows={3} value={scopeText} onChange={event=>{setScopeText(event.target.value);update({...authentication,scopes:event.target.value.split(/\s+/).filter(Boolean)});}}/></label><p className="muted">Use a separate account connection for each protected resource. Separate scopes with spaces or new lines.</p></>}
  {component.connection.kind==='stdio'&&<p className="muted">This local server may manage sign-in itself. Follow its documented credential and retained-storage setup; HTTP OAuth does not authenticate a local process.</p>}
  </details>}
  {conflict&&<p role="alert" className="environment-error">This account connection ID is also assigned to a different protected resource. Choose a separate ID for this capability.</p>}
  {pending&&!dirty&&[...new Set(pending.plan.result.actions.filter(action=>action.componentId===pending.component.id&&action.message!==pending.component.error?.message).map(action=>action.message))].map(message=><p className="environment-error" key={message}>{message}</p>)}
  {pending?.plan.result.environmentId===null&&pending.plan.result.actions.filter(action=>action.kind==='toolchain').map(action=><div key={action.id} className="environment-account-editor"><label>Path to {action.tool}<input value={candidatePath} onChange={event=>setCandidatePath(event.target.value)} placeholder="/absolute/path/to/executable"/></label><button disabled={busy||dirty||!candidatePath.startsWith('/')} onClick={()=>{setBusy(true);setError('');void command<PreparationResult>({kind:'operation.continue',input:{target:pending.plan.result.operationId,expectedVersion:pending.plan.result.version,actionId:action.id,resolution:{kind:'toolchain',tool:action.tool,path:candidatePath}}}).then(onPrepared).catch(failure=>setError((failure as Error).message)).finally(()=>setBusy(false));}}>Use this executable</button></div>)}
  {(pending||dirty||authentication.kind!=='none')&&<div className="header-actions"><button className="primary" disabled={busy||!valid||Boolean(conflict)} onClick={()=>void save()}>{busy?(pending?'Preparing…':'Saving…'):pending?(dirty?'Save authentication setup':'Finish setup'):'Save account binding'}</button></div>}
  {pending&&<p className="muted">Prepares this capability for selection in an environment.</p>}
  {!pending&&(dirty||authentication.kind!=='none')&&<p className="muted">Saving creates a new capability version. Existing environment selections stay unchanged; validate connections from their environment page.</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="environment-error">{error}</p>}
 </div>;
}
