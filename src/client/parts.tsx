/** Small presentational pieces shared by the settings editor and the stage panel. */
import type { ReactNode } from 'react'

export const percent = (value: number) => `${Math.round(value * 100)}%`

/**
 * One bar per option, in the given order, the chosen one highlighted.
 * @param names - display name per option id.
 */
export function Probabilities({ options, probabilities, chosen, names }: {
  options: readonly string[]
  probabilities: Readonly<Record<string, number>>
  chosen?: string | undefined
  names: (id: string) => string
}) {
  return (
    <div className="sr-bars">
      {options.map(id => {
        const value = probabilities[id] ?? 0
        return (
          <div key={id} className="sr-bar" data-chosen={id === chosen ? '' : undefined}>
            <span className="sr-bar-name" title={names(id)}>{names(id)}</span>
            <span className="sr-bar-track" role="meter" aria-label={names(id)} aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
              <span className="sr-bar-fill" style={{ display: 'block', width: `${Math.round(value * 100)}%` }} />
            </span>
            <span className="sr-bar-value">{percent(value)}</span>
          </div>
        )
      })}
    </div>
  )
}

const svg = (children: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const icons = {
  up: svg(<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />),
  down: svg(<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />),
  remove: svg(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />),
  plus: svg(<path d="M8 3.5v9M3.5 8h9" />),
  lock: svg(<><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>),
  refresh: svg(<><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 3v2.5h-2.5" /></>),
  chevron: svg(<path d="M6 3.5 10.5 8 6 12.5" />),
  copy: svg(<><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" /><path d="M10.5 5.5V4.5A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1" /></>),
}

/** A 28px ghost icon button; `aria-disabled` keeps it focusable and announced when disabled. */
export function IconButton({ label, onClick, disabled = false, danger = false, children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="sr-icon-button"
      aria-label={label}
      title={label}
      aria-disabled={disabled}
      data-danger={danger ? '' : undefined}
      onClick={() => { if (!disabled) onClick() }}
    >
      {children}
    </button>
  )
}
