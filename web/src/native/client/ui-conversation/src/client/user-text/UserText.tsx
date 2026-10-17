/** User text is evaluated by the pinned DSH document/rules; navigation remains caller-owned. */
import {useEffect,useMemo} from 'react'
import type {UserTextFacts,UserTextNode} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {ReferenceChip,UserTextRun} from '../../../../ui-primitives/src/user-text.tsx'
import {UserTextDocument} from '../conversation/user-text-document.ts'
import {sessionReferenceRule} from './session-reference-rule.ts'
import {fileReferenceRule,folderReferenceRule} from '../../../../ui-reference/src/client/user-text-rules.ts'
import {skillReferenceRule} from '../../../../ui-skill/src/client/user-text-rules.ts'
import css from './UserText.module.css'

// Polariton does not mount the frontend plugin registry. Only confirmed references
// used by its message surface participate; raw text remains the failure fallback.
const rules=[sessionReferenceRule,skillReferenceRule,fileReferenceRule,folderReferenceRule]
export interface UserTextProps {
 text:string
 facts:Readonly<Partial<UserTextFacts>>
 references?:{openFile?:(path:string)=>void;openSkill?:(name:string)=>void}|undefined
}

/** Render source text through native business rules without altering stored content. */
export function UserText({text,facts,references}:UserTextProps){
 const document=useMemo(()=>new UserTextDocument(),[])
 let nodes:readonly UserTextNode[]|undefined,error:unknown
 try{nodes=document.evaluate({text,facts},rules)}catch(cause){error=cause}
 const failed=nodes===undefined
 useEffect(()=>{if(failed)console.error('Unable to project user-message references',error)},[failed,error])
 return <span className={css.root}>{nodes===undefined?<UserTextRun text={text}/>:nodes.map(node=>{
  const key=`${node.id}:${node.start}`,raw=text.slice(node.start,node.end)
  switch(node.id){
   case 'text':return <UserTextRun key={key} text={node.data.display??raw}/>
   case 'session':return <ReferenceChip key={key} appearance="session" label={node.data.label} title={raw}/>
   case 'skill':return <ReferenceChip key={key} appearance="skill" label={`/${node.data.name}`} title={raw} onActivate={references?.openSkill?()=>references.openSkill!(node.data.name):undefined}/>
   case 'file':return <ReferenceChip key={key} appearance="file" label={node.data.label} title={raw} onActivate={references?.openFile?()=>references.openFile!(node.data.path):undefined}/>
   case 'folder':return <ReferenceChip key={key} appearance="folder" label={node.data.label} title={raw}/>
   default:return <UserTextRun key={key} text={raw}/>
  }
 })}</span>
}
