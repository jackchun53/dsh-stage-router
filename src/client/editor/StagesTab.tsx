import { useEffect, useRef, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SchemeConfig, StageConfig, TierSource } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { IconButton, icons } from '../parts.js'
import type { CatalogProvider } from './api.js'
import { addStage, issuesAt, move, moveStage, removeStage, renameStage, toggleTiers, updateStage } from './model.js'
import { Field, GroupTitle, Issues, RoutePicker, Select, TextArea, TextInput, Toggle, routeSummary, type T } from './ui.js'

const TIER_SOURCES: TierSource[] = ['planner', 'judge', 'planner-then-judge']

/** Carry the open state of two cards across a list move. */
const moved = (open: ReadonlySet<number>, from: number, to: number) => {
  const next = new Set(open)
  next.delete(from)
  next.delete(to)
  if (open.has(from)) next.add(to)
  if (open.has(to)) next.add(from)
  return next
}

/** Shift the open set after removing the card at `index`. */
const removed = (open: ReadonlySet<number>, index: number) =>
  new Set([...open].filter(i => i !== index).map(i => i > index ? i - 1 : i))

/** Tier summary shared by collapsed stage cards and the overview. */
export function tiersSummary(tiers: NonNullable<StageConfig['tiers']>, t: T): string {
  return t('overview.tiersSummary', { count: tiers.levels.length, source: t(`tierSource.${tiers.source}`), default: tiers.default ?? tiers.levels[0]?.id ?? '' })
}

export function StagesTab({ scheme, base, issues, catalog, onChange, t, readonly, focus }: {
  scheme: SchemeConfig
  /** Issue path prefix of this scheme, e.g. `schemes[0]`. */
  base: string
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  onChange: (scheme: SchemeConfig) => void
  t: T
  readonly: boolean
  /** Open this stage and scroll to it; without it the first stage starts open. */
  focus?: number | undefined
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set([focus ?? 0]))
  const toggle = (index: number) => setOpen(prev => {
    const next = new Set(prev)
    if (!next.delete(index)) next.add(index)
    return next
  })
  return (
    <div className="sr-stack">
      <Issues issues={issues.filter(issue => issue.path === `${base}.stages`)} />
      {scheme.stages.map((stage, index) => (
        <StageCard
          key={index}
          stage={stage}
          index={index}
          count={scheme.stages.length}
          initial={stage.id === scheme.initialStage}
          open={open.has(index)}
          focused={focus === index}
          path={`${base}.stages[${index}]`}
          issues={issues}
          catalog={catalog}
          t={t}
          readonly={readonly}
          onToggle={() => toggle(index)}
          onRename={id => onChange(renameStage(scheme, index, id))}
          onPatch={patch => onChange(updateStage(scheme, index, patch))}
          onReplace={next => onChange({ ...scheme, stages: scheme.stages.map((s, i) => i === index ? next : s) })}
          onMove={to => { setOpen(prev => moved(prev, index, to)); onChange(moveStage(scheme, index, to)) }}
          onRemove={() => { setOpen(prev => removed(prev, index)); onChange(removeStage(scheme, index)) }}
        />
      ))}
      <div className="sr-row">
        <Button variant="outline" size="sm" icon={icons.plus} disabled={readonly} onClick={() => {
          setOpen(prev => new Set([...prev, scheme.stages.length]))
          onChange(addStage(scheme))
        }}>{t('action.addStage')}</Button>
      </div>
    </div>
  )
}

function StageCard({ stage, index, count, initial, open, focused, path, issues, catalog, t, readonly, onToggle, onRename, onPatch, onReplace, onMove, onRemove }: {
  stage: StageConfig
  index: number
  count: number
  initial: boolean
  open: boolean
  focused: boolean
  path: string
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  t: T
  readonly: boolean
  onToggle: () => void
  onRename: (id: string) => void
  onPatch: (patch: Partial<StageConfig>) => void
  onReplace: (stage: StageConfig) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const tiers = stage.tiers !== undefined && stage.tiers.levels.length > 0 ? stage.tiers : undefined
  const setTiers = (patch: Partial<NonNullable<StageConfig['tiers']>>) => tiers !== undefined && onPatch({ tiers: { ...tiers, ...patch } })
  const label = stage.name || stage.id
  const routeIssues = issuesAt(issues, `${path}.route`)
  const broken = issuesAt(issues, path).some(issue => issue.severity !== 'warning')
  const summary = tiers !== undefined ? tiersSummary(tiers, t) : routeSummary(stage.route, catalog) ?? t('overview.noModel')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { if (focused) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }) }, [focused])
  return (
    <section ref={ref} className="sr-card sr-stage" aria-label={label}>
      <div className="sr-card-head">
        <button type="button" className="sr-stage-head" aria-expanded={open}
          aria-label={t(open ? 'stage.collapse' : 'stage.expand', { name: label })} onClick={onToggle}>
          <span className="sr-chevron" data-open={open ? '' : undefined}>{icons.chevron}</span>
          <span className="sr-index">{index + 1}</span>
          <span className="sr-stage-text">
            <span className="sr-stage-title">
              <span className="sr-stage-name">{label}</span>
              {stage.name !== '' && <Tag tone="outline">{stage.id}</Tag>}
              {initial && <Tag tone="info">{t('graph.initial')}</Tag>}
              {stage.planMode !== 'keep' && <Tag tone="neutral">{t(`planModeTag.${stage.planMode}`)}</Tag>}
              {broken && <Tag tone="danger">{t('editor.hasErrors')}</Tag>}
            </span>
            {!open && <span className="sr-stage-summary">{summary}</span>}
          </span>
        </button>
        <div className="sr-tools">
          <IconButton label={`${t('action.up')} ${label}`} disabled={readonly || index === 0} onClick={() => onMove(index - 1)}>{icons.up}</IconButton>
          <IconButton label={`${t('action.down')} ${label}`} disabled={readonly || index === count - 1} onClick={() => onMove(index + 1)}>{icons.down}</IconButton>
          <IconButton label={`${t('action.remove')} ${label}`} danger disabled={readonly || count === 1} onClick={onRemove}>{icons.remove}</IconButton>
        </div>
      </div>

      {open && (
        <div className="sr-stage-body">
          <div className="sr-group">
            <GroupTitle>{t('group.basic')}</GroupTitle>
            <div className="sr-grid">
              <Field label={t('field.name')}>
                <TextInput ariaLabel={`${label} · ${t('field.name')}`} value={stage.name} disabled={readonly} onChange={name => onPatch({ name })} />
              </Field>
              <Field label={t('field.id')} issues={issuesAt(issues, `${path}.id`)}>
                <TextInput ariaLabel={`${label} · ${t('field.id')}`} mono value={stage.id} disabled={readonly} invalid={issuesAt(issues, `${path}.id`).length > 0}
                  onCommit={id => id !== '' && onRename(id)} />
              </Field>
              <Field label={t('field.planMode')}>
                <Select ariaLabel={`${label} · ${t('field.planMode')}`} value={stage.planMode} disabled={readonly}
                  options={(['keep', 'enter', 'exit'] as const).map(v => ({ value: v, label: t(`planMode.${v}`) }))}
                  onChange={planMode => onPatch({ planMode })} />
              </Field>
            </div>
          </div>

          <div className="sr-group">
            <Field label={t('field.description')} hint={t('field.descriptionHint')}>
              <TextInput ariaLabel={`${label} · ${t('field.description')}`} value={stage.description} disabled={readonly} onChange={description => onPatch({ description })} />
            </Field>
          </div>

          <div className="sr-group">
            <Field label={t('field.model')} issues={routeIssues} hint={tiers === undefined ? undefined : t('field.routeWithTiersHint')}>
              <RoutePicker label={label} route={stage.route} catalog={catalog} t={t} disabled={readonly} invalid={routeIssues.length > 0} onChange={route => onPatch({ route })} />
            </Field>
            <Toggle label={t('field.tiers')} hint={t('field.tiersHint')} checked={tiers !== undefined} disabled={readonly}
              onChange={checked => onReplace(toggleTiers(stage, checked))} />
            {tiers !== undefined && (
              <div className="sr-inset">
                <div className="sr-grid">
                  <Field label={t('field.tierSource')}>
                    <Select ariaLabel={`${label} · ${t('field.tierSource')}`} value={tiers.source} disabled={readonly}
                      options={TIER_SOURCES.map(v => ({ value: v, label: t(`tierSource.${v}`) }))}
                      onChange={source => setTiers({ source })} />
                  </Field>
                  <Field label={t('field.tierDefault')} issues={issuesAt(issues, `${path}.tiers.default`)}>
                    <Select ariaLabel={`${label} · ${t('field.tierDefault')}`} value={tiers.default ?? ''} disabled={readonly}
                      options={tiers.levels.map(level => ({ value: level.id, label: level.id }))}
                      onChange={value => setTiers({ default: value })} />
                  </Field>
                </div>
                <span className="sr-field-label">{t('field.levels')}</span>
                {tiers.levels.map((level, li) => {
                  const levelIssues = issuesAt(issues, `${path}.tiers.levels[${li}]`)
                  const levelLabel = `${label} · 档位 ${li + 1}`
                  return (
                    <div key={li} className="sr-level" role="group" aria-label={levelLabel}>
                      <div className="sr-level-head">
                        <span className="sr-level-title">
                          <code className="sr-mono">{level.id}</code>
                          {level.id === tiers.default && <Tag tone="neutral">{t('field.tierDefault')}</Tag>}
                        </span>
                        <div className="sr-tools">
                          <IconButton label={`${t('action.up')} ${level.id}`} disabled={readonly || li === 0} onClick={() => setTiers({ levels: move(tiers.levels, li, li - 1) })}>{icons.up}</IconButton>
                          <IconButton label={`${t('action.down')} ${level.id}`} disabled={readonly || li === tiers.levels.length - 1} onClick={() => setTiers({ levels: move(tiers.levels, li, li + 1) })}>{icons.down}</IconButton>
                          <IconButton label={`${t('action.remove')} ${level.id}`} danger disabled={readonly || tiers.levels.length === 1}
                            onClick={() => {
                              const levels = tiers.levels.filter((_, i) => i !== li)
                              setTiers({ levels, ...tiers.default === level.id ? { default: levels[0]!.id } : {} })
                            }}>{icons.remove}</IconButton>
                        </div>
                      </div>
                      <div className="sr-level-fields">
                        <Field label={t('field.id')}>
                          <TextInput ariaLabel={`${levelLabel} · ${t('field.id')}`} mono value={level.id} disabled={readonly}
                            onCommit={id => {
                              if (id === '' || tiers.levels.some(l => l.id === id)) return
                              setTiers({
                                levels: tiers.levels.map((l, i) => i === li ? { ...l, id } : l),
                                ...tiers.default === level.id ? { default: id } : {},
                              })
                            }} />
                        </Field>
                        <Field label={t('field.description')}>
                          <TextInput ariaLabel={`${levelLabel} · ${t('field.description')}`} value={level.description} disabled={readonly}
                            onChange={description => setTiers({ levels: tiers.levels.map((l, i) => i === li ? { ...l, description } : l) })} />
                        </Field>
                      </div>
                      <Field label={t('field.model')} issues={levelIssues}>
                        <RoutePicker label={`${label} · ${level.id}`} route={level.route} catalog={catalog} t={t} disabled={readonly}
                          invalid={levelIssues.length > 0}
                          onChange={route => setTiers({ levels: tiers.levels.map((l, i) => i === li ? { ...l, route } : l) })} />
                      </Field>
                    </div>
                  )
                })}
                <div className="sr-row">
                  <Button variant="ghost" size="sm" icon={icons.plus} disabled={readonly} onClick={() => setTiers({
                    levels: [...tiers.levels, { id: `tier-${tiers.levels.length + 1}`, description: '', route: { ...stage.route } }],
                  })}>{t('action.addLevel')}</Button>
                </div>
              </div>
            )}
          </div>

          <div className="sr-group">
            <Field label={t('field.prompt')} hint={t('field.promptHint')}>
              <TextArea ariaLabel={`${label} · ${t('field.prompt')}`} value={stage.prompt ?? ''} disabled={readonly}
                onChange={prompt => {
                  if (prompt !== '') return onPatch({ prompt })
                  const { prompt: _dropped, ...rest } = stage
                  onReplace(rest)
                }} />
            </Field>
          </div>
        </div>
      )}
    </section>
  )
}
