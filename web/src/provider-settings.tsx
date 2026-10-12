import React, {useEffect, useRef, useState} from 'react';
import {api, uuid} from './api.ts';
import {Select} from './select.tsx';
import {IconPlusOutline16, IconRefreshOutline16} from './ui/index.ts';
import './provider-settings.css';

import type {ProviderDescriptor, ProviderModel, ProviderSnapshot} from '../../harness/provider-contracts.ts';

type Model = ProviderModel;
type Provider = ProviderDescriptor;
type Protocol = NonNullable<Provider['protocol']>;
export type ProviderSettingsView = ProviderSnapshot & {
  application?:{state:'effective'|'pending';detail?:string;pendingWorkers:number};
};
type Draft = {provider:Provider;apiKey:string;modelIds:string;knownModels:Model[];removeKey:boolean;selectedModel:string};
const route = (id:string,model:string)=>JSON.stringify([id,model]);

/** Owner settings are independent of research navigation. Mutations keep their
 * revision so a stale form cannot silently replace a concurrent edit. */
export function ProviderSettings({active,pollMs,onLoaded,onChanged}:{active:boolean;pollMs:number;onLoaded:(value:ProviderSettingsView)=>void;onChanged:()=>void}) {
  const [settings,setSettings]=useState<ProviderSettingsView|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [editor,setEditor]=useState<{provider:Provider;revision:number}|null>(null),[adding,setAdding]=useState(false);
  const [removing,setRemoving]=useState<string|null>(null);
  const heading=useRef<HTMLHeadingElement>(null);
  const loaded=useRef(onLoaded);loaded.current=onLoaded;
  const accept=(value:ProviderSettingsView)=>{setSettings(value);loaded.current(value);};
  const refresh=async(signal?:AbortSignal)=>{try{accept(await api<ProviderSettingsView>('/settings/providers',undefined,signal));setError('');}catch(error){if(!signal?.aborted)setError((error as Error).message);}};
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);return()=>controller.abort();},[active]);
  useEffect(()=>{if(!active||settings?.application?.state!=='pending')return;const controller=new AbortController();const timer=setTimeout(()=>void refresh(controller.signal),pollMs);return()=>{clearTimeout(timer);controller.abort();};},[active,settings,pollMs]);
  useEffect(()=>{if(active)heading.current?.focus({preventScroll:true});else {setEditor(null);setAdding(false);setRemoving(null);}},[active]);
  const mutate=async(path:string,body:unknown,message:string)=>{
    setBusy(true);setError('');setNotice('');
    try {accept(await api<ProviderSettingsView>(`/settings/providers/${path}`,body));setNotice(message);onChanged();return true;}
    catch(error){setError((error as Error).message);return false;}
    finally{setBusy(false);}
  };
  return <main id="settings-workspace" className="provider-settings" hidden={!active} aria-label="Settings">
    <header><span className="muted">Settings<span className="slash">/</span><span className="settings-header-title">Models &amp; providers</span></span></header>
    <div className="settings-scroll"><div className="settings-content">
      <div className="settings-title"><div><div className="eyebrow">YOUR WORKSPACE</div><h1 tabIndex={-1} ref={heading}>Models &amp; providers</h1><p>Connect the models your research workers use.</p></div><button className="settings-icon" type="button" aria-label="Refresh provider settings" disabled={busy} onClick={()=>void refresh()}><IconRefreshOutline16/></button></div>
      {error&&<div className="settings-message settings-error" role="alert">{error}<button type="button" disabled={busy} onClick={()=>void refresh()}>Reload settings</button></div>}
      {notice&&<div className="settings-message" role="status">{notice}</div>}
      {!settings?<p className="muted" role="status">{error?'Settings could not be loaded.':'Loading provider settings…'}</p>:<>
        {settings.application?.state==='pending'&&<div className="settings-message" role="status">{settings.application.detail??'Saved. Changes will apply after affected workers finish their current turns and background activity.'}</div>}
        <section className="settings-section" aria-labelledby="default-model-heading">
          <div className="settings-section-heading"><h2 id="default-model-heading">Default model</h2><p>Used for new workers. Existing workers keep their selected model.</p></div>
          <Select label="Default model" value={settings.defaultRoute??''} disabled={busy||!settings.choices.length}
            options={[{value:'',label:settings.choices.length?'Choose a model':'Connect a provider to choose a model',disabled:true},...(!settings.choices.some(choice=>choice.value===settings.defaultRoute)&&settings.defaultRoute?[{value:settings.defaultRoute,label:'Selected model unavailable — choose another',disabled:true}]:[]),...settings.choices.map(choice=>({value:choice.value,label:choice.name}))]}
            onChange={value=>void mutate('default',{route:value,revision:settings.revision},'Default model saved. New workers will use this model.')}/>
          {!settings.defaultRoute&&settings.choices.length>0&&<p className="settings-help">Choose a default model to finish setup, or select a model in an individual worker.</p>}
        </section>
        <section className="settings-section" aria-labelledby="providers-heading">
          <div className="settings-section-heading settings-heading-row"><div><h2 id="providers-heading">Providers</h2><p>Your keys stay on this installation.</p></div><button type="button" disabled={busy} onClick={()=>{setAdding(true);setEditor(null);setRemoving(null);setNotice('');}}><IconPlusOutline16/> Add provider</button></div>
          {!settings.providers.length&&!adding&&!editor&&<div className="settings-empty"><h3>Connect your first provider</h3><p>Paste an API key, then choose a model. You can keep exploring your research before connecting.</p><button type="button" className="primary" onClick={()=>setAdding(true)}>Connect a provider</button></div>}
          <div className="provider-list">{settings.providers.map(provider=><article className="provider-card" key={provider.id}>
            <div className="provider-card-info"><h3>{provider.name}<span className={`provider-status ${provider.configured?'configured':''}`}>{!provider.credential.writable?'Environment override':provider.configured?provider.keyless?'Configured · no key':'Key saved':'Not configured'}</span></h3><p>{provider.kind==='custom'?provider.baseURL:settings.catalog.find(value=>value.id===provider.id)?.name} · {provider.models.length} {provider.models.length===1?'model':'models'}</p>{!provider.credential.writable&&<p className="settings-help">Credentials are supplied by the environment and are read-only here.</p>}</div>
            <div className="provider-card-actions"><button type="button" disabled={busy} onClick={()=>{setEditor({provider,revision:settings.revision});setAdding(false);setRemoving(null);setNotice('');}}>Edit<span className="settings-sr-only"> {provider.name}</span></button><button type="button" className="settings-icon" aria-label={`Remove ${provider.name}`} disabled={busy||!provider.credential.writable} onClick={()=>setRemoving(provider.id)}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 5.5h12M8 5.5V3h4v2.5M6 5.5l.8 11h6.4l.8-11M8.5 8v5.5M11.5 8v5.5"/></svg></button></div>
            {removing===provider.id&&<div className="provider-remove"><p>Remove {provider.name} and its locally saved key? Workers using it will need another route. This does not revoke the key at the provider or erase backups.</p><div><button type="button" disabled={busy} onClick={()=>setRemoving(null)}>Cancel</button><button type="button" className="settings-danger" disabled={busy} onClick={()=>void mutate('remove',{id:provider.id,revision:settings.revision},'Provider removed. Its key has not been revoked at the provider.').then(ok=>{if(ok){setRemoving(null);setEditor(null);}})}>Remove provider</button></div></div>}
          </article>)}</div>
          {adding&&<div className="provider-add"><div className="settings-heading-row"><h3>Add a provider</h3><button type="button" className="settings-icon" aria-label="Cancel adding provider" onClick={()=>setAdding(false)}>×</button></div><div className="provider-catalog">{settings.catalog.filter(provider=>!settings.providers.some(saved=>saved.id===provider.id)).map(provider=><button key={provider.id} type="button" onClick={()=>{setEditor({revision:settings.revision,provider:{id:provider.id,kind:'builtin',name:provider.name,models:[],keyless:false,credential:provider.credential??{configured:false,writable:true},configured:false}});setAdding(false);}}><span>{provider.name}</span><span aria-hidden="true">↗</span></button>)}<button type="button" onClick={()=>{setEditor({revision:settings.revision,provider:{id:`custom-${uuid()}`,kind:'custom',name:'',baseURL:'',protocol:'openai-completions',models:[],keyless:false,credential:{configured:false,writable:true},configured:false}});setAdding(false);}}><span>Custom model API<small>A gateway, compatible API, or local server</small></span><span aria-hidden="true">↗</span></button></div></div>}
          {editor&&<ProviderEditor key={`${editor.provider.id}:${editor.revision}`} initial={editor.provider} revision={editor.revision} catalogModels={settings.catalog.find(value=>value.id===editor.provider.id)?.models??[]} keyUrl={settings.catalog.find(value=>value.id===editor.provider.id)?.keyUrl} existing={settings.providers.some(provider=>provider.id===editor.provider.id)} defaultRoute={settings.defaultRoute} onCancel={()=>{setEditor(null);heading.current?.focus();}} onReload={()=>{setEditor(null);void refresh();heading.current?.focus();}} onSaved={(value,problem)=>{accept(value);onChanged();setNotice('Provider saved. Connection has not been tested.');if(problem)setError(problem);setEditor(null);heading.current?.focus();}}/>}
        </section>
        <section className="settings-security" aria-labelledby="credential-storage-heading"><h2 id="credential-storage-heading">Local credential storage</h2><p>Keys are stored in a private file on this installation, outside your research projects. The file is not encrypted. Programs and agent tools running as your OS user may read it.</p><p>Saving does not send a prompt or verify access. Removing a key deletes Polariton’s copy; it does not revoke the key at the provider or erase backups.</p></section>
      </>}
    </div></div>
  </main>;
}

/** The draft owns the only browser-side copy of an entered secret. Successful
 * persistence clears it before a subsequent default-selection request can fail. */
function ProviderEditor({initial,revision,catalogModels,keyUrl,existing,defaultRoute,onCancel,onReload,onSaved}:{initial:Provider;revision:number;catalogModels:Model[];keyUrl?:string;existing:boolean;defaultRoute:string|null;onCancel:()=>void;onReload:()=>void;onSaved:(value:ProviderSettingsView,problem?:string)=>void}) {
  const [draft,setDraft]=useState<Draft>({provider:initial,apiKey:'',modelIds:initial.models.map(model=>model.id).join('\n'),knownModels:initial.models,removeKey:false,selectedModel:''});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[discovery,setDiscovery]=useState(''),[modelSearch,setModelSearch]=useState('');
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus({preventScroll:true});heading.current?.scrollIntoView({block:'nearest'});},[]);
  const provider=draft.provider;
  const models=provider.kind==='custom'?[...new Set(draft.modelIds.split(/[\n,]/).map(value=>value.trim()).filter(Boolean))].map(id=>draft.knownModels.find(model=>model.id===id)??{id}):provider.models;
  const patch=(value:Partial<Provider>)=>setDraft(prior=>({...prior,provider:{...prior.provider,...value}}));
  const save=async()=>{
    setBusy(true);setError('');
    try {
      let value=await api<ProviderSettingsView>('/settings/providers/save',{id:provider.id,kind:provider.kind,models,...(provider.kind==='custom'?{name:provider.name.trim(),baseURL:provider.baseURL?.trim(),protocol:provider.protocol,keyless:provider.keyless}:{}),...(draft.apiKey?{apiKey:draft.apiKey}:{}),...(draft.removeKey?{removeKey:true}:{}),revision});
      setDraft(prior=>({...prior,apiKey:'',removeKey:false}));
      if(draft.selectedModel) {
        try{value=await api<ProviderSettingsView>('/settings/providers/default',{route:route(provider.id,draft.selectedModel),revision:value.revision});}
        catch{onSaved(value,'Provider saved, but the default model could not be updated. Choose the default model above to retry.');return;}
      }
      onSaved(value);
    } catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  };
  const discover=async()=>{
    setBusy(true);setError('');setDiscovery('');
    try {
      const result=await api<Model[]>('/settings/providers/discover',{...(existing?{id:provider.id}:{}),baseURL:provider.baseURL?.trim(),protocol:provider.protocol,...(draft.apiKey?{apiKey:draft.apiKey}:{})});
      setDraft(prior=>({...prior,knownModels:[...new Map([...prior.knownModels,...result].map(model=>[model.id,model])).values()],modelIds:[...new Set([...prior.modelIds.split(/[\n,]/).map(value=>value.trim()).filter(Boolean),...result.map(model=>model.id)])].join('\n')}));
      setDiscovery(result.length?`${result.length} ${result.length===1?'model':'models'} found. Review the list before saving.`:'No models returned. Enter model IDs manually below.');
    } catch {setDiscovery('Model discovery is unavailable for this endpoint. Enter model IDs manually below.');}
    finally{setBusy(false);}
  };
  return <form className="provider-editor" autoComplete="off" onSubmit={event=>{event.preventDefault();void save();}}>
    <div className="settings-heading-row"><h3 ref={heading} tabIndex={-1}>{existing?'Edit': 'Connect'} {provider.kind==='builtin'?provider.name:'custom model API'}</h3><button className="settings-icon" type="button" aria-label="Close provider editor" disabled={busy} onClick={onCancel}>×</button></div>
    {error&&<div className="settings-message settings-error" role="alert">{error}<button type="button" disabled={busy} onClick={onReload}>Discard draft &amp; reload</button></div>}
    <fieldset disabled={busy}>
      {provider.kind==='custom'&&<><label>Display name<input required value={provider.name} onChange={event=>patch({name:event.target.value})} placeholder="My model server"/></label><label>API endpoint<input type="url" required value={provider.baseURL??''} onChange={event=>patch({baseURL:event.target.value})} placeholder="http://localhost:11434/v1" spellCheck={false}/></label><label>API protocol<Select label="API protocol" value={provider.protocol??'openai-completions'} onChange={value=>patch({protocol:value as Protocol})} options={[{value:'openai-completions',label:'OpenAI Chat Completions'},{value:'openai-responses',label:'OpenAI Responses'},{value:'anthropic-messages',label:'Anthropic Messages'}]}/></label><label className="settings-checkbox"><input type="checkbox" checked={provider.keyless} onChange={event=>{patch({keyless:event.target.checked});setDraft(prior=>({...prior,apiKey:'',removeKey:false}));}}/>This endpoint does not require an API key</label></>}
      {!provider.keyless&&<label><span className="settings-label-row">API key{keyUrl&&<a href={keyUrl} target="_blank" rel="noreferrer">Get an API key ↗</a>}</span><input type="password" required={!provider.credential.configured&&!draft.removeKey} autoComplete="new-password" spellCheck={false} value={draft.apiKey} disabled={!provider.credential.writable||draft.removeKey} onChange={event=>setDraft(prior=>({...prior,apiKey:event.target.value}))} placeholder={provider.credential.configured?'Leave blank to keep your saved key':'Paste your API key'}/><span className="settings-help">{!provider.credential.writable?'An environment override supplies this key. Change it outside Polariton to replace it.':provider.credential.configured?'The saved key is never shown in the browser.':'Your key is saved only on this installation.'}</span></label>}
      {!provider.keyless&&provider.credential.configured&&provider.credential.writable&&<label className="settings-checkbox"><input type="checkbox" checked={draft.removeKey} onChange={event=>setDraft(prior=>({...prior,removeKey:event.target.checked,apiKey:''}))}/>Remove the saved key from Polariton</label>}
      {provider.kind==='custom'&&<><div className="settings-label-row"><span>Models</span><button type="button" disabled={busy||!provider.baseURL} onClick={()=>void discover()}>Find available models</button></div>{discovery&&<p className="settings-help" role="status">{discovery}</p>}<label>Model IDs<textarea required rows={4} value={draft.modelIds} onChange={event=>setDraft(prior=>({...prior,modelIds:event.target.value,selectedModel:''}))} placeholder={'model-id\nanother-model-id'} spellCheck={false}/><span className="settings-help">Enter one model ID per line. Discovery does not send a generation request.</span></label></>}
      {provider.kind==='builtin'&&<details className="provider-models" open={!existing}><summary>Available models <span>{models.length} selected</span></summary><p className="settings-help">Choose which models appear in worker selectors. Removing a model requires workers using it to select another route.</p><label>Find a model<input type="search" value={modelSearch} onChange={event=>setModelSearch(event.target.value)} placeholder="Search model names or IDs"/></label><div className="provider-model-options" role="group" aria-label="Available models">{catalogModels.filter(model=>`${model.name??''} ${model.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase())).map(model=><label className="settings-checkbox" key={model.id}><input type="checkbox" checked={models.some(selected=>selected.id===model.id)} onChange={event=>{const checked=event.target.checked;setDraft(prior=>({...prior,provider:{...prior.provider,models:checked?[...prior.provider.models,initial.models.find(saved=>saved.id===model.id)??model]:prior.provider.models.filter(selected=>selected.id!==model.id)},selectedModel:!checked&&prior.selectedModel===model.id?'':prior.selectedModel}));}}/><span>{model.name??model.id}{model.name&&model.name!==model.id&&<small>{model.id}</small>}</span></label>)}</div>{!models.length&&<p className="settings-help" role="status">Select at least one model before saving.</p>}</details>}
      {models.length>0&&!draft.removeKey&&<label>{defaultRoute?'Change the default model (optional)':'Default model for new workers'}<Select label="Provider default model" value={draft.selectedModel} onChange={value=>setDraft(prior=>({...prior,selectedModel:value}))} options={[{value:'',label:defaultRoute?'Keep current default':'Choose a model'},...models.map(model=>({value:model.id,label:model.name??model.id}))]}/></label>}
    </fieldset>
    <p className="settings-help">{draft.removeKey?'Removing a key does not revoke it at the provider. Workers using this provider will need a configured route.':'Saving does not test the connection or send a prompt. Running turns keep their current configuration.'}</p>
    <div className="settings-editor-actions"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" type="submit" disabled={busy||!models.length}>{busy?'Working…':'Save provider'}</button></div>
  </form>;
}
