import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../../src/config/defaults.js'
import { validateConfig } from '../../src/config/validate.js'
import {
  addScheme, addStage, addTransition, duplicateScheme, edges, freshId, issuesAt, move, moveStage, normalizeIssues,
  removeScheme, removeStage, removeTransition, renameStage, setDefaultJudge, toggleTiers, updateScheme, updateStage,
} from '../../src/client/editor/model.js'

const draft = () => parseConfig({ schemes: [EXAMPLE_SCHEME] })
const scheme = () => draft().schemes[0]!

describe('editor model', () => {
  it('moves list items and ignores out-of-range moves', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(move(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
  })

  it('mints fresh ids', () => {
    expect(freshId('stage', [])).toBe('stage')
    expect(freshId('stage', ['stage', 'stage-2'])).toBe('stage-3')
  })

  it('adds, duplicates and removes schemes', () => {
    const added = addScheme(draft())
    expect(added.schemes.map(s => s.id)).toEqual(['dev-default', 'scheme'])
    const copied = duplicateScheme(added, 0)
    expect(copied.schemes.map(s => s.id)).toEqual(['dev-default', 'dev-default-copy', 'scheme'])
    expect(copied.schemes[1]!.name).toBe('研发默认 (copy)')
    expect(copied.schemes[1]!.stages).not.toBe(copied.schemes[0]!.stages)
    expect(removeScheme(copied, 1).schemes.map(s => s.id)).toEqual(['dev-default', 'scheme'])
  })

  it('keeps a new scheme valid', () => {
    const added = addScheme(draft())
    const errors = validateConfig(added).filter(issue => !issue.path.includes('route'))
    expect(errors).toEqual([])
  })

  it('renames a stage everywhere it is referenced', () => {
    const renamed = renameStage({ ...scheme(), subagents: { enabled: true, stage: 'code', classify: true } }, 1, 'build')
    expect(renamed.stages.map(s => s.id)).toEqual(['plan', 'build', 'review'])
    expect(renamed.initialStage).toBe('build')
    expect(renamed.subagents.stage).toBe('build')
    expect(renamed.transitions.map(r => `${r.from}>${r.to}`)).toEqual(['*>plan', 'plan>build', 'build>review', '*>*'])
    expect(renameStage(scheme(), 1, 'plan')).toEqual(scheme())
  })

  it('removes a stage with its transitions and repairs references', () => {
    const removed = removeStage(scheme(), 1)
    expect(removed.stages.map(s => s.id)).toEqual(['plan', 'review'])
    expect(removed.initialStage).toBe('plan')
    expect(removed.transitions.map(r => `${r.from}>${r.to}`)).toEqual(['*>plan', '*>*'])
    expect(validateConfig({ ...draft(), schemes: [removed] })).toEqual([])
  })

  it('adds, updates and reorders stages', () => {
    const s = moveStage(updateStage(addStage(scheme()), 3, { name: 'Ship' }), 3, 0)
    expect(s.stages.map(x => `${x.id}:${x.name}`)[0]).toBe('stage:Ship')
  })

  it('toggles tiers with two starter levels', () => {
    const on = toggleTiers(scheme().stages[0]!, true)
    expect(on.tiers!.levels.map(l => l.id)).toEqual(['light', 'heavy'])
    expect(on.tiers!.levels[0]!.route).toEqual(scheme().stages[0]!.route)
    expect(toggleTiers(on, false)).not.toHaveProperty('tiers')
  })

  it('edits transitions', () => {
    const s = removeTransition(addTransition(scheme(), 'todos_done'), 0)
    expect(s.transitions.map(r => r.on)).toEqual(['plan_approved', 'todos_done', 'user_message', 'todos_done'])
  })

  it('expands wildcard edges for the graph', () => {
    const graph = edges(scheme())
    expect(graph).toContainEqual({ from: 'code', to: 'plan', on: ['plan_mode_on', 'user_message'] })
    expect(graph).toContainEqual({ from: 'plan', to: 'code', on: ['plan_approved', 'user_message'] })
    expect(graph.some(edge => edge.from === edge.to)).toBe(false)
  })

  it('edits the default judge and a scheme', () => {
    expect(setDefaultJudge(draft(), { timeoutMs: 100 }).defaultJudge.timeoutMs).toBe(100)
    expect(updateScheme(draft(), 0, s => ({ ...s, name: 'X' })).schemes[0]!.name).toBe('X')
  })

  it('finds issues under a path and maps scheme ids to indexes', () => {
    const issues = [
      { path: 'schemes[0].stages[1].id', message: 'dup' },
      { path: 'schemes[0].stagesX', message: 'other' },
      { path: 'schemes[dev-default].stages[0].route', message: 'model unavailable' },
    ]
    expect(issuesAt(issues, 'schemes[0].stages').map(i => i.message)).toEqual(['dup'])
    expect(normalizeIssues(draft(), issues)[2]!.path).toBe('schemes[0].stages[0].route')
  })
})
