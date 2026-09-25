import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SchemeConfig, StageRouterConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { EditorApiError, type CatalogProvider, type EditorApi } from './api.js'
import { JudgeFields, JudgeTab } from './JudgeTab.js'
import { addScheme, duplicateScheme, issuesAt, normalizeIssues, removeScheme, setDefaultJudge, updateScheme } from './model.js'
import { StagesTab } from './StagesTab.js'
import { TransitionsTab } from './TransitionsTab.js'
import { Button, Field, Issues, Select, TextInput, styles, type T } from './ui.js'

export interface EditorInjected {
  api: EditorApi
}

export type EditorProps = PropsRuntime<'settings.plugins.tab'> & InjectFace<EditorInjected> & PropsLocale<'stage-router'>

type Tab = 'basic' | 'stages' | 'transitions' | 'judge'
const TABS: Tab[] = ['basic', 'stages', 'transitions', 'judge']

/** Issues produced by model availability checks; they warn but do not block saving. */
const isWarning = (issue: ConfigIssue) => /当前不可用$/.test(issue.message)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The stage-router settings page: schemes, stages, transitions, judge and a judge playground. */
export function StageRouterEditor({ api, t }: EditorProps) {
  const tt = t as unknown as T
  const [saved, setSaved] = useState<{ config: StageRouterConfig; revision: number; writable: boolean } | null>(null)
  const [draft, setDraft] = useState<StageRouterConfig | null>(null)
  const [catalog, setCatalog] = useState<CatalogProvider[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<Tab>('basic')
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'failed'; text?: string }>({ kind: 'idle' })
  const validation = useRef(0)

  useEffect(() => {
    let alive = true
    api.getConfig().then(view => {
      if (!alive) return
      setSaved(view)
      setDraft(structuredClone(view.config))
    }, (reason: unknown) => { if (alive) setLoadError(reason instanceof Error ? reason.message : String(reason)) })
    api.catalog().then(value => { if (alive) setCatalog(value) }, () => {})
    return () => { alive = false }
  }, [api])

  // Validate the draft (schema, structure, model availability) shortly after each edit.
  useEffect(() => {
    if (draft === null) return
    const ticket = ++validation.current
    const timer = setTimeout(() => {
      api.validate(draft).then(found => {
        if (ticket === validation.current) setIssues(normalizeIssues(draft, found))
      }, () => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [api, draft])

  const errors = useMemo(() => issues.filter(issue => !isWarning(issue)), [issues])
  const warnings = useMemo(() => issues.filter(isWarning), [issues])

  if (loadError !== null) return <div role="alert" style={styles.error}>{tt('editor.loadFailed', { error: loadError })}</div>
  if (saved === null || draft === null) return <div style={styles.muted}>{tt('editor.loading')}</div>

  const readonly = !saved.writable
  const dirty = !same(draft, saved.config)
  const index = Math.min(selected, Math.max(0, draft.schemes.length - 1))
  const scheme = draft.schemes[index]
  const base = `schemes[${index}]`
  const change = (next: StageRouterConfig) => {
    setDraft(next)
    if (status.kind !== 'saving') setStatus({ kind: 'idle' })
  }
  const changeScheme = (next: SchemeConfig) => change(updateScheme(draft, index, () => next))

  const save = () => {
    setStatus({ kind: 'saving' })
    api.save(draft, saved.revision).then(view => {
      setSaved({ config: view.config, revision: view.revision, writable: view.writable })
      setDraft(structuredClone(view.config))
      setIssues(normalizeIssues(view.config, view.warnings))
      setStatus({ kind: 'saved' })
    }, (reason: unknown) => {
      if (reason instanceof EditorApiError && reason.issues.length > 0) setIssues(normalizeIssues(draft, reason.issues))
      setStatus({ kind: 'failed', text: reason instanceof Error ? reason.message : String(reason) })
    })
  }

  const tabButton = (value: Tab): CSSProperties => ({
    ...styles.button,
    fontWeight: tab === value ? 600 : 400,
    borderColor: tab === value ? 'var(--dsw-color-accent, #2f6fed)' : undefined,
  })

  return (
    <div style={{ ...styles.column, maxWidth: 980 }} aria-label={tt('editor.tab')}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <div style={styles.row}>
          <Button primary disabled={readonly || !dirty || errors.length > 0 || status.kind === 'saving'} onClick={save}>
            {status.kind === 'saving' ? tt('editor.saving') : tt('editor.save')}
          </Button>
          <Button disabled={!dirty || status.kind === 'saving'} onClick={() => { setDraft(structuredClone(saved.config)); setStatus({ kind: 'idle' }) }}>
            {tt('editor.revert')}
          </Button>
          <span role="status" style={styles.muted}>
            {status.kind === 'saved' ? tt('editor.saved') : dirty ? tt('editor.unsaved') : ''}
          </span>
        </div>
        <div style={{ display: 'grid', justifyItems: 'end' }}>
          {errors.length > 0 && <span style={styles.error}>{tt('editor.errors', { count: errors.length })}</span>}
          {warnings.length > 0 && <span style={styles.warning}>{tt('editor.warnings', { count: warnings.length })}</span>}
        </div>
      </div>
      {readonly && <div style={styles.warning}>{tt('editor.readonly')}</div>}
      {status.kind === 'failed' && <div role="alert" style={styles.error}>{tt('editor.saveFailed', { error: status.text ?? '' })}</div>}

      <details style={styles.card}>
        <summary style={{ cursor: 'pointer' }}><strong>{tt('editor.defaultJudge')}</strong></summary>
        <JudgeFields judge={draft.defaultJudge} catalog={catalog} t={tt} readonly={readonly} issues={issues} path="defaultJudge"
          onChange={patch => change(setDefaultJudge(draft, patch))} />
      </details>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) 1fr', gap: 16, alignItems: 'start' }}>
        <nav aria-label={tt('editor.schemes')} style={styles.column}>
          <strong>{tt('editor.schemes')}</strong>
          {draft.schemes.map((item, i) => (
            <button key={i} type="button" onClick={() => setSelected(i)}
              style={{ ...styles.button, textAlign: 'left', height: 'auto', padding: '6px 10px', fontWeight: i === index ? 600 : 400 }}>
              <div>{item.name || item.id}</div>
              <div style={styles.muted}>stage-router/{item.id}</div>
              {issuesAt(errors, `schemes[${i}]`).length > 0 && <div style={styles.error}>!</div>}
            </button>
          ))}
          {draft.schemes.length === 0 && <span style={styles.muted}>{tt('editor.noSchemes')}</span>}
          <div style={styles.row}>
            <Button disabled={readonly} onClick={() => { change(addScheme(draft)); setSelected(draft.schemes.length); setTab('basic') }}>{tt('editor.newScheme')}</Button>
            <Button disabled={readonly || scheme === undefined} onClick={() => { change(duplicateScheme(draft, index)); setSelected(index + 1) }}>{tt('editor.duplicate')}</Button>
            <Button disabled={readonly || scheme === undefined} onClick={() => { change(removeScheme(draft, index)); setSelected(Math.max(0, index - 1)) }}>{tt('editor.delete')}</Button>
          </div>
        </nav>

        {scheme !== undefined && (
          <div style={styles.column}>
            <div role="tablist" style={styles.row}>
              {TABS.map(value => (
                <button key={value} type="button" role="tab" aria-selected={tab === value} style={tabButton(value)} onClick={() => setTab(value)}>
                  {tt(`tab.${value}`)}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'basic' && (
                <div style={styles.column}>
                  <Field label={tt('field.name')}>
                    <TextInput ariaLabel={tt('field.name')} value={scheme.name} disabled={readonly} onChange={name => changeScheme({ ...scheme, name })} />
                  </Field>
                  <Field label={tt('field.id')} issues={issuesAt(issues, `${base}.id`)}>
                    <TextInput ariaLabel={tt('field.id')} value={scheme.id} disabled={readonly}
                      onCommit={id => id !== '' && changeScheme({ ...scheme, id })} />
                  </Field>
                  <Field label={tt('field.initialStage')} issues={issuesAt(issues, `${base}.initialStage`)}>
                    <Select ariaLabel={tt('field.initialStage')} value={scheme.initialStage} disabled={readonly}
                      options={scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))}
                      onChange={initialStage => changeScheme({ ...scheme, initialStage })} />
                  </Field>
                  <Issues issues={issuesAt(issues, base).filter(issue => /^schemes\[\d+\]$/.test(issue.path))} />
                </div>
              )}
              {tab === 'stages' && <StagesTab scheme={scheme} base={base} issues={issues} catalog={catalog} onChange={changeScheme} t={tt} readonly={readonly} />}
              {tab === 'transitions' && <TransitionsTab scheme={scheme} base={base} issues={issues} onChange={changeScheme} t={tt} readonly={readonly} />}
              {tab === 'judge' && <JudgeTab draft={draft} scheme={scheme} index={index} issues={issues} catalog={catalog} api={api} onChange={changeScheme} t={tt} readonly={readonly} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
