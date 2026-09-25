import { useRef, useState } from 'react'
import { DEFAULT_JUDGE_TEMPLATE } from '../../config/defaults.js'
import type { JudgeConfig, JudgeOverride, SchemeConfig, StageRouterConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { CatalogProvider, EditorApi, TryJudgeResult } from './api.js'
import { issuesAt } from './model.js'
import { Button, Field, Issues, NumberInput, RoutePicker, Select, TextArea, styles, type T } from './ui.js'

/** Fields shared by the default judge and a scheme override. */
export function JudgeFields({ judge, onChange, catalog, t, readonly, issues, path }: {
  judge: JudgeConfig
  onChange: (patch: Partial<JudgeConfig>) => void
  catalog: readonly CatalogProvider[]
  t: T
  readonly: boolean
  issues: readonly ConfigIssue[]
  path: string
}) {
  return (
    <div style={styles.column}>
      <Field label={t('field.model')} issues={issuesAt(issues, `${path}.route`)}>
        <RoutePicker label={t('editor.defaultJudge')} route={judge.route} catalog={catalog} t={t} disabled={readonly}
          onChange={route => onChange({ route })} />
      </Field>
      <div style={styles.row}>
        <Field label={t('judge.timeout')}>
          <NumberInput ariaLabel={t('judge.timeout')} value={judge.timeoutMs} min={100} step={500} disabled={readonly} onChange={timeoutMs => onChange({ timeoutMs })} />
        </Field>
        <Field label={t('judge.minConfidence')}>
          <NumberInput ariaLabel={t('judge.minConfidence')} value={judge.minConfidence} min={0} max={1} step={0.05} disabled={readonly} onChange={minConfidence => onChange({ minConfidence })} />
        </Field>
        <Field label={t('judge.contextTurns')}>
          <NumberInput ariaLabel={t('judge.contextTurns')} value={judge.contextTurns} min={0} step={1} disabled={readonly} onChange={contextTurns => onChange({ contextTurns })} />
        </Field>
      </div>
      <Field label={t('judge.template')}>
        <TextArea ariaLabel={t('judge.template')} rows={8} value={judge.promptTemplate ?? ''} placeholder={DEFAULT_JUDGE_TEMPLATE}
          disabled={readonly} onChange={value => onChange({ promptTemplate: value === '' ? null : value })} />
      </Field>
      <div style={styles.row}>
        <span style={styles.muted}>{judge.promptTemplate === null ? t('judge.templateDefault') : ''}</span>
        {judge.promptTemplate !== null && (
          <Button disabled={readonly} onClick={() => onChange({ promptTemplate: null })}>{t('judge.resetTemplate')}</Button>
        )}
      </div>
    </div>
  )
}

export function JudgeTab({ draft, scheme, index, issues, catalog, api, onChange, t, readonly }: {
  draft: StageRouterConfig
  scheme: SchemeConfig
  index: number
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  api: EditorApi
  onChange: (scheme: SchemeConfig) => void
  t: T
  readonly: boolean
}) {
  const base = `schemes[${index}]`
  const override = scheme.judge ?? null
  const merged: JudgeConfig = { ...draft.defaultJudge, ...stripUndefined(override ?? {}) }
  const stageOptions = scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))
  return (
    <div style={styles.column}>
      <label style={styles.row}>
        <input type="checkbox" checked={override !== null} disabled={readonly} aria-label={t('judge.override')}
          onChange={event => onChange({ ...scheme, judge: event.target.checked ? { ...draft.defaultJudge } : null })} />
        <span>{t('judge.override')}</span>
      </label>
      {override !== null && (
        <JudgeFields judge={merged} catalog={catalog} t={t} readonly={readonly} issues={issues} path={`${base}.judge`}
          onChange={patch => onChange({ ...scheme, judge: { ...override, ...patch } as JudgeOverride })} />
      )}

      <TryIt draft={draft} scheme={scheme} api={api} t={t} />

      <section style={styles.card} aria-label={t('sub.title')}>
        <strong>{t('sub.title')}</strong>
        <label style={styles.row}>
          <input type="checkbox" checked={scheme.subagents.enabled} disabled={readonly} aria-label={t('sub.enabled')}
            onChange={event => onChange({ ...scheme, subagents: { ...scheme.subagents, enabled: event.target.checked } })} />
          <span>{t('sub.enabled')}</span>
        </label>
        <Field label={t('sub.stage')} issues={issuesAt(issues, `${base}.subagents.stage`)}>
          <Select ariaLabel={t('sub.stage')} value={scheme.subagents.stage} disabled={readonly || !scheme.subagents.enabled}
            options={[{ value: 'inherit', label: t('sub.inherit') }, ...stageOptions]}
            onChange={stage => onChange({ ...scheme, subagents: { ...scheme.subagents, stage } })} />
        </Field>
        <label style={styles.row}>
          <input type="checkbox" checked={scheme.subagents.classify} disabled={readonly || !scheme.subagents.enabled} aria-label={t('sub.classify')}
            onChange={event => onChange({ ...scheme, subagents: { ...scheme.subagents, classify: event.target.checked } })} />
          <span>{t('sub.classify')}</span>
        </label>
      </section>
    </div>
  )
}

function stripUndefined<V extends object>(value: V): Partial<V> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<V>
}

/** Run the draft scheme's rules and judge on one message. */
function TryIt({ draft, scheme, api, t }: { draft: StageRouterConfig; scheme: SchemeConfig; api: EditorApi; t: T }) {
  const [current, setCurrent] = useState<string>('')
  const [message, setMessage] = useState('')
  const [recent, setRecent] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TryJudgeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)

  const go = () => {
    const ticket = ++run.current
    setBusy(true)
    setError(null)
    api.tryJudge({ draft, scheme: scheme.id, current: current === '' ? null : current, message, recent }).then(
      value => { if (ticket === run.current) { setResult(value); setBusy(false) } },
      (reason: unknown) => { if (ticket === run.current) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) } },
    )
  }

  const name = (id: string) => scheme.stages.find(stage => stage.id === id)?.name || id
  const judgement = result?.judgement
  return (
    <section style={styles.card} aria-label={t('try.title')}>
      <strong>{t('try.title')}</strong>
      <span style={styles.muted}>{t('try.unsaved')}</span>
      <Field label={t('try.current')}>
        <Select ariaLabel={t('try.current')} value={current}
          options={[{ value: '', label: t('try.first') }, ...scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))]}
          onChange={setCurrent} />
      </Field>
      <Field label={t('try.message')}>
        <TextArea ariaLabel={t('try.message')} value={message} onChange={setMessage} />
      </Field>
      <Field label={t('try.recent')}>
        <TextArea ariaLabel={t('try.recent')} value={recent} rows={2} onChange={setRecent} />
      </Field>
      <div><Button primary disabled={busy || message.trim() === ''} onClick={go}>{busy ? t('try.running') : t('try.run')}</Button></div>
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      {result !== null && (
        <div role="status" style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <Issues issues={result.issues} />
          {result.candidates.length > 0 && <span>{t('try.candidates', { list: result.candidates.map(name).join(', ') })}</span>}
          {judgement === undefined
            ? <span style={styles.muted}>{t('try.noJudge')}</span>
            : judgement.ok
              ? <span>{t('try.judgement', { stage: name(judgement.stage), confidence: judgement.confidence.toFixed(2), elapsed: judgement.elapsedMs, reason: judgement.reason || '—' })}</span>
              : <span style={styles.error}>{t('try.failed', { error: judgement.error })}</span>}
          <strong>
            {result.decision.kind === 'goto'
              ? t('try.goto', { stage: name(result.decision.stage), reason: result.decision.reason })
              : t('try.stay', { reason: result.decision.kind === 'stay' ? result.decision.reason : '' })}
          </strong>
        </div>
      )}
    </section>
  )
}
