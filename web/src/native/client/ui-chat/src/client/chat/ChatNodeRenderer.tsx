/** Dispatch over the projection's discriminated contract without a plugin service locator. */
import type {ChatNodeViewProps} from '../contract/slots.ts'
import {useDisclosure} from './use-disclosure.ts'
import {useTurnDataValue} from './use-turn-data.ts'
import {AssistantNodeView} from './AssistantNodeView.tsx'
import {CommandNodeView,ManualCompactionNodeView} from './CommandNodeView.tsx'
import {UserMessageNodeView,ContextMessageNodeView,CompactionNodeView,RetryNodeView,TurnErrorNodeView,TurnMaxTokensNodeView,UnknownNodeView} from './MessageItem.tsx'
import {TurnProcessNodeView} from './TurnProcessNodeView.tsx'
import {TurnTailNodeView} from './TurnTailNodeView.tsx'
import {TurnTriggerNodeView} from './TurnTriggerNodeView.tsx'
import {SystemPromptNodeView} from './SystemPromptRow.tsx'
import {ToolCallTree} from '../../../../ui-tool/src/client/tool/ToolCallTree.tsx'
export function ChatNodeRenderer({node,...owner}:Omit<ChatNodeViewProps,'useDisclosure'|'useTurnData'>){
 const location=node.location
 const turnData=location.kind==='turn'||location.kind==='step'?location.turn.data:undefined
 const props={...owner,useDisclosure,useTurnData:<Key extends Parameters<typeof useTurnDataValue>[1]>(key:Key)=>useTurnDataValue(turnData,key)}
 switch(node.kind){
  case 'assistant-step':return <AssistantNodeView {...props} node={node}/>
  case 'user':case 'steering':return <UserMessageNodeView {...props} node={node}/>
  case 'context':return <ContextMessageNodeView {...props} node={node}/>
  case 'system-prompt':return <SystemPromptNodeView {...props} node={node}/>
  case 'command':return <CommandNodeView {...props} node={node}/>
  case 'manual-compaction':return <ManualCompactionNodeView {...props} node={node}/>
  case 'compaction':return <CompactionNodeView {...props} node={node}/>
  case 'model-retry':return <RetryNodeView {...props} node={node}/>
  case 'turn-error':return <TurnErrorNodeView {...props} node={node}/>
  case 'turn-max-tokens':return <TurnMaxTokensNodeView {...props} node={node}/>
  case 'turn-process':return <TurnProcessNodeView {...props} node={node}/>
  case 'turn-tail':return <TurnTailNodeView {...props} node={node}/>
  case 'turn-trigger':return <TurnTriggerNodeView {...props} node={node}/>
  case 'tool-call':return <ToolCallTree {...props} node={node}/>
  case 'unknown':return <UnknownNodeView {...props} node={node}/>
 }
}
