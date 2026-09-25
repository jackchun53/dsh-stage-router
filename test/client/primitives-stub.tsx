/**
 * Test stand-in for `@deepseek-ai/dsh-client-ui-primitives`: the host provides
 * the real package at runtime, but its own dependencies are not installed here.
 * Each stub keeps the real component's element, role and accessible name.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Button({ variant: _variant, size: _size, icon, children, ...rest }: {
  variant?: string; size?: string; icon?: ReactNode; children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest}>{icon}{children}</button>
}

export function Pill({ active, children, onClick, ...rest }: { active?: boolean; children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (onClick === undefined) return <span data-active={active ? '' : undefined}>{children}</span>
  return <button type="button" data-active={active ? '' : undefined} onClick={onClick} {...rest}>{children}</button>
}

export function Tag({ tone, children }: { tone?: string; children?: ReactNode }) {
  return <span data-tone={tone}>{children}</span>
}

export function StateDot({ state }: { state: string; size?: number }) {
  return <span data-state={state} aria-hidden="true" />
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function SegmentedTabs<V extends string>({ items, value, onChange, label }: {
  items: readonly { value: V; label: ReactNode; id: string; panelId: string }[]; value: V; onChange: (value: V) => void; label: string
}) {
  return (
    <div role="tablist" aria-label={label}>
      {items.map(item => (
        <button key={item.value} type="button" role="tab" id={item.id} aria-controls={item.panelId} aria-selected={item.value === value}
          onClick={() => onChange(item.value)}>{item.label}</button>
      ))}
    </div>
  )
}

export type SegmentedTab<V extends string = string> = { value: V; label: ReactNode; id: string; panelId: string }
