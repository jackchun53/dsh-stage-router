import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs, StateDot, Tag, type SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SchemeConfig, StageRouterConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { IconButton, icons } from '../parts.js'
import { useStageRouterStyles } from '../styles.js'
import { EditorApiError, type CatalogProvider, type EditorApi, type EditorConfigView } from './api.js'
import { JevCard } from './JevCard.js'
import { addScheme, duplicateScheme, issuesAt, normalizeIssues, removeScheme, setJev, updateScheme } from './model.js'
import { StagesTab } from './StagesTab.js'
import { SubagentsTab } from './SubagentsTab.js'
import { TransitionsTab } from './TransitionsTab.js'
import { OverviewTab } from './OverviewTab.js'
import { Select, type T } from './ui.js'

export interface EditorInjected {
  api: EditorApi
}

export type EditorProps = PropsRuntime<'settings.section'> & InjectFace<EditorInjected> & PropsLocale<'stage-router'>

type Tab = 'overview' | 'stages' | 'transitions' | 'subagents' | 'jev'
const TABS = ['overview', 'stages', 'transitions', 'subagents', 'jev'] as const satisfies readonly Tab[]

/** Warnings (unavailable model, Jev not configured) do not block saving. */
const isWarning = (issue: ConfigIssue) => issue.severity === 'warning'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The stage-router settings page: a sticky scheme switcher and save bar, then one tab per concern. */
export function StageRouterEditor({ api, t }: EditorProps) {
  useStageRouterStyles()
  const tt = t as unknown as T
  const [saved, setSaved] = useState<EditorConfigView | null>(null)
  const [draft, setDraft] = useState<StageRouterConfig | null>(null)
  /** Remove the saved Jev token on the next save. */
  const [clearToken, setClearToken] = useState(false)
  const [catalog, setCatalog] = useState<CatalogProvider[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<Tab>('overview')
  /** A stage to open (and scroll to) on the Stages tab; the ticket remounts the tab so a repeat jump opens it again. */
  const [focus, setFocus] = useState<{ stage: number; ticket: number } | null>(null)
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

  // Validate the draft (schema, structure, model availability, Jev) shortly after each edit.
  useEffect(() => {
    if (draft === null) return
    const ticket = ++validation.current
    const timer = setTimeout(() => {
      api.validate(draft, clearToken).then(found => {
        if (ticket === validation.current) setIssues(normalizeIssues(draft, found))
      }, () => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [api, draft, clearToken])

  const errors = useMemo(() => issues.filter(issue => !isWarning(issue)), [issues])
  const warnings = useMemo(() => issues.filter(isWarning), [issues])

  const page = (toolbar: ReactNode, body: ReactNode) => (
    <div className="sr-page" aria-label={tt('editor.tab')}>
      <header className="sr-header">
        <h2 className="sr-title">{tt('editor.tab')}</h2>
        <p className="sr-intro">{tt('editor.intro')}</p>
      </header>
      {toolbar}
      {body}
    </div>
  )

  if (loadError !== null) return page(null, <div role="alert" className="sr-banner" data-tone="error">{tt('editor.loadFailed', { error: loadError })}</div>)
  if (saved === null || draft === null) return page(null, <div className="sr-empty">{tt('editor.loading')}</div>)

  const readonly = !saved.writable
  const dirty = !same(draft, saved.config) || clearToken
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
    api.save(draft, saved.revision, clearToken).then(view => {
      setSaved({ config: view.config, revision: view.revision, writable: view.writable, jevTokenSet: view.jevTokenSet })
      setDraft(structuredClone(view.config))
      setClearToken(false)
      setIssues(normalizeIssues(view.config, view.warnings))
      setStatus({ kind: 'saved' })
    }, (reason: unknown) => {
      if (reason instanceof EditorApiError && reason.issues.length > 0) setIssues(normalizeIssues(draft, reason.issues))
      setStatus({ kind: 'failed', text: reason instanceof Error ? reason.message : String(reason) })
    })
  }
  const revert = () => {
    setDraft(structuredClone(saved.config))
    setClearToken(false)
    setStatus({ kind: 'idle' })
  }

  const tabs = TABS.map(value => ({ value, label: tt(`tab.${value}`), id: `sr-tab-${value}`, panelId: `sr-panel-${value}` })) as
    unknown as readonly [SegmentedTab<Tab>, ...SegmentedTab<Tab>[]]
  const broken = (i: number) => issuesAt(errors, `schemes[${i}]`).length > 0
  const jevReady = draft.jev.baseUrl.trim() !== '' && ((saved.jevTokenSet && !clearToken) || draft.jev.token.trim() !== '')
  const openStage = (stage: number) => { setFocus({ stage, ticket: Date.now() }); setTab('stages') }

  const toolbar = (
    <div className="sr-toolbar">
      <div className="sr-toolbar-row">
        <div className="sr-scheme-picker">
          {draft.schemes.length > 0 && (
            <Select ariaLabel={tt('editor.schemes')} value={String(index)}
              options={draft.schemes.map((item, i) => ({ value: String(i), label: `${item.name || item.id}${broken(i) ? tt('editor.schemeHasErrors') : ''}` }))}
              onChange={value => { setSelected(Number(value)); setFocus(null) }} />
          )}
          {scheme !== undefined && broken(index) && (
            <span className="sr-dot" title={tt('editor.hasErrors')} aria-label={tt('editor.hasErrors')}><StateDot state="error" size={8} /></span>
          )}
          <div className="sr-tools">
            <IconButton label={tt('editor.newScheme')} disabled={readonly}
              onClick={() => { change(addScheme(draft)); setSelected(draft.schemes.length); setTab('overview') }}>{icons.plus}</IconButton>
            <IconButton label={tt('editor.duplicate')} disabled={readonly || scheme === undefined}
              onClick={() => { change(duplicateScheme(draft, index)); setSelected(index + 1) }}>{icons.copy}</IconButton>
            <IconButton label={tt('editor.delete')} danger disabled={readonly || scheme === undefined}
              onClick={() => { change(removeScheme(draft, index)); setSelected(Math.max(0, index - 1)) }}>{icons.remove}</IconButton>
          </div>
        </div>
        <div className="sr-actions">
          <span role="status" className="sr-status">
            {status.kind === 'saved' ? tt('editor.saved') : dirty ? tt('editor.unsaved') : ''}
          </span>
          {errors.length > 0 && <Tag tone="danger">{tt('editor.errors', { count: errors.length })}</Tag>}
          {warnings.length > 0 && <Tag tone="warning">{tt('editor.warnings', { count: warnings.length })}</Tag>}
          <Button variant="outline" size="sm" disabled={!dirty || status.kind === 'saving'} onClick={revert}>
            {tt('editor.revert')}
          </Button>
          <Button variant="primary" size="sm" disabled={readonly || !dirty || errors.length > 0 || status.kind === 'saving'} onClick={save}>
            {status.kind === 'saving' ? tt('editor.saving') : tt('editor.save')}
          </Button>
        </div>
      </div>
      <div className="sr-toolbar-row">
        <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={scheme === undefined ? tt('editor.tab') : scheme.name || scheme.id} />
        <button type="button" className="sr-jev-status" onClick={() => setTab('jev')}
          aria-label={tt('jev.status', { state: jevReady ? tt('jev.configured') : tt('jev.notConfigured') })}>
          <StateDot state={jevReady ? 'done' : 'warning'} />
          <span>{jevReady ? tt('jev.configuredShort') : tt('jev.notConfiguredShort')}</span>
        </button>
      </div>
    </div>
  )

  return page(toolbar, (
    <>
      {readonly && <div className="sr-banner" data-tone="warning">{tt('editor.readonly')}</div>}
      {status.kind === 'failed' && <div role="alert" className="sr-banner" data-tone="error">{tt('editor.saveFailed', { error: status.text ?? '' })}</div>}

      <div role="tabpanel" id={`sr-panel-${tab}`} aria-labelledby={`sr-tab-${tab}`} className="sr-panel">
        {tab === 'jev' && (
          <JevCard
            jev={draft.jev}
            tokenSet={saved.jevTokenSet && !clearToken}
            clearing={clearToken}
            issues={issuesAt(issues, 'jev')}
            readonly={readonly}
            t={tt}
            onChange={patch => change(setJev(draft, patch))}
            onClearToken={() => { setClearToken(true); change(setJev(draft, { token: '' })) }}
            draft={draft}
            scheme={scheme}
            api={api}
          />
        )}
        {tab !== 'jev' && scheme === undefined && <div className="sr-empty">{tt('editor.noSchemes')}</div>}
        {scheme !== undefined && tab === 'overview' && (
          <OverviewTab scheme={scheme} base={base} issues={issues} catalog={catalog} onChange={changeScheme} onOpenStage={openStage} t={tt} readonly={readonly} />
        )}
        {scheme !== undefined && tab === 'stages' && (
          <StagesTab key={`${index}:${focus?.ticket ?? 0}`} focus={focus?.stage} scheme={scheme} base={base} issues={issues} catalog={catalog}
            onChange={changeScheme} t={tt} readonly={readonly} />
        )}
        {scheme !== undefined && tab === 'transitions' && <TransitionsTab scheme={scheme} base={base} issues={issues} onChange={changeScheme} t={tt} readonly={readonly} />}
        {scheme !== undefined && tab === 'subagents' && <SubagentsTab scheme={scheme} base={base} issues={issues} onChange={changeScheme} t={tt} readonly={readonly} />}
      </div>
    </>
  ))
}
