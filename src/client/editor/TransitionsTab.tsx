import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { TRANSITION_EVENTS } from '../../config/constants.js'
import type { SchemeConfig, TransitionEvent } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import { IconButton, icons } from '../parts.js'
import { addTransition, edges, issuesAt, moveTransition, removeTransition, updateTransition } from './model.js'
import { Issues, Select, type T } from './ui.js'

/** Read-only graph: stages on a circle, one curved arrow per direction, the initial stage outlined. */
export function TransitionGraph({ scheme, t }: { scheme: SchemeConfig; t: T }) {
  const size = 300
  const radius = scheme.stages.length === 1 ? 0 : 104
  const center = size / 2
  const at = new Map(scheme.stages.map((stage, i) => {
    const angle = (2 * Math.PI * i) / scheme.stages.length - Math.PI / 2
    return [stage.id, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle), name: stage.name || stage.id }]
  }))
  const lines = edges(scheme)
  return (
    <figure className="sr-graph" style={{ margin: 0 }}>
      <svg role="img" aria-label={t('graph.title')} viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <defs>
          <marker id="stage-router-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {lines.map(edge => {
          const a = at.get(edge.from)!
          const b = at.get(edge.to)!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const length = Math.hypot(dx, dy) || 1
          const shrink = 32 / length
          const sx = a.x + dx * shrink
          const sy = a.y + dy * shrink
          const ex = b.x - dx * shrink
          const ey = b.y - dy * shrink
          // Bend each direction to its own side so a↔b shows two arrows.
          const cx = (sx + ex) / 2 - dy * 0.18
          const cy = (sy + ey) / 2 + dx * 0.18
          return (
            <path key={`${edge.from}>${edge.to}`} className="sr-graph-edge" d={`M${sx},${sy} Q${cx},${cy} ${ex},${ey}`} markerEnd="url(#stage-router-arrow)">
              <title>{`${edge.from} → ${edge.to}：${edge.on.map(on => t(`event.${on}`)).join('、')}`}</title>
            </path>
          )
        })}
        {[...at.entries()].map(([id, node]) => (
          <g key={id}>
            <circle className="sr-graph-node" data-initial={id === scheme.initialStage ? '' : undefined} cx={node.x} cy={node.y} r={28} />
            <text className="sr-graph-label" x={node.x} y={node.y} textAnchor="middle" dominantBaseline="central">
              {node.name.length > 6 ? `${node.name.slice(0, 5)}…` : node.name}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  )
}

export function TransitionsTab({ scheme, base, issues, onChange, t, readonly }: {
  scheme: SchemeConfig
  base: string
  issues: readonly ConfigIssue[]
  onChange: (scheme: SchemeConfig) => void
  t: T
  readonly: boolean
}) {
  const stageOptions = [{ value: '*', label: t('rule.any') }, ...scheme.stages.map(stage => ({ value: stage.id, label: stage.name || stage.id }))]
  const events = TRANSITION_EVENTS.map(on => ({ value: on, label: t(`event.${on}`) }))
  return (
    <div className="sr-stack">
      <section className="sr-card" aria-label={t('graph.title')}>
        <div className="sr-card-head"><div className="sr-card-title"><span>{t('graph.title')}</span></div></div>
        <TransitionGraph scheme={scheme} t={t} />
      </section>
      <section className="sr-card" aria-label={t('tab.transitions')}>
        <div className="sr-card-head"><div className="sr-card-title"><span>{t('rule.title')}</span></div></div>
        <span className="sr-hint">{t('rule.hint')}</span>
        {scheme.transitions.length === 0
          ? <span className="sr-empty">{t('rule.empty')}</span>
          : (
            <div className="sr-table-wrap">
              <table className="sr-table">
                <thead>
                  <tr><th /><th>{t('rule.from')}</th><th>{t('rule.on')}</th><th>{t('rule.to')}</th><th /></tr>
                </thead>
                <tbody>
                  {scheme.transitions.map((rule, index) => {
                    const path = `${base}.transitions[${index}]`
                    return (
                      <tr key={index}>
                        <td className="sr-num">{index + 1}</td>
                        <td>
                          <Select ariaLabel={`${t('rule.from')} ${index + 1}`} value={rule.from} options={stageOptions} disabled={readonly}
                            invalid={issuesAt(issues, `${path}.from`).length > 0}
                            onChange={from => onChange(updateTransition(scheme, index, { from }))} />
                          <Issues issues={issuesAt(issues, `${path}.from`)} />
                        </td>
                        <td>
                          <Select<TransitionEvent> ariaLabel={`${t('rule.on')} ${index + 1}`} value={rule.on} options={events} disabled={readonly}
                            onChange={on => onChange(updateTransition(scheme, index, { on }))} />
                        </td>
                        <td>
                          <Select ariaLabel={`${t('rule.to')} ${index + 1}`} value={rule.to} options={stageOptions} disabled={readonly}
                            invalid={issuesAt(issues, `${path}.to`).length > 0}
                            onChange={to => onChange(updateTransition(scheme, index, { to }))} />
                          <Issues issues={issuesAt(issues, `${path}.to`)} />
                        </td>
                        <td className="sr-tools-cell">
                          <div className="sr-tools">
                            <IconButton label={`${t('action.up')} ${index + 1}`} disabled={readonly || index === 0} onClick={() => onChange(moveTransition(scheme, index, index - 1))}>{icons.up}</IconButton>
                            <IconButton label={`${t('action.down')} ${index + 1}`} disabled={readonly || index === scheme.transitions.length - 1} onClick={() => onChange(moveTransition(scheme, index, index + 1))}>{icons.down}</IconButton>
                            <IconButton label={`${t('action.remove')} ${index + 1}`} danger disabled={readonly} onClick={() => onChange(removeTransition(scheme, index))}>{icons.remove}</IconButton>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        <div className="sr-row">
          <Button variant="outline" size="sm" icon={icons.plus} disabled={readonly} onClick={() => onChange(addTransition(scheme))}>{t('action.addRule')}</Button>
        </div>
      </section>
    </div>
  )
}
