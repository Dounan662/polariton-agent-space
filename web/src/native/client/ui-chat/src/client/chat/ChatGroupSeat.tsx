import {chatPresentationConfig} from '../../../../../presentation-config.ts'
/** Stable process container; display policy changes visibility, never member parents. */
import { memo, useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import {
  IconAgentPresetOutline16, IconApiOutline14, IconBrowseOutline16, IconChevronDownOutline14,
  IconChevronUpOutline14, IconCodeOutline16, IconEditOutline16, IconGlobeOutline14,
  IconPlanOutline14, IconQuestionOutline14, IconSearchOutline16, IconSparkle16,
  IconThinkOutline14, TextShimmer,
} from '../../../../../chat-primitives.tsx'
import type { GroupKey, NodeReference } from '../../../../../conversation.ts'
import type { ProcessActivity } from '../contract/process-groups.ts'
import type { ChatStoreState } from '../contract/store.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { chatRenderKey } from './render-entry.ts'
import { processTitle } from './step-process.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import { useWorkerState } from '../../../../../worker-state.tsx'
import { useProcessScroll } from './use-process-scroll.ts'
import css from './ChatGroupSeat.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'>
type ChatGroupSeatProps = SeatProps & {
  readonly groupKey: GroupKey
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
}
const PROCESS_TITLE_MINIMUM_MS = chatPresentationConfig.processTitleMinimumMs

type ProcessTitleActivity = ProcessActivity | 'thinking'

interface LiveProcessTitle {
  readonly activity: ProcessTitleActivity
  readonly detail: string
  readonly preparing: boolean
}

const PROCESS_ICONS: Record<ProcessTitleActivity, ReactNode> = {
  thinking: <IconThinkOutline14 />,
  read: <IconBrowseOutline16 size={14} />,
  readImage: <IconBrowseOutline16 size={14} />,
  search: <IconSearchOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  write: <IconEditOutline16 size={14} />,
  commands: <IconApiOutline14 />,
  code: <IconCodeOutline16 size={14} />,
  webSearch: <IconGlobeOutline14 />,
  webFetch: <IconBrowseOutline16 size={14} />,
  subagents: <IconAgentPresetOutline16 size={14} />,
  plan: <IconPlanOutline14 />,
  questions: <IconQuestionOutline14 />,
  tools: <IconSparkle16 size={14} />,
}

function sameLiveProcessTitle(left: LiveProcessTitle, right: LiveProcessTitle): boolean {
  return left.activity === right.activity && left.detail === right.detail && left.preparing === right.preparing
}

function useStableLiveProcessTitle(desired: LiveProcessTitle, active: boolean): LiveProcessTitle {
  const [displayed, setDisplayed] = useState(desired)
  const displayedRef = useRef(displayed)
  const desiredRef = useRef(desired)
  const displayedAtRef = useRef(Date.now())
  useEffect(() => {
    desiredRef.current = desired
    if (!active || sameLiveProcessTitle(displayedRef.current, desired)) return
    const remaining = PROCESS_TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current)
    const commit = (): void => {
      const next = desiredRef.current
      displayedRef.current = next
      displayedAtRef.current = Date.now()
      setDisplayed(next)
    }
    if (remaining <= 0) {
      commit()
      return
    }
    const timer = setTimeout(commit, remaining)
    return () => { clearTimeout(timer) }
  }, [active, desired.activity, desired.detail, desired.preparing])
  return active ? displayed : desired
}


const GroupMembers = memo(function GroupMembers({ members, ...props }: SeatProps & {
  readonly members: readonly NodeReference[]
}) {
  return members.map(member => <ChatNodeSeat {...props} key={chatRenderKey(member)} nodeKey={member.key}
    {...member.groupPart === undefined ? {} : { groupPart: member.groupPart }} />)
})

const ProcessGroupHeader = memo(function ProcessGroupHeader({ groupKey, useChatGroup, usePresentation, t, open, bodyId, toggle }: {
  readonly groupKey: GroupKey
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
  readonly usePresentation: ChatViewSlotProps['usePresentation']
  readonly t: ChatViewSlotProps['t']
  readonly open: boolean
  readonly bodyId: string
  readonly toggle: () => void
}) {
  const data = useChatGroup(groupKey, group => group?.data)
  const detailed = usePresentation(policy => data?.closed === false && policy.liveProcessDetail)
  const live = useStableLiveProcessTitle({
    activity: data?.summary.running ?? 'thinking',
    detail: data?.summary.runningDetail ?? '',
    preparing: data?.summary.preparing === true,
  }, data !== undefined && !data.closed)
  if (data === undefined) return null
  const label = data.closed ? processTitle(data.summary, t)
    : live.preparing ? t(`message.stepProcess.prepare.${live.activity === 'thinking' ? 'tools' : live.activity}`)
      : t(`message.stepProcess.${live.activity}`)
  const detail = detailed && !data.closed ? live.detail : ''
  const title = detail === '' ? label : `${label}${t('message.turnProcess.separator')}${detail}`
  const activity = data.closed ? data.summary.counts[0]?.kind ?? 'thinking' : live.activity
  return (
    <button type="button" className={css.title} aria-expanded={open} aria-controls={bodyId}
      data-process-activity={activity} onClick={(event) => { event.currentTarget.focus(); toggle() }}>
      <span className={css.leading} aria-hidden="true">
        <span className={css.activityIcon} data-step-process-icon>{PROCESS_ICONS[activity]}</span>
        <span className={css.chevron} data-step-process-chevron>
          {open ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </span>
      <TextShimmer active={!data.closed}>
        <TextShimmer className={css.label}>{title}</TextShimmer>
      </TextShimmer>
    </button>
  )
})

/** Render a process group with local disclosure and the existing outer-Turn visibility. */
export const ChatGroupSeat = memo(function ChatGroupSeat({ groupKey, useChatGroup, ...props }: ChatGroupSeatProps) {
  const members = useChatGroup(groupKey, group => group?.members)
  const turn = useChatGroup(groupKey, group => group?.data.turn)
  const closed = useChatGroup(groupKey, group => group?.data.closed)
  const foldCompleted = props.usePresentation(policy => policy.foldCompletedTurns)
  const [open, setOpen] = useWorkerState<boolean>(`chat:group:${groupKey}`, false)
  const firstKey = members?.[0]?.key ?? ''
  const presentation = props.useChatNodeProcess(firstKey)
  const turnLocation = props.useChatNode(firstKey, (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
  })
  const grouped = props.usePresentation(policy => policy.stepGrouping === 'collapsed'
    || (policy.stepGrouping === 'history' && turnLocation?.status !== 'open'))
  const reason = turnLocation?.end?.data.reason.kind
  const alwaysOpen = presentation?.turnClosed === false || presentation?.hasInterleavedInput === true
    || reason === 'aborted' || reason === 'error'
  const spec = presentation?.spec
  const selectStored = useCallback((state: Readonly<ChatStoreState>) => turn === undefined
    ? undefined : storedTurnProcessEntry(state, turn), [turn])
  const stored = props.useStore(selectStored)
  const outerHidden = foldCompleted && presentation?.turnClosed === true && spec !== undefined
    && !alwaysOpen && stored?.answerStep !== (spec.answerStep ?? 0)
  const revealOuter = useCallback(() => {
    if (spec !== undefined && !alwaysOpen) props.actions.setTurnProcessOpen(spec.turn, spec.answerStep ?? 0, true)
  }, [props.actions, spec, alwaysOpen])
  const rootRef = useSearchableHidden(outerHidden, revealOuter)
  useEffect(() => {
    if (outerHidden && rootRef.current?.hasAttribute('hidden')) setOpen(false)
  }, [outerHidden, rootRef, setOpen])
  const reveal = useCallback(() => { setOpen(true) }, [setOpen])
  const bodyRef = useSearchableHidden(grouped && !open, reveal)
  const contentRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const { edges, events, initialize } = useProcessScroll(bodyRef, contentRef, open, grouped, groupKey)
  const toggle = useCallback(() => {
    if (!open) initialize(closed === false ? 'bottom' : 'top')
    setOpen(!open)
  }, [closed, initialize, open, setOpen])
  if (members === undefined) return null
  const classes = [css.body, !grouped ? css.expandedBody : '',
    grouped && edges.canScrollUp ? css.fadeTop : '', grouped && edges.canScrollDown ? css.fadeBottom : '']
  return (
    <div ref={rootRef} className={css.root} data-chat-group-key={groupKey}
      data-chat-flow-key={groupKey} data-chat-anchor-key={`group:${groupKey}`} data-chat-turn={turn}
      data-chat-paging-anchor={grouped && !open || undefined}
      data-step-process data-group-expanded-mode={!grouped || undefined}>
      <div hidden={!grouped}>
        <ProcessGroupHeader groupKey={groupKey} useChatGroup={useChatGroup}
          usePresentation={props.usePresentation} t={props.t} open={open} bodyId={bodyId} toggle={toggle} />
      </div>
      <div ref={bodyRef} id={bodyId} className={classes.join(' ')} data-step-process-body
        data-scroll-up={edges.canScrollUp || undefined} data-scroll-down={edges.canScrollDown || undefined}
        {...events}>
        <div ref={contentRef} className={css.content} data-step-process-content data-chat-flow="">
          {(!grouped || open) && !outerHidden && <GroupMembers {...props} members={members} />}
        </div>
      </div>
    </div>
  )
})
