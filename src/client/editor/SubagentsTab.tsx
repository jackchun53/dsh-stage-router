import type { SchemeConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { issuesAt } from './model.js'
import { Field, Select, Toggle, type T } from './ui.js'

/** Whether and how this scheme routes subagents. */
export function SubagentsTab({ scheme, base, issues, onChange, t, readonly }: {
  scheme: SchemeConfig
  base: string
  issues: readonly ConfigIssue[]
  onChange: (scheme: SchemeConfig) => void
  t: T
  readonly: boolean
}) {
  const sub = scheme.subagents
  const set = (patch: Partial<SchemeConfig['subagents']>) => onChange({ ...scheme, subagents: { ...sub, ...patch } })
  const stageOptions = scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))
  return (
    <section className="sr-card" aria-label={t('tab.subagents')}>
      <Toggle label={t('sub.enabled')} hint={t('sub.enabledHint')} checked={sub.enabled} disabled={readonly} onChange={enabled => set({ enabled })} />
      <hr className="sr-divider" />
      <div className="sr-grid">
        <Field label={t('sub.stage')} issues={issuesAt(issues, `${base}.subagents.stage`)}>
          <Select ariaLabel={t('sub.stage')} value={sub.stage} disabled={readonly || !sub.enabled}
            options={[{ value: 'inherit', label: t('sub.inherit') }, ...stageOptions]}
            onChange={stage => set({ stage })} />
        </Field>
      </div>
      <Toggle label={t('sub.classify')} hint={t('sub.classifyHint')} checked={sub.classify} disabled={readonly || !sub.enabled}
        onChange={classify => set({ classify })} />
    </section>
  )
}
