/** Native recursive call composition with explicit read-only host capabilities. */
import {memo} from 'react'
import type {ToolCallBlock} from '../../../../../conversation.ts'
import type {ChatNodeViewProps} from '../../../../ui-chat/src/client/contract/slots.ts'
import {DisclosureIdentity,useDisclosure} from '../../../../ui-chat/src/client/chat/use-disclosure.ts'
import {GenericToolCard} from './toolviews/GenericToolCard.tsx'
import {translate} from '../locales.ts'
import css from './ToolCallTree.module.css'
type Owner=Pick<ChatNodeViewProps<'tool-call'>,'cwd'|'openFile'|'inspectCall'|'renderMessageImages'|'loadImage'>
const ToolCallBranch=memo(function ToolCallBranch({block,...owner}:Owner&{block:ToolCallBlock}){
 const toolName='kind' in block?block.call?.name??'':block.name
 const children='kind' in block||block.phase!=='preparing'?block.subCalls:[]
 return <DisclosureIdentity.Provider value={`call:${block.callId}`}><div className={css.callRow} data-chat-call-id={block.callId}>
  <GenericToolCard block={block} toolName={toolName} cwd={owner.cwd} openFile={owner.openFile} renderMessageImages={owner.renderMessageImages} loadImage={owner.loadImage} inspect={owner.inspectCall===undefined?undefined:()=>owner.inspectCall?.(block.callId)} useDisclosure={useDisclosure} t={translate}/>
  {children.length>0&&<div className={css.subCalls} data-subcalls>{children.map(child=><ToolCallBranch key={child.callId} {...owner} block={child}/>)}</div>}
 </div></DisclosureIdentity.Provider>
})
export function ToolCallTree({node,...owner}:ChatNodeViewProps<'tool-call'>){return <ToolCallBranch {...owner} block={node.data.root}/>}
