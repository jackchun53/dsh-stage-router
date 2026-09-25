import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SchemeConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { CatalogProvider } from './api.js'
import { issuesAt, updateStage } from './model.js'
import { tiersSummary } from './StagesTab.js'
import { Field, Issues, RoutePicker, Select, TextInput, type T } from './ui.js'

/**
 * The scheme at a glance: its name, id and initial stage, then every stage's
 * model (and every tier's model for stages with tiers) in one list.
 */
export function OverviewTab({ scheme, base, issues, catalog, onChange, onOpenStage, t, readonly }: {
  scheme: SchemeConfig
  /** Issue path prefix of this scheme, e.g. `schemes[0]`. */
  base: string
  issues: readonly ConfigIssue[]
  catalog: readonly CatalogProvider[]
  onChange: (scheme: SchemeConfig) => void
  /** Show one stage's full settings on the Stages tab. */
  onOpenStage: (index: number) => void
  t: T
  readonly: boolean
}) {
  return (
    <div className="sr-stack">
      <section className="sr-card" aria-label={t('overview.scheme')}>
        <div className="sr-grid">
          <Field label={t('field.name')}>
            <TextInput ariaLabel={t('field.name')} value={scheme.name} disabled={readonly} onChange={name => onChange({ ...scheme, name })} />
          </Field>
          <Field label={t('field.id')} hint={t('field.idHint', { id: scheme.id })} issues={issuesAt(issues, `${base}.id`)}>
            <TextInput ariaLabel={t('field.id')} mono value={scheme.id} disabled={readonly} invalid={issuesAt(issues, `${base}.id`).length > 0}
              onCommit={id => id !== '' && onChange({ ...scheme, id })} />
          </Field>
          <Field label={t('field.initialStage')} hint={t('field.initialStageHint')} issues={issuesAt(issues, `${base}.initialStage`)}>
            <Select ariaLabel={t('field.initialStage')} value={scheme.initialStage} disabled={readonly}
              invalid={issuesAt(issues, `${base}.initialStage`).length > 0}
              options={scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))}
              onChange={initialStage => onChange({ ...scheme, initialStage })} />
          </Field>
        </div>
        <Issues issues={issuesAt(issues, base).filter(issue => /^schemes\[\d+\]$/.test(issue.path))} />
      </section>

      <section className="sr-card" aria-label={t('overview.models')}>
        <div className="sr-card-head">
          <div className="sr-card-title"><span>{t('overview.models')}</span></div>
        </div>
        <span className="sr-hint">{t('overview.modelsHint')}</span>
        <div className="sr-overview">
          {scheme.stages.map((stage, index) => {
            const label = stage.name || stage.id
            const path = `${base}.stages[${index}]`
            const tiers = stage.tiers !== undefined && stage.tiers.levels.length > 0 ? stage.tiers : undefined
            const routeIssues = issuesAt(issues, `${path}.route`)
            const setLevels = (levels: NonNullable<typeof tiers>['levels']) =>
              tiers !== undefined && onChange(updateStage(scheme, index, { tiers: { ...tiers, levels } }))
            return (
              <div key={index} className="sr-overview-stage">
                <div className="sr-overview-row">
                  <span className="sr-index">{index + 1}</span>
                  <div className="sr-overview-name">
                    <button type="button" className="sr-link" onClick={() => onOpenStage(index)}>{label}</button>
                    {stage.id === scheme.initialStage && <Tag tone="info">{t('graph.initial')}</Tag>}
                  </div>
                  <div className="sr-overview-route">
                    <RoutePicker label={label} route={stage.route} catalog={catalog} t={t} disabled={readonly} invalid={routeIssues.length > 0}
                      onChange={route => onChange(updateStage(scheme, index, { route }))} />
                    <Issues issues={routeIssues} />
                    {tiers !== undefined && <span className="sr-hint">{t('field.routeWithTiersHint')}</span>}
                  </div>
                </div>
                {tiers !== undefined && (
                  <div className="sr-overview-row sr-overview-tiers">
                    <span />
                    <span className="sr-overview-summary">{tiersSummary(tiers, t)}</span>
                  </div>
                )}
                {tiers?.levels.map((level, li) => {
                  const levelIssues = issuesAt(issues, `${path}.tiers.levels[${li}]`)
                  return (
                    <div key={li} className="sr-overview-row sr-overview-tier">
                      <span />
                      <div className="sr-overview-name">
                        <code className="sr-mono">{level.id}</code>
                        {level.id === tiers.default && <Tag tone="neutral">{t('field.tierDefault')}</Tag>}
                      </div>
                      <div className="sr-overview-route">
                        <RoutePicker label={`${label} · ${level.id}`} route={level.route} catalog={catalog} t={t} disabled={readonly}
                          invalid={levelIssues.length > 0}
                          onChange={route => setLevels(tiers.levels.map((l, i) => i === li ? { ...l, route } : l))} />
                        <Issues issues={levelIssues} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
