import { useCallback, useEffect, useRef, useState } from 'react'
import { Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import './projection.js'
import { modelLabel, type JudgeLogEntry, type StageRouterState } from '../shared/wire.js'
import { IconButton, Probabilities, icons, percent } from './parts.js'
import { useStageRouterStyles } from './styles.js'

/** Business face injected per session by the client entry. */
export interface StageChipInjected {
  /**
   * Run `/stage <args>` in this session.
   * @returns null when admitted; a user-visible failure line otherwise.
   */
  runStage: (args: string) => Promise<string | null>
  /** This session's recent Jev calls, newest last. */
  judgeLog: () => Promise<JudgeLogEntry[]>
}

export type StageChipProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<StageChipInjected> & PropsLocale<'stage-router'>

type Translate = StageChipProps['t']

/** True when the session is routed by a stage-router scheme and has a stage. */
export function isRouted(state: StageRouterState | undefined): state is StageRouterState & { stage: string } {
  return state !== undefined && state.scheme !== null && !state.detached && state.stage !== null
}

/** Chip text: "<stage name> · <tier> · <model>". */
export function chipLabel(state: StageRouterState): string {
  return [state.stageName ?? state.stage, state.tier, modelLabel(state.route)].filter(part => part != null && part !== '').join(' · ')
}

/** `HH:MM` for older entries, "刚刚" / "N 分钟前" for recent ones. */
function when(at: number, now: number, t: Translate): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return t('log.justNow')
  if (minutes < 60) return t('log.minutesAgo', { count: minutes })
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Composer chip for sessions routed by stage-router: current stage, tier and
 * model. The panel shows why, locks or unlocks the stage via `/stage`, and
 * lists this session's Jev judgements. Renders nothing for other sessions.
 */
export function StageChip({ useProjection, runStage, judgeLog, t }: StageChipProps) {
  useStageRouterStyles()
  const state = useProjection('stage-router')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => () => { aliveRef.current = false }, [])
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!isRouted(state)) return null
  const label = chipLabel(state)
  const detail = [state.tier, modelLabel(state.route)].filter(part => part != null && part !== '').join(' · ')

  const run = (args: string) => {
    setBusy(true)
    setError(null)
    runStage(args).then(failure => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(failure)
      if (failure === null) setOpen(false)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const name = (id: string | null) => id === null ? '—' : state.stages.find(stage => stage.id === id)?.name || id

  return (
    <span ref={rootRef} className="sr-chip-root">
      <Pill
        active={open}
        className="sr-chip"
        aria-label={t('chip.aria', { label })}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(value => !value)}
      >
        <span className="sr-chip-stage">{state.stageName ?? state.stage}</span>
        {detail !== '' && <span className="sr-chip-detail">{detail}</span>}
        {state.lock !== null && <span className="sr-chip-lock" aria-label={t('chip.locked')} title={t('chip.locked')}>{icons.lock}</span>}
      </Pill>
      {open && (
        <div role="dialog" aria-label={t('panel.title')} className="sr-pop">
          <div className="sr-pop-head">
            <span className="sr-pop-title">{t('panel.title')}</span>
            {state.lock !== null && <Tag tone="warning">{t('chip.locked')}</Tag>}
          </div>
          <dl className="sr-kv">
            <dt>{t('panel.stage')}</dt><dd>{state.stageName ?? state.stage}</dd>
            {state.tier !== null && <><dt>{t('panel.tier')}</dt><dd>{state.tier}</dd></>}
            <dt>{t('panel.model')}</dt><dd>{state.route === null ? '—' : `${state.route.provider}/${modelLabel(state.route)}`}</dd>
            {state.reason !== null && <><dt>{t('panel.reason')}</dt><dd>{state.reason}</dd></>}
          </dl>
          <div className="sr-section">
            <div className="sr-section-head"><span>{t('panel.lock')}</span></div>
            <div className="sr-pills">
              {state.stages.map(stage => (
                <Pill key={stage.id} active={stage.id === state.lock} disabled={busy || stage.id === state.lock} onClick={() => run(stage.id)}>
                  {stage.name}
                </Pill>
              ))}
              {state.lock !== null && <Pill disabled={busy} onClick={() => run('auto')}>{t('panel.unlock')}</Pill>}
            </div>
            {busy && <span className="sr-hint">{t('panel.busy')}</span>}
            {error !== null && <span role="status" className="sr-error">{t('panel.failed', { error })}</span>}
          </div>
          <JudgeLogSection load={judgeLog} refreshKey={`${state.notices}:${state.turns.at(-1)?.turn ?? 0}`} name={name} t={t} />
        </div>
      )}
    </span>
  )
}

/** The session's Jev calls, newest first; each stage entry expands to Jev's probabilities. */
function JudgeLogSection({ load, refreshKey, name, t }: {
  load: () => Promise<JudgeLogEntry[]>
  /** Changes when the session routed again, to pull fresh entries. */
  refreshKey: string
  name: (id: string | null) => string
  t: Translate
}) {
  const [entries, setEntries] = useState<JudgeLogEntry[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const ticket = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++ticket.current
    load().then(value => {
      if (mine !== ticket.current) return
      setEntries([...value].reverse())
      setFailure(null)
    }, (reason: unknown) => {
      if (mine === ticket.current) setFailure(reason instanceof Error ? reason.message : String(reason))
    })
  }, [load])

  useEffect(() => { refresh() }, [refresh, refreshKey])
  useEffect(() => () => { ticket.current++ }, [])

  const now = Date.now()
  return (
    <section className="sr-section" aria-label={t('log.title')}>
      <div className="sr-section-head">
        <span>{t('log.title')}</span>
        <IconButton label={t('log.refresh')} onClick={refresh}>{icons.refresh}</IconButton>
      </div>
      {failure !== null && <span className="sr-error">{t('log.unavailable', { error: failure })}</span>}
      {entries === null && failure === null && <span className="sr-hint">{t('log.loading')}</span>}
      {entries !== null && entries.length === 0 && <span className="sr-hint">{t('log.empty')}</span>}
      {entries !== null && entries.length > 0 && (
        <ul className="sr-log">
          {entries.map((entry, i) => {
            const open = expanded === i
            if (entry.kind === 'tier') {
              const tiers = entry.tasks.map((task, j) => `T${j + 1}→${task.tier ?? '—'}`).join('、')
              return (
                <li key={`${entry.at}-${i}`}>
                  <button type="button" className="sr-log-item" aria-expanded={open} onClick={() => setExpanded(open ? null : i)}>
                    <span className="sr-log-line">
                      <span className="sr-log-time">{when(entry.at, now, t)}</span>
                      <span className="sr-log-outcome" data-kind={entry.ok ? 'goto' : 'failed'}>
                        {entry.ok ? `${t('log.tier')} ${tiers}` : t('log.tierFailed')}
                      </span>
                      <span className="sr-log-meta">{entry.elapsedMs} ms</span>
                    </span>
                    <span className="sr-log-text">{entry.ok ? name(entry.stage) : entry.error}</span>
                  </button>
                  {open && (
                    <div className="sr-log-detail">
                      {entry.tasks.map((task, j) => (
                        <span key={j} className="sr-hint">
                          T{j + 1} · {task.tier ?? '—'}{task.confidence === null ? '' : ` · ${percent(task.confidence)}`} — {task.text}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              )
            }
            const moved = entry.to !== entry.from && entry.to !== null
            const outcome = !entry.ok ? 'failed' : moved ? 'goto' : 'stay'
            return (
              <li key={`${entry.at}-${i}`}>
                <button type="button" className="sr-log-item" aria-expanded={open} onClick={() => setExpanded(open ? null : i)}>
                  <span className="sr-log-line">
                    <span className="sr-log-time">{when(entry.at, now, t)}</span>
                    <span className="sr-log-outcome" data-kind={outcome}>
                      {outcome === 'failed'
                        ? t('log.failed')
                        : moved ? t('log.goto', { stage: name(entry.to) }) : t('log.stay', { stage: name(entry.to) })}
                    </span>
                    <span className="sr-log-meta">
                      {entry.confidence === undefined ? '' : `${percent(entry.confidence)} · `}{entry.elapsedMs} ms
                    </span>
                  </span>
                  <span className="sr-log-text">{entry.message}</span>
                </button>
                {open && (
                  <div className="sr-log-detail">
                    {entry.ok && (
                      <Probabilities
                        options={entry.candidates}
                        probabilities={entry.probabilities ?? (entry.choice === undefined ? {} : { [entry.choice]: entry.confidence ?? 0 })}
                        chosen={entry.choice}
                        names={id => name(id)}
                      />
                    )}
                    <span className={entry.ok ? 'sr-hint' : 'sr-error'}>{entry.ok ? entry.reason : entry.error}</span>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
