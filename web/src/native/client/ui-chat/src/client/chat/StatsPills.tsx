// Native activity and usage seats use Polariton's complete session projections.
// Detailed readings remain available without mounting the upstream plugin UI.

import { memo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '../../../../../../ui/index.ts'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type {MetricsTranslate,SessionMetrics} from '../../../../../metrics.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './StatsPills.module.css'
import dialogCss from './stat-dialog.module.css'

type SessionStats = SessionMetrics['sessionStats']
type Translate = MetricsTranslate

/** Validated whole-session projections and the owning locale. */
export interface StatPillProps {
  metrics: SessionMetrics
  t: MetricsTranslate
}

/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number, t: MetricsTranslate): string {
  const s = ms / 1_000
  if (s < 60) return t('duration.compactSeconds', { seconds: Math.round(s * 10) / 10 })
  const whole = Math.round(s)
  return t('duration.compactMinutes', {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  })
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
export function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  return formatCacheHitPercent(usage.cacheReadTokens, denominator)
}

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Dock entry id carried as `data-composer-stat` on each pill. */
type StatId = 'activity' | 'usage'

interface PillContent {
  stat: StatId
  icon: ReactNode
  label: ReactNode
}

function exactCount(value: number, t: Translate): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

function joined(first: string, second: string | null): ReactNode {
  if (second === null) return first
  return (
    <>
      {first}
      <span className={css.sep} aria-hidden>·</span>
      {second}
    </>
  )
}

function decodeSpeed(stats: SessionStats, t: Translate): string {
  return t('message.tokensPerSecond', {
    tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
  })
}

/** A static reading when the pill has no timed dialog rows. */
function PlainPill({ stat, icon, label }: PillContent) {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <span className={css.pill}>
        {icon}
        <span className={css.label}>{label}</span>
      </span>
    </span>
  )
}

/**
 * A pill button opening its own portaled dialog. Each pill owns its open
 * state; useStatDialog closes it on Escape or an outside pointerdown or click,
 * so at most one dialog is open across the dock.
 */
function DialogPill({ stat, icon, label, ariaLabel, title, titleValue, children }: PillContent & {
  ariaLabel: string
  title: string
  titleValue?: string
  children: ReactNode
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.anchor} data-composer-stat={stat}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => { setOpen(!open) }}
      >
        {icon}
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={title}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              {icon}
              {title}
            </span>
            {titleValue !== undefined && <span className={dialogCss.titleValue}>{titleValue}</span>}
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn and step counts with whole-session speed, opening the time and speed
 * dialog using the complete durable session.
 */
export const ActivityPill = memo(function ActivityPill({ metrics, t }: StatPillProps) {
  const stats = metrics.sessionStats
  const speed = stats.decodeMs > 0 ? decodeSpeed(stats, t) : null
  const icon = <IconGaugeOutlineRegular />
  if (stats.steps === 0) return null
  const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
  const content: PillContent = { stat: 'activity', icon, label: joined(counts, speed) }
  // A window without one timed figure has no dialog rows to show, so the pill
  // stays a plain reading instead of a button opening an empty dialog.
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return <PlainPill {...content} />
  return (
    <DialogPill {...content} ariaLabel={speed === null ? counts : `${counts} · ${speed}`} title={t('stats.dialog.title')}>
      <dl className={dialogCss.details} data-session-stats-details>
        {stats.llmMs > 0 && (
          <>
            <dt>{t('stats.dialog.llmTime')}</dt>
            <dd>{formatDuration(stats.llmMs, t)}</dd>
          </>
        )}
        {stats.toolMs > 0 && (
          <>
            <dt>{t('stats.dialog.toolTime')}</dt>
            <dd>{formatDuration(stats.toolMs, t)}</dd>
          </>
        )}
        {stats.ttftSteps > 0 && (
          <>
            <dt>{t('stats.dialog.ttft')}</dt>
            <dd>{formatDuration(stats.ttftMs / stats.ttftSteps, t)}</dd>
          </>
        )}
        {speed !== null && (
          <>
            <dt>{t('stats.dialog.speed')}</dt>
            <dd>{speed}</dd>
          </>
        )}
      </dl>
    </DialogPill>
  )
})

/** Whole-log token total and cache hit with exact billing buckets. */
export const UsagePill = memo(function UsagePill({ metrics, t }: StatPillProps) {
  const usage = metrics.tokenUsage
  // Gated on actual token activity: a session whose steps all settled without
  // billing (e.g. every request failed) shows no usage pill.
  if (usage === undefined || (billedInputTokens(usage) === 0 && usage.outputTokens === 0)) return null
  const cacheHit = cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('stats.cacheHit', { percent: cacheHit }) : null
  const icon = <IconDatabaseOutlineRegular />
  // Same aggregate as the Turn pill's totalTokens: every prompt-side billing bucket plus output.
  const total = billedInputTokens(usage) + usage.outputTokens
  const totalText = t('message.turnUsage.count', { count: formatTokens(total, t) })
  return (
    <DialogPill
      stat="usage"
      icon={icon}
      label={joined(totalText, cacheHitText)}
      ariaLabel={cacheHitText === null ? totalText : `${totalText} · ${cacheHitText}`}
      title={t('stats.dialog.usageTitle')}
      titleValue={exactCount(total, t)}
    >
      {/* jscpd:ignore-start -- the session-total bucket rows deliberately mirror
          TurnUsagePanel's per-turn dl: same skin, different data contract (the
          buckets are always present here; per-turn fields are optional). A
          session that never wrote cache drops the row, as the per-turn panel
          drops its absent fields. */}
      <dl className={dialogCss.details} data-session-stats-usage>
        {cacheHit !== null && (
          <>
            <dt>{t('message.turnUsage.cacheHit')}</dt>
            <dd>{`${cacheHit}%`}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.input')}</dt>
        <dd>{exactCount(usage.uncachedInputTokens, t)}</dd>
        <dt>{t('message.turnUsage.cacheRead')}</dt>
        <dd>{exactCount(usage.cacheReadTokens, t)}</dd>
        {usage.cacheWriteTokens !== 0 && (
          <>
            <dt>{t('message.turnUsage.cacheWrite')}</dt>
            <dd>{exactCount(usage.cacheWriteTokens, t)}</dd>
          </>
        )}
        <dt>{t('message.turnUsage.output')}</dt>
        <dd>{exactCount(usage.outputTokens, t)}</dd>
      </dl>
      {/* jscpd:ignore-end */}
    </DialogPill>
  )
})
