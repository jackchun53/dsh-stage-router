/** Small form primitives for the settings editor (inline styles, dsw tokens with fallbacks). */
import type { CSSProperties, ReactNode } from 'react'
import type { RouteConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { StageRouterKey } from '../locales.js'
import type { CatalogProvider } from './api.js'

export type T = (key: StageRouterKey, params?: Record<string, unknown>) => string

export const styles = {
  column: { display: 'grid', gap: 12 } satisfies CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties,
  card: {
    display: 'grid', gap: 10, padding: 12,
    border: '1px solid var(--dsw-color-border, rgba(127,127,127,.3))', borderRadius: 'var(--dsw-radius-md, 8px)',
  } satisfies CSSProperties,
  label: { display: 'grid', gap: 4, fontSize: 12 } satisfies CSSProperties,
  labelText: { opacity: 0.75 } satisfies CSSProperties,
  input: {
    font: 'inherit', fontSize: 13, padding: '4px 8px', minHeight: 28, color: 'inherit',
    background: 'var(--dsw-color-bg, transparent)',
    border: '1px solid var(--dsw-color-border, rgba(127,127,127,.4))', borderRadius: 'var(--dsw-radius-sm, 6px)',
  } satisfies CSSProperties,
  button: {
    font: 'inherit', fontSize: 12, padding: '0 10px', height: 28, cursor: 'pointer', color: 'inherit', background: 'transparent',
    border: '1px solid var(--dsw-color-border, rgba(127,127,127,.4))', borderRadius: 'var(--dsw-radius-sm, 6px)',
  } satisfies CSSProperties,
  primary: {
    font: 'inherit', fontSize: 12, padding: '0 14px', height: 28, cursor: 'pointer',
    color: 'var(--dsw-color-on-accent, #fff)', background: 'var(--dsw-color-accent, #2f6fed)',
    border: '1px solid transparent', borderRadius: 'var(--dsw-radius-sm, 6px)',
  } satisfies CSSProperties,
  error: { color: 'var(--dsw-color-danger, #d33)', fontSize: 12 } satisfies CSSProperties,
  warning: { color: 'var(--dsw-color-warning, #b7791f)', fontSize: 12 } satisfies CSSProperties,
  muted: { opacity: 0.7, fontSize: 12 } satisfies CSSProperties,
}

export function Issues({ issues, warning = false }: { issues: readonly ConfigIssue[]; warning?: boolean }) {
  if (issues.length === 0) return null
  return (
    <div role={warning ? 'status' : 'alert'} style={warning ? styles.warning : styles.error}>
      {issues.map((issue, i) => <div key={i}>{issue.message}</div>)}
    </div>
  )
}

export function Field({ label, issues = [], children }: { label: string; issues?: readonly ConfigIssue[]; children: ReactNode }) {
  return (
    <label style={styles.label}>
      <span style={styles.labelText}>{label}</span>
      {children}
      <Issues issues={issues} />
    </label>
  )
}

export function TextInput({ value, onChange, onCommit, placeholder, disabled, ariaLabel }: {
  value: string
  onChange?: (value: string) => void
  /** Called on blur / Enter instead of every keystroke (for renames). */
  onCommit?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <input
      style={styles.input}
      value={onCommit === undefined ? value : undefined}
      defaultValue={onCommit === undefined ? undefined : value}
      key={onCommit === undefined ? undefined : value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
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
      type="number" style={{ ...styles.input, width: 110 }} value={value} step={step} min={min} max={max}
      disabled={disabled} aria-label={ariaLabel}
      onChange={event => { const next = Number(event.target.value); if (!Number.isNaN(next)) onChange(next) }}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 3, disabled, ariaLabel }: {
  value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; disabled?: boolean; ariaLabel?: string
}) {
  return (
    <textarea
      style={{ ...styles.input, resize: 'vertical', fontFamily: 'inherit' }} rows={rows} value={value}
      placeholder={placeholder} disabled={disabled} aria-label={ariaLabel}
      onChange={event => onChange(event.target.value)}
    />
  )
}

export function Select<V extends string>({ value, options, onChange, disabled, ariaLabel }: {
  value: V; options: readonly { value: V; label: string }[]; onChange: (value: V) => void; disabled?: boolean; ariaLabel?: string
}) {
  return (
    <select style={styles.input} value={value} disabled={disabled} aria-label={ariaLabel} onChange={event => onChange(event.target.value as V)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

export function Button({ children, onClick, disabled, primary = false, ariaLabel }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; ariaLabel?: string
}) {
  return (
    <button type="button" style={{ ...(primary ? styles.primary : styles.button), opacity: disabled ? 0.5 : 1 }}
      disabled={disabled} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  )
}

/**
 * Provider → model → effort pickers fed by the host catalog. Values missing
 * from the catalog stay selectable so an unavailable model is visible, not lost.
 */
export function RoutePicker({ route, catalog, onChange, t, disabled, label }: {
  route: RouteConfig; catalog: readonly CatalogProvider[]; onChange: (route: RouteConfig) => void; t: T; disabled?: boolean; label: string
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
    <div style={styles.row}>
      <Select ariaLabel={`${label} · ${t('field.provider')}`} disabled={disabled} value={route.provider}
        options={[{ value: '', label: '—' }, ...providers]}
        onChange={value => onChange({ provider: value, model: '' })} />
      <Select ariaLabel={`${label} · ${t('field.model')}`} disabled={disabled || route.provider === ''} value={route.model}
        options={[{ value: '', label: '—' }, ...models]}
        onChange={value => onChange(withEffort({ ...route, model: value }, ''))} />
      <Select ariaLabel={`${label} · ${t('field.effort')}`} disabled={disabled || route.model === ''} value={route.reasoningEffort ?? ''}
        options={efforts} onChange={value => onChange(withEffort(route, value))} />
    </div>
  )
}
