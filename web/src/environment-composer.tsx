import React,{useId,useRef,useState} from 'react';
import {uuid} from './api.ts';
import {selectableCatalog} from './environment-preparation.ts';
import type {Component,ConnectionRevision,EnvironmentDocument,Inventory} from '../../src/environment/contracts.ts';

type Choice={component:Component;selected:boolean;detail:string;configuration:string;required:string[]};
type Props={inventory:Inventory;busy:boolean;onCreate:(document:EnvironmentDocument)=>Promise<void>;onCancel:()=>void;error?:string};

/** Compose only existing capability versions. A form owns its reviewed catalog snapshot
 * and stable identities, so polling and publication retries cannot change the selection. */
export function EnvironmentComposer({inventory,busy,onCreate,onCancel,error}:Props){
  const nameId=useId(),errorId=useId();
  const [environmentId]=useState(uuid),[name,setName]=useState(''),[localError,setLocalError]=useState(''),[submitting,setSubmitting]=useState(false);
  const submittingRef=useRef(false);
  const [choices,setChoices]=useState<Choice[]>(()=>{
    const catalog=selectableCatalog(inventory);
    const connections=catalog.capabilities.filter((value):value is ConnectionRevision=>value.kind!=='managed').map(value=>({
      component:{id:uuid(),name:value.name,definition:{capabilityId:value.id,revisionId:value.revisionId}},
      selected:false,detail:value.kind==='http'?'HTTP connection':value.container?'Container program':value.package?'Package':'Local program',configuration:'',required:[],
    }));
    const releases=catalog.releases.map(value=>{
      const properties=value.manifest.configSchema.properties;
      const defaults=properties&&typeof properties==='object'&&!Array.isArray(properties)?Object.fromEntries(
        Object.entries(properties).flatMap(([key,schema])=>schema&&typeof schema==='object'&&!Array.isArray(schema)&&'default' in schema?[[key,schema.default]]:[]),
      ):{};
      const required=value.manifest.configSchema.required;
      return {
        component:{id:uuid(),name:value.manifest.name,releaseId:value.id,configuration:defaults},
        selected:false,detail:value.manifest.description||'Managed tool',configuration:JSON.stringify(defaults,null,2),
        required:Array.isArray(required)?required.filter((key):key is string=>typeof key==='string'):[],
      };
    });
    return [...connections,...releases];
  });
  const disabled=busy||submitting;
  const message=localError||error;
  const update=(id:string,change:Partial<Pick<Choice,'selected'|'configuration'>>)=>{
    setChoices(current=>current.map(choice=>choice.component.id===id?{...choice,...change}:choice));setLocalError('');
  };
  const create=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(disabled||submittingRef.current)return;
    if(!name.trim()){setLocalError('Give this environment a name.');return;}
    setLocalError('');
    const components:Component[]=[];
    for(const choice of choices.filter(value=>value.selected)){
      if(!('releaseId' in choice.component)){components.push(choice.component);continue;}
      let configuration:unknown;
      try{configuration=JSON.parse(choice.configuration);}catch{setLocalError(`${choice.component.name}: configuration must be valid JSON. Check commas, quotes and brackets.`);return;}
      if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)){
        setLocalError(`${choice.component.name}: configuration must be a JSON object, such as {"setting":"value"}.`);return;
      }
      const missing=choice.required.filter(key=>!Object.hasOwn(configuration,key));
      if(missing.length){setLocalError(`${choice.component.name}: add the required ${missing.length===1?'setting':'settings'}: ${missing.join(', ')}.`);return;}
      components.push({...choice.component,configuration:configuration as Record<string,unknown>});
    }
    submittingRef.current=true;setSubmitting(true);
    try{await onCreate({format:2,environmentId,name:name.trim(),description:'',components});}
    catch(failure){setLocalError(failure instanceof Error?failure.message:'The environment could not be created. Please try again.');}
    finally{submittingRef.current=false;setSubmitting(false);}
  };
  return <form className="environment-composer" onSubmit={event=>void create(event)} aria-describedby={message?errorId:undefined}>
    <p className="muted">Choose the capabilities this environment will use. You can change them later.</p>
    <label htmlFor={nameId}>Name<input id={nameId} autoFocus required disabled={disabled} value={name} onChange={event=>{setName(event.target.value);setLocalError('');}} placeholder="My environment"/></label>
    <fieldset disabled={disabled} className="environment-capability-list"><legend>Capabilities</legend>
      {!choices.length&&<p className="muted">No capabilities are available yet. You can create an empty environment and add them later.</p>}
      {choices.map(choice=>{
        const component=choice.component,managed='releaseId' in component;
        const ambiguous=choices.some(other=>other.component.id!==component.id&&other.component.name.toLocaleLowerCase()===component.name.toLocaleLowerCase());
        const missing=managed&&choice.required.some(key=>!Object.hasOwn(component.configuration,key));
        return <div className={`environment-capability-option${choice.selected?' selected':''}`} key={component.id}>
          <label><input type="checkbox" checked={choice.selected} onChange={event=>update(component.id,{selected:event.target.checked})}/><span><strong>{component.name}</strong><small>{choice.detail}{ambiguous&&` · ${managed?`Release ${component.releaseId}`:`Version ${component.definition.revisionId}`}`}</small></span></label>
          {choice.selected&&managed&&<details open={missing||undefined}><summary>Configuration</summary>
            {choice.required.length>0&&<p className="muted">Required settings: {choice.required.join(', ')}</p>}
            <label>Configuration for {component.name}<textarea rows={5} spellCheck={false} value={choice.configuration} onChange={event=>update(component.id,{configuration:event.target.value})}/></label>
          </details>}
        </div>;
      })}
    </fieldset>
    {!!choices.length&&!choices.some(choice=>choice.selected)&&<p className="muted">No capabilities selected. This environment will start empty.</p>}
    {message&&<p id={errorId} role="alert" className="environment-error">{message}</p>}
    <div className="modal-footer"><button type="button" disabled={disabled} onClick={onCancel}>Cancel</button><button type="submit" className="primary" disabled={disabled||!name.trim()}>{submitting?'Creating…':'Create environment'}</button></div>
  </form>;
}
