import { useRef, useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JevConfig, SchemeConfig, StageRouterConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { Probabilities } from '../parts.js'
import type { EditorApi, TryJudgeResult } from './api.js'
import { Field, Issues, NumberInput, Select, TextArea, TextInput, type T } from './ui.js'

/** The Jev tab: connection and thresholds, then a playground that runs Jev on the unsaved draft. */
export function JevCard({ jev, tokenSet, clearing, issues, readonly, t, onChange, onClearToken, draft, scheme, api }: {
  jev: JevConfig
  /** A token is saved on the host (and not about to be cleared). */
  tokenSet: boolean
  clearing: boolean
  issues: readonly ConfigIssue[]
  readonly: boolean
  t: T
  onChange: (patch: Partial<JevConfig>) => void
  onClearToken: () => void
  draft: StageRouterConfig
  scheme: SchemeConfig | undefined
  api: EditorApi
}) {
  const configured = jev.baseUrl.trim() !== '' && (tokenSet || jev.token.trim() !== '')
  return (
    <div className="sr-stack">
      <section className="sr-card" aria-label={t('jev.title')}>
        <div className="sr-card-head">
          <div className="sr-card-title"><span>{t('jev.connection')}</span></div>
          <span className="sr-inline">
            <StateDot state={configured ? 'done' : 'warning'} />
            {configured ? t('jev.configured') : t('jev.notConfigured')}
          </span>
        </div>
        <span className="sr-hint">{t('jev.connectionHint')}</span>
        <div className="sr-grid-2">
          <Field label={t('jev.baseUrl')}>
            <TextInput ariaLabel={t('jev.baseUrl')} type="url" mono value={jev.baseUrl} disabled={readonly} onChange={baseUrl => onChange({ baseUrl })} />
          </Field>
          <Field label={t('jev.token')} hint={clearing ? t('jev.tokenCleared') : undefined}>
            <div className="sr-row" style={{ flexWrap: 'nowrap' }}>
              <TextInput ariaLabel={t('jev.token')} type="password" mono value={jev.token} disabled={readonly}
                placeholder={tokenSet ? t('jev.tokenSaved') : t('jev.tokenEmpty')} onChange={token => onChange({ token })} />
              {tokenSet && (
                <Button variant="outline" size="sm" className="sr-nowrap" disabled={readonly} onClick={onClearToken}>{t('jev.clearToken')}</Button>
              )}
            </div>
          </Field>
        </div>
        <div className="sr-grid-2">
          <Field label={t('jev.model')}>
            <TextInput ariaLabel={t('jev.model')} mono value={jev.model} disabled={readonly} onChange={model => onChange({ model })} />
          </Field>
          <Field label={t('jev.timeout')}>
            <NumberInput ariaLabel={t('jev.timeout')} value={jev.timeoutMs} min={100} step={500} disabled={readonly} onChange={timeoutMs => onChange({ timeoutMs })} />
          </Field>
          <Field label={t('jev.minConfidence')}>
            <NumberInput ariaLabel={t('jev.minConfidence')} value={jev.minConfidence} min={0} max={1} step={0.05} disabled={readonly} onChange={minConfidence => onChange({ minConfidence })} />
          </Field>
          <Field label={t('jev.contextTurns')}>
            <NumberInput ariaLabel={t('jev.contextTurns')} value={jev.contextTurns} min={0} step={1} disabled={readonly} onChange={contextTurns => onChange({ contextTurns })} />
          </Field>
        </div>
        <Issues issues={issues} warning />
      </section>
      {scheme !== undefined && <TryIt draft={draft} scheme={scheme} api={api} t={t} />}
    </div>
  )
}

/** Run the draft scheme's rules and Jev on one message. */
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
  const decision = result?.decision
  return (
    <section className="sr-card" aria-label={t('try.title')}>
      <div className="sr-card-head">
        <div className="sr-card-title"><span>{t('try.title')}</span></div>
      </div>
      <span className="sr-hint">{t('try.hint')}</span>
      <div className="sr-grid-2">
        <Field label={t('try.scheme')}>
          <TextInput ariaLabel={t('try.scheme')} value={scheme.name || scheme.id} disabled />
        </Field>
        <Field label={t('try.current')}>
          <Select ariaLabel={t('try.current')} value={current}
            options={[{ value: '', label: t('try.first') }, ...scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))]}
            onChange={setCurrent} />
        </Field>
      </div>
      <div className="sr-grid-2">
        <Field label={t('try.message')}>
          <TextArea ariaLabel={t('try.message')} value={message} onChange={setMessage} />
        </Field>
        <Field label={t('try.recent')}>
          <TextArea ariaLabel={t('try.recent')} value={recent} onChange={setRecent} />
        </Field>
      </div>
      <div className="sr-row">
        <Button variant="primary" size="sm" disabled={busy || message.trim() === ''} onClick={go}>{busy ? t('try.running') : t('try.run')}</Button>
      </div>
      {error !== null && <div role="alert" className="sr-error">{error}</div>}
      {result !== null && decision !== undefined && (
        <div role="status" className="sr-result">
          <Issues issues={result.issues} />
          <div className="sr-row">
            {judgement !== undefined && !judgement.ok
              ? <Tag tone="danger">{t('try.failed', { error: judgement.error })}</Tag>
              : decision.kind === 'goto'
                ? <Tag tone="success">{t('try.goto', { stage: name(decision.stage) })}</Tag>
                : <Tag tone="neutral">{t('try.stay')}</Tag>}
            {judgement !== undefined && <span className="sr-hint">{t('try.elapsed', { elapsed: judgement.elapsedMs })}</span>}
          </div>
          {decision.kind !== 'judge' && <span className="sr-hint">{decision.reason}</span>}
          {judgement === undefined
            ? <span className="sr-hint">{t('try.noJudge')}</span>
            : judgement.ok && (
              <Probabilities
                options={result.candidates}
                probabilities={judgement.probabilities ?? { [judgement.stage]: judgement.confidence }}
                chosen={judgement.stage}
                names={name}
              />
            )}
          {result.candidates.length > 0 && judgement === undefined && (
            <span className="sr-hint">{t('try.candidates', { list: result.candidates.map(name).join('、') })}</span>
          )}
        </div>
      )}
    </section>
  )
}
