import type { SchemeConfig, StageConfig, TierSource } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { CatalogProvider } from './api.js'
import { addStage, issuesAt, move, moveStage, removeStage, renameStage, toggleTiers, updateStage } from './model.js'
import { Button, Field, Issues, RoutePicker, Select, TextArea, TextInput, styles, type T } from './ui.js'

const TIER_SOURCES: TierSource[] = ['planner', 'judge', 'planner-then-judge']

export function StagesTab({ scheme, base, issues, catalog, onChange, t, readonly }: {
  scheme: SchemeConfig
  /** Issue path prefix of this scheme, e.g. `schemes[0]`. */
  base: string
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  onChange: (scheme: SchemeConfig) => void
  t: T
  readonly: boolean
}) {
  return (
    <div style={styles.column}>
      <Issues issues={issues.filter(issue => issue.path === `${base}.stages`)} />
      {scheme.stages.map((stage, index) => (
        <StageCard
          key={index}
          stage={stage}
          index={index}
          count={scheme.stages.length}
          path={`${base}.stages[${index}]`}
          issues={issues}
          catalog={catalog}
          t={t}
          readonly={readonly}
          onRename={id => onChange(renameStage(scheme, index, id))}
          onPatch={patch => onChange(updateStage(scheme, index, patch))}
          onReplace={next => onChange({ ...scheme, stages: scheme.stages.map((s, i) => i === index ? next : s) })}
          onMove={to => onChange(moveStage(scheme, index, to))}
          onRemove={() => onChange(removeStage(scheme, index))}
        />
      ))}
      <div><Button disabled={readonly} onClick={() => onChange(addStage(scheme))}>{t('action.addStage')}</Button></div>
    </div>
  )
}

function StageCard({ stage, index, count, path, issues, catalog, t, readonly, onRename, onPatch, onReplace, onMove, onRemove }: {
  stage: StageConfig
  index: number
  count: number
  path: string
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  t: T
  readonly: boolean
  onRename: (id: string) => void
  onPatch: (patch: Partial<StageConfig>) => void
  onReplace: (stage: StageConfig) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const tiers = stage.tiers !== undefined && stage.tiers.levels.length > 0 ? stage.tiers : undefined
  const setTiers = (patch: Partial<NonNullable<StageConfig['tiers']>>) => tiers !== undefined && onPatch({ tiers: { ...tiers, ...patch } })
  const label = stage.name || stage.id
  return (
    <section style={styles.card} aria-label={label}>
      <div style={{ ...styles.row, justifyContent: 'space-between' }}>
        <strong>{index + 1}. {label}</strong>
        <div style={styles.row}>
          <Button ariaLabel={`${t('action.up')} ${label}`} disabled={readonly || index === 0} onClick={() => onMove(index - 1)}>↑</Button>
          <Button ariaLabel={`${t('action.down')} ${label}`} disabled={readonly || index === count - 1} onClick={() => onMove(index + 1)}>↓</Button>
          <Button ariaLabel={`${t('action.remove')} ${label}`} disabled={readonly || count === 1} onClick={onRemove}>{t('action.remove')}</Button>
        </div>
      </div>
      <div style={{ ...styles.row, alignItems: 'flex-start' }}>
        <Field label={t('field.id')} issues={issuesAt(issues, `${path}.id`)}>
          <TextInput ariaLabel={`${label} · ${t('field.id')}`} value={stage.id} disabled={readonly} onCommit={id => id !== '' && onRename(id)} />
        </Field>
        <Field label={t('field.name')}>
          <TextInput ariaLabel={`${label} · ${t('field.name')}`} value={stage.name} disabled={readonly} onChange={name => onPatch({ name })} />
        </Field>
        <Field label={t('field.planMode')}>
          <Select ariaLabel={`${label} · ${t('field.planMode')}`} value={stage.planMode} disabled={readonly}
            options={(['keep', 'enter', 'exit'] as const).map(v => ({ value: v, label: t(`planMode.${v}`) }))}
            onChange={planMode => onPatch({ planMode })} />
        </Field>
      </div>
      <Field label={t('field.description')}>
        <TextInput ariaLabel={`${label} · ${t('field.description')}`} value={stage.description} disabled={readonly} onChange={description => onPatch({ description })} />
      </Field>
      <Field label={t('field.model')} issues={issuesAt(issues, `${path}.route`)}>
        <RoutePicker label={label} route={stage.route} catalog={catalog} t={t} disabled={readonly} onChange={route => onPatch({ route })} />
      </Field>
      <Field label={t('field.prompt')}>
        <TextArea ariaLabel={`${label} · ${t('field.prompt')}`} value={stage.prompt ?? ''} disabled={readonly}
          onChange={prompt => {
            if (prompt !== '') return onPatch({ prompt })
            const { prompt: _dropped, ...rest } = stage
            onReplace(rest)
          }} />
      </Field>
      <label style={styles.row}>
        <input type="checkbox" checked={tiers !== undefined} disabled={readonly} aria-label={`${label} · ${t('field.tiers')}`}
          onChange={event => onReplace(toggleTiers(stage, event.target.checked))} />
        <span>{t('field.tiers')}</span>
      </label>
      {tiers !== undefined && (
        <div style={{ ...styles.column, paddingLeft: 16 }}>
          <div style={styles.row}>
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
          <span style={styles.muted}>{t('field.levels')}</span>
          {tiers.levels.map((level, li) => (
            <div key={li} style={{ ...styles.row, alignItems: 'flex-start' }}>
              <TextInput ariaLabel={`${label} · 档位 ${li + 1} · ${t('field.id')}`} value={level.id} disabled={readonly}
                onCommit={id => {
                  if (id === '' || tiers.levels.some(l => l.id === id)) return
                  setTiers({
                    levels: tiers.levels.map((l, i) => i === li ? { ...l, id } : l),
                    ...tiers.default === level.id ? { default: id } : {},
                  })
                }} />
              <TextInput ariaLabel={`${label} · 档位 ${li + 1} · ${t('field.description')}`} value={level.description} disabled={readonly}
                onChange={description => setTiers({ levels: tiers.levels.map((l, i) => i === li ? { ...l, description } : l) })} />
              <RoutePicker label={`${label} · ${level.id}`} route={level.route} catalog={catalog} t={t} disabled={readonly}
                onChange={route => setTiers({ levels: tiers.levels.map((l, i) => i === li ? { ...l, route } : l) })} />
              <Button ariaLabel={`${t('action.up')} ${level.id}`} disabled={readonly || li === 0} onClick={() => setTiers({ levels: move(tiers.levels, li, li - 1) })}>↑</Button>
              <Button ariaLabel={`${t('action.remove')} ${level.id}`} disabled={readonly || tiers.levels.length === 1}
                onClick={() => {
                  const levels = tiers.levels.filter((_, i) => i !== li)
                  setTiers({ levels, ...tiers.default === level.id ? { default: levels[0]!.id } : {} })
                }}>{t('action.remove')}</Button>
              <Issues issues={issuesAt(issues, `${path}.tiers.levels[${li}]`)} />
            </div>
          ))}
          <div>
            <Button disabled={readonly} onClick={() => setTiers({
              levels: [...tiers.levels, { id: `tier-${tiers.levels.length + 1}`, description: '', route: { ...stage.route } }],
            })}>{t('action.addLevel')}</Button>
          </div>
        </div>
      )}
    </section>
  )
}
