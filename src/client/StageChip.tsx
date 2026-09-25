import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import './projection.js'
import { modelLabel, type StageRouterState } from '../shared/wire.js'

/** Business face injected per session by the client entry. */
export interface StageChipInjected {
  /**
   * Run `/stage <args>` in this session.
   * @returns null when admitted; a user-visible failure line otherwise.
   */
  runStage: (args: string) => Promise<string | null>
}

export type StageChipProps =
  PropsRuntime<'conversation.input.right'> & InjectFace<StageChipInjected> & PropsLocale<'stage-router'>

/** True when the session is routed by a stage-router scheme and has a stage. */
export function isRouted(state: StageRouterState | undefined): state is StageRouterState & { stage: string } {
  return state !== undefined && state.scheme !== null && !state.detached && state.stage !== null
}

/** Chip text: "<stage name> · <tier> · <model>". */
export function chipLabel(state: StageRouterState): string {
  return [state.stageName ?? state.stage, state.tier, modelLabel(state.route)].filter(part => part != null && part !== '').join(' · ')
}

const chip: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 8px', maxWidth: 260,
  border: '1px solid var(--dsw-color-border, rgba(127,127,127,.35))', borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
}
const panel: CSSProperties = {
  position: 'absolute', right: 0, bottom: 'calc(100% + 6px)', zIndex: 50, minWidth: 260, maxWidth: 360, padding: 12,
  border: '1px solid var(--dsw-color-border, rgba(127,127,127,.35))', borderRadius: 'var(--dsw-radius-md, 8px)',
  background: 'var(--dsw-color-surface-raised, var(--dsw-color-bg, #fff))', color: 'inherit', fontSize: 12,
  boxShadow: '0 6px 24px rgba(0,0,0,.18)', display: 'grid', gap: 6,
}
const row: CSSProperties = { display: 'flex', gap: 8, justifyContent: 'space-between' }
const muted: CSSProperties = { opacity: 0.7 }
const actionButton: CSSProperties = { ...chip, height: 24, padding: '0 6px' }

/**
 * Composer chip for sessions routed by stage-router: current stage, tier and
 * model; the panel shows the last decision and locks or unlocks the stage via
 * `/stage`. Renders nothing for other sessions.
 */
export function StageChip({ useProjection, runStage, t }: StageChipProps) {
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

  const judge = state.judge
  const judgeText = judge === null
    ? t('panel.judge.none')
    : judge.ok
      ? t('panel.judge.ok', { stage: judge.stage ?? '?', confidence: judge.confidence?.toFixed(2) ?? '?' })
      : t('panel.judge.failed', { error: judge.error ?? '?' })

  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        style={chip}
        aria-label={t('chip.aria', { label })}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(value => !value)}
      >
        {label}
        {state.lock !== null && <span style={muted}>· {t('chip.locked')}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label={t('panel.title')} style={panel}>
          <strong>{t('panel.title')}</strong>
          <div style={row}><span style={muted}>{t('panel.stage')}</span><span>{state.stageName ?? state.stage}{state.lock !== null ? ` · ${t('chip.locked')}` : ''}</span></div>
          {state.tier !== null && <div style={row}><span style={muted}>{t('panel.tier')}</span><span>{state.tier}</span></div>}
          <div style={row}><span style={muted}>{t('panel.model')}</span><span>{state.route === null ? '—' : `${state.route.provider}/${modelLabel(state.route)}`}</span></div>
          {state.reason !== null && <div style={row}><span style={muted}>{t('panel.reason')}</span><span>{state.reason}</span></div>}
          <div style={row}><span style={muted}>{t('panel.judge')}</span><span>{judgeText}</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            <span style={muted}>{t('panel.lock')}</span>
            {state.stages.map(stage => (
              <button
                key={stage.id}
                type="button"
                style={{ ...actionButton, fontWeight: stage.id === state.lock ? 600 : 400 }}
                disabled={busy || stage.id === state.lock}
                onClick={() => run(stage.id)}
              >
                {stage.name}
              </button>
            ))}
            {state.lock !== null && (
              <button type="button" style={actionButton} disabled={busy} onClick={() => run('auto')}>{t('panel.unlock')}</button>
            )}
          </div>
          {busy && <span style={muted}>{t('panel.busy')}</span>}
          {error !== null && <span role="status">{t('panel.failed', { error })}</span>}
        </div>
      )}
    </span>
  )
}
