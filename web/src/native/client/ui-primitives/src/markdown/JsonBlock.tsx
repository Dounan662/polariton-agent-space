/** Native disclosure chrome over Polariton's shared lazy JSON inspector. */
import {JsonTree,type JsonTreeLabels} from '../../../../../ui/JsonTree.tsx'
import {useDisclosure} from '../../../ui-chat/src/client/chat/use-disclosure.ts'
import {chatPresentationConfig} from '../../../../presentation-config.ts'
import css from './JsonBlock.module.css'
const labels:JsonTreeLabels={copyValue:'Copy value',copyJson:'Copy JSON',copyPath:'Copy path',copyPrettyJson:'Copy formatted JSON',copyCompactJson:'Copy compact JSON',copied:'Copied',copyFailed:'Copy failed',collapseNode:'Collapse',expandNode:'Expand',copyButtonTitle:action=>action}
/** Structured payloads remain expandable without duplicating the inspector or its grammar cache. */
export function JsonBlock({label,payload,stateKey=label,truncatedLabel}:{label:string;payload:unknown;stateKey?:string;truncatedLabel:(total:number)=>string}){
 const {expanded:open,toggle}=useDisclosure(`json:${stateKey}`)
 const text=typeof payload==='string'?payload:String(payload)
 const capped=text.length>chatPresentationConfig.jsonPreviewChars?`${text.slice(0,chatPresentationConfig.jsonPreviewChars)}\n${truncatedLabel(text.length)}`:text
 return <div className={css.root}><button type="button" className={css.toggle} aria-expanded={open} onClick={toggle}>{open?'▾':'▸'} {label}</button>{open&&<div className={css.body}>{typeof payload==='object'&&payload!==null?<JsonTree data={payload} label={label} labels={labels}/>:<pre>{capped}</pre>}</div>}</div>
}
