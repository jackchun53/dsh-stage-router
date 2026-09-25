/**
 * The plugin's stylesheet, written against the host's `--dsw-*` design tokens
 * so the editor and the stage panel follow dsh's theme (light and dark).
 * Inline styles cannot express :hover / :focus, so every rule lives here under
 * an `sr-` prefix and is injected into the document once.
 */
import { useEffect } from 'react'

const STYLE_ID = 'dsh-stage-router-styles'

/** Chevron for native selects; a mid grey that reads on light and dark layers. */
const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f99' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

export const CSS = `
.sr-page { container-type: inline-size; display: grid; gap: 16px; max-width: 980px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.sr-header { display: grid; gap: 2px; }
.sr-title { margin: 0; font-size: 18px; line-height: 26px; font-weight: 600; }
.sr-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.sr-banner { font-size: 13px; line-height: 20px; padding: 8px 12px; border-radius: var(--dsw-radius-md); }
.sr-banner[data-tone='error'] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.sr-banner[data-tone='warning'] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }

.sr-toolbar { position: sticky; top: 0; z-index: 5; display: grid; gap: 10px; margin: 0 -4px; padding: 8px 4px 10px; background: var(--dsw-alias-bg-layer-2); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.sr-toolbar-row { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; min-width: 0; }
.sr-scheme-picker { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 240px; }
.sr-scheme-picker select.sr-control { flex: 0 1 240px; font-weight: 500; }
.sr-dot { display: inline-flex; flex: none; }
.sr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.sr-status { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.sr-jev-status { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); cursor: pointer; white-space: nowrap; }
.sr-jev-status:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sr-jev-status:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }

.sr-panel { display: grid; gap: 12px; min-width: 0; }
.sr-card { display: grid; gap: 14px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.sr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.sr-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.sr-card-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-card-head + .sr-hint { margin-top: -8px; }
.sr-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.sr-divider { height: 0; border: 0; border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0; }

.sr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px 16px; }
.sr-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 16px; }
.sr-span { grid-column: 1 / -1; }
.sr-stack { display: grid; gap: 12px; min-width: 0; }
.sr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.sr-group { display: grid; gap: 12px; min-width: 0; padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.sr-group:first-child { padding-top: 0; border-top: 0; }
.sr-group-title { font-size: 12px; line-height: 18px; font-weight: 600; letter-spacing: 0.02em; color: var(--dsw-alias-label-tertiary); }

.sr-field { display: grid; gap: 6px; min-width: 0; align-content: start; }
.sr-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.sr-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.sr-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.sr-warning { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }

.sr-control { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; padding: 0 10px; margin: 0; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); outline: none; transition: border-color 120ms ease; }
.sr-control::placeholder { color: var(--dsw-alias-label-tertiary); opacity: 0.8; }
.sr-control:focus { border-color: var(--dsw-alias-state-business-primary); }
.sr-control:disabled { opacity: 0.5; cursor: not-allowed; }
.sr-control[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
textarea.sr-control { height: auto; padding: 8px 10px; resize: vertical; }
select.sr-control { appearance: none; -webkit-appearance: none; padding-right: 28px; cursor: pointer; background-image: ${CHEVRON}; background-repeat: no-repeat; background-position: right 10px center; text-overflow: ellipsis; }
.sr-control[type='number'] { font-variant-numeric: tabular-nums; }
.sr-mono { font-family: Consolas, 'Cascadia Mono', 'SF Mono', Menlo, ui-monospace, monospace; font-size: 12.5px; }
.sr-nowrap { white-space: nowrap; flex: none; }

.sr-route { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 0.8fr); gap: 8px; }
@container (max-width: 440px) {
  .sr-route { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .sr-route > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
}

.sr-empty { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); padding: 8px 4px; }
.sr-index { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
.sr-tools { display: flex; align-items: center; gap: 2px; flex: none; }
.sr-icon-button { all: unset; box-sizing: border-box; display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sr-icon-button:hover:not([aria-disabled='true']) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sr-icon-button[data-danger]:hover:not([aria-disabled='true']) { color: var(--dsw-alias-state-error-primary); }
.sr-icon-button[aria-disabled='true'] { opacity: 0.35; cursor: default; }
.sr-icon-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.sr-link { all: unset; box-sizing: border-box; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; cursor: pointer; border-radius: var(--dsw-radius-sm); }
.sr-link:hover { color: var(--dsw-alias-state-business-primary); text-decoration: underline; text-underline-offset: 3px; }
.sr-link:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }

.sr-toggle { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; }
.sr-toggle-text { display: grid; gap: 2px; min-width: 0; }
.sr-toggle-title { font-size: 13px; line-height: 20px; }
.sr-inset { display: grid; gap: 12px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); min-width: 0; }

.sr-overview { display: grid; min-width: 0; }
.sr-overview-stage { display: grid; gap: 8px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); min-width: 0; }
.sr-overview-stage:first-child { border-top: 0; padding-top: 0; }
.sr-overview-stage:last-child { padding-bottom: 0; }
.sr-overview-row { display: grid; grid-template-columns: 22px minmax(72px, 128px) minmax(0, 1fr); align-items: center; gap: 8px 12px; min-width: 0; }
.sr-overview-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sr-overview-name code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.sr-overview-route { display: grid; gap: 4px; min-width: 0; }
.sr-overview-summary { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); min-width: 0; }
.sr-overview-tiers .sr-overview-summary { grid-column: 2 / -1; }
.sr-overview-tier .sr-overview-name { padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l3); }
@container (max-width: 520px) {
  .sr-overview-row { grid-template-columns: 22px minmax(0, 1fr); }
  .sr-overview-route, .sr-overview-summary { grid-column: 2; }
  .sr-overview-tier { grid-template-columns: 22px minmax(0, 1fr); }
}

.sr-stage { gap: 0; padding: 0; }
.sr-stage > .sr-card-head { padding: 10px 12px 10px 8px; }
.sr-stage-head { all: unset; box-sizing: border-box; flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 2px 4px; border-radius: var(--dsw-radius-md); cursor: pointer; }
.sr-stage-head:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.sr-stage-head:hover .sr-stage-name { color: var(--dsw-alias-state-business-primary); }
.sr-stage-text { display: grid; gap: 2px; min-width: 0; }
.sr-stage-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.sr-stage-name { font-size: 14px; line-height: 22px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-stage-summary { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-stage-body { display: grid; gap: 14px; padding: 14px 16px 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); min-width: 0; }
.sr-chevron[data-open] { transform: rotate(90deg); }

.sr-level { display: grid; gap: 10px; padding: 10px 12px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.sr-level-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.sr-level-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; }
.sr-level-fields { display: grid; grid-template-columns: minmax(96px, 0.6fr) minmax(0, 1.4fr); gap: 12px; }
@container (max-width: 440px) {
  .sr-level-fields { grid-template-columns: minmax(0, 1fr); }
}

.sr-table-wrap { overflow-x: auto; min-width: 0; margin: 0 -6px; }
.sr-table-wrap .sr-table { min-width: 460px; }

.sr-graph { display: grid; place-items: center; padding: 8px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); }
.sr-graph svg { max-width: 100%; height: auto; }
.sr-graph-node { fill: var(--dsw-alias-bg-layer-3); stroke: var(--dsw-alias-border-l3); stroke-width: 1; }
.sr-graph-node[data-initial] { stroke: var(--dsw-alias-state-business-primary); stroke-width: 1.5; }
.sr-graph-label { fill: var(--dsw-alias-label-primary); font-size: 11px; }
.sr-graph-edge { fill: none; stroke: currentColor; stroke-width: 1.2; }

.sr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sr-table th { padding: 0 6px 6px; text-align: left; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.sr-table td { padding: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); vertical-align: top; }
.sr-table td.sr-num { width: 20px; padding-top: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.sr-table td.sr-tools-cell { width: 1%; white-space: nowrap; }

.sr-chevron { display: inline-flex; color: var(--dsw-alias-label-tertiary); transition: transform 150ms ease; }

.sr-result { display: grid; gap: 10px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); font-size: 13px; }
.sr-bars { display: grid; gap: 6px; }
.sr-bar { display: grid; grid-template-columns: minmax(48px, max-content) minmax(60px, 1fr) 38px; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; }
.sr-bar-name { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
.sr-bar[data-chosen] .sr-bar-name { color: var(--dsw-alias-label-primary); font-weight: 500; }
.sr-bar-track { height: 6px; border-radius: 999px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.sr-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-label-tertiary); opacity: 0.55; }
.sr-bar[data-chosen] .sr-bar-fill { background: var(--dsw-alias-state-business-primary); opacity: 1; }
.sr-bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }

.sr-chip-root { position: relative; display: inline-flex; }
.sr-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 280px; }
.sr-chip-stage { font-weight: 500; color: var(--dsw-alias-label-primary); white-space: nowrap; }
.sr-chip-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.sr-chip-lock { flex: none; color: var(--dsw-alias-state-warn-primary); }
.sr-pop { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 50; box-sizing: border-box; width: 348px; max-width: calc(100vw - 24px); display: grid; gap: 14px; padding: 14px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); box-shadow: var(--dsw-elevation-panel, 0 12px 32px rgba(0, 0, 0, 0.16)); }
.sr-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sr-pop-title { font-size: 13px; line-height: 20px; font-weight: 600; }
.sr-kv { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 6px 12px; margin: 0; }
.sr-kv dt { color: var(--dsw-alias-label-tertiary); }
.sr-kv dd { margin: 0; overflow-wrap: anywhere; }
.sr-section { display: grid; gap: 8px; }
.sr-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); }
.sr-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.sr-log { display: grid; gap: 2px; max-height: 248px; overflow-y: auto; margin: 0 -6px; padding: 0; list-style: none; }
.sr-log-item { all: unset; box-sizing: border-box; display: grid; gap: 2px; width: 100%; padding: 6px; border-radius: var(--dsw-radius-sm); cursor: pointer; }
.sr-log-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sr-log-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.sr-log-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.sr-log-time { flex: none; width: 52px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.sr-log-outcome { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-log-outcome[data-kind='stay'] { color: var(--dsw-alias-label-secondary); }
.sr-log-outcome[data-kind='failed'] { color: var(--dsw-alias-state-error-primary); }
.sr-log-meta { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.sr-log-text { padding-left: 60px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-log-detail { display: grid; gap: 6px; padding: 4px 6px 8px 66px; }
.sr-turn-tail { font-size: 12px; line-height: 18px; padding: 2px 0; color: var(--dsw-alias-label-tertiary); }

@media (prefers-reduced-motion: reduce) {
  .sr-control, .sr-chevron { transition: none; }
}
`

/** Inject the stylesheet into the document once (idempotent across components). */
export function useStageRouterStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }, [])
}
