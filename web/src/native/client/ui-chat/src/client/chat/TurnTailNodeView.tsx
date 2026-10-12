import {memo} from 'react'
import type {ChatNodeViewProps} from '../contract/slots.ts'
import {MessageIconActions} from './MessageIconActions.tsx'
import {TurnUsagePanel} from './TurnUsagePanel.tsx'
import {assistantText} from './turn-assistant.ts'
import css from './TurnTailNodeView.module.css'
/** Native completed-turn actions over the retained closing assistant and exact usage. */
export const TurnTailNodeView=memo(function TurnTailNodeView({node,t}:ChatNodeViewProps<'turn-tail'>){
 const data=node.data,closing=data.closing
 if(closing===null)return null
 return <div className={css.root} data-turn-tail={data.turn} data-actions-reveal="always"><MessageIconActions text={assistantText(closing.blocks)} time={closing.time} clock="end" className={css.actions} usageAction={data.tokenUsage===undefined?null:<TurnUsagePanel usage={data.tokenUsage} t={t}/>} t={t}/></div>
})
