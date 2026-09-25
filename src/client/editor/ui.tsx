/** Form primitives for the settings editor, styled by `sr-*` classes on the host's `--dsw-*` tokens. */
import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RouteConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { StageRouterKey } from '../locales.js'
import type { CatalogProvider } from './api.js'

export type T = (key: StageRouterKey, params?: Record<string, unknown>) => string

/** Field issues; red when any is an error, amber when all are warnings (e.g. an unavailable model). */
export function Issues({ issues, warning = issues.every(issue => issue.severity === 'warning') }: { issues: readonly ConfigIssue[]; warning?: boolean }) {
  if (issues.length === 0) return null
  return (
    <div role={warning ? 'status' : 'alert'} className={warning ? 'sr-warning' : 'sr-error'}>
      {issues.map((issue, i) => <div key={i}>{issue.message}</div>)}
    </div>
  )
}

/** Label above its control, an optional hint, then the field's issues. */
export function Field({ label, hint, issues = [], span = false, children }: {
  label: string
  hint?: string
  issues?: readonly ConfigIssue[]
  /** Take the whole row of a `sr-grid`. */
  span?: boolean
  children: ReactNode
}) {
  return (
    <label className={span ? 'sr-field sr-span' : 'sr-field'}>
      <span className="sr-field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="sr-hint">{hint}</span>}
      <Issues issues={issues} />
    </label>
  )
}

export function TextInput({ value, onChange, onCommit, placeholder, disabled, ariaLabel, invalid, type = 'text', mono = false }: {
  value: string
  onChange?: (value: string) => void
  /** Called on blur / Enter instead of every keystroke (for renames). */
  onCommit?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  invalid?: boolean
  type?: 'text' | 'password' | 'url'
  mono?: boolean
}) {
  return (
    <input
      type={type}
      className={mono ? 'sr-control sr-mono' : 'sr-control'}
      value={onCommit === undefined ? value : undefined}
      defaultValue={onCommit === undefined ? undefined : value}
      key={onCommit === undefined ? undefined : value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      spellCheck={false}
      onChange={event => onChange?.(event.target.value)}
      onBlur={event => onCommit?.(event.target.value.trim())}
      onKeyDown={event => { if (event.key === 'Enter' && onCommit !== undefined) (event.target as HTMLInputElement).blur() }}
    />
  )
}

export function NumberInput({ value, onChange, step = 1, min, max, disabled, ariaLabel }: {
  value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number; disabled?: boolean; ariaLabel?: string
}) {
  return (
    <input
      type="number" className="sr-control" value={value} step={step} min={min} max={max}
      disabled={disabled} aria-label={ariaLabel}
      onChange={event => { const next = Number(event.target.value); if (event.target.value !== '' && !Number.isNaN(next)) onChange(next) }}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 3, disabled, ariaLabel }: {
  value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; disabled?: boolean; ariaLabel?: string
}) {
  return (
    <textarea
      className="sr-control" rows={rows} value={value}
      placeholder={placeholder} disabled={disabled} aria-label={ariaLabel}
      onChange={event => onChange(event.target.value)}
    />
  )
}

export function Select<V extends string>({ value, options, onChange, disabled, ariaLabel, invalid }: {
  value: V; options: readonly { value: V; label: string }[]; onChange: (value: V) => void; disabled?: boolean; ariaLabel?: string; invalid?: boolean
}) {
  return (
    <select className="sr-control" value={value} disabled={disabled} aria-label={ariaLabel} aria-invalid={invalid || undefined}
      onChange={event => onChange(event.target.value as V)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

/** A settings row: title and hint on the left, the host's switch on the right. */
export function Toggle({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean
}) {
  return (
    <div className="sr-toggle">
      <div className="sr-toggle-text">
        <span className="sr-toggle-title">{label}</span>
        {hint !== undefined && <span className="sr-hint">{hint}</span>}
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/**
 * Provider → model → effort pickers fed by the host catalog. Values missing
 * from the catalog stay selectable so an unavailable model is visible, not lost.
 */
export function RoutePicker({ route, catalog, onChange, t, disabled, label, invalid }: {
  route: RouteConfig; catalog: readonly CatalogProvider[]; onChange: (route: RouteConfig) => void; t: T; disabled?: boolean; label: string; invalid?: boolean
}) {
  const providers = catalog.map(p => ({ value: p.id, label: p.name }))
  if (route.provider !== '' && !providers.some(p => p.value === route.provider)) providers.push({ value: route.provider, label: route.provider })
  const provider = catalog.find(p => p.id === route.provider)
  const models = (provider?.models ?? []).map(m => ({ value: m.id, label: m.name }))
  if (route.model !== '' && !models.some(m => m.value === route.model)) models.push({ value: route.model, label: route.model })
  const model = provider?.models.find(m => m.id === route.model)
  const efforts = [{ value: '', label: t('field.effortDefault') }, ...(model?.efforts ?? []).map(e => ({ value: e.id, label: e.name }))]
  if (route.reasoningEffort !== undefined && !efforts.some(e => e.value === route.reasoningEffort)) {
    efforts.push({ value: route.reasoningEffort, label: route.reasoningEffort })
  }
  const withEffort = (next: RouteConfig, effort: string) => {
    const { reasoningEffort: _dropped, ...rest } = next
    return effort === '' ? rest : { ...rest, reasoningEffort: effort }
  }
  return (
    <div className="sr-route">
      <Select ariaLabel={`${label} · ${t('field.provider')}`} disabled={disabled} value={route.provider} invalid={invalid && route.provider === ''}
        options={[{ value: '', label: t('field.provider') }, ...providers]}
        onChange={value => onChange({ provider: value, model: '' })} />
      <Select ariaLabel={`${label} · ${t('field.model')}`} disabled={disabled || route.provider === ''} value={route.model} invalid={invalid}
        options={[{ value: '', label: t('field.model') }, ...models]}
        onChange={value => onChange(withEffort({ ...route, model: value }, ''))} />
      <Select ariaLabel={`${label} · ${t('field.effort')}`} disabled={disabled || route.model === ''} value={route.reasoningEffort ?? ''}
        options={efforts} onChange={value => onChange(withEffort(route, value))} />
    </div>
  )
}

/** A small subheading that groups related fields inside a card. */
export function GroupTitle({ children }: { children: ReactNode }) {
  return <span className="sr-group-title">{children}</span>
}

/** "Provider · model · effort" by catalog display names, or `undefined` when no model is chosen. */
export function routeSummary(route: RouteConfig, catalog: readonly CatalogProvider[]): string | undefined {
  if (route.model === '') return undefined
  const provider = catalog.find(p => p.id === route.provider)
  const model = provider?.models.find(m => m.id === route.model)
  const effort = model?.efforts.find(e => e.id === route.reasoningEffort)?.name ?? route.reasoningEffort
  return [provider?.name ?? route.provider, model?.name ?? route.model, effort].filter(Boolean).join(' · ')
}
