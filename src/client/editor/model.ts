/**
 * Pure, immutable edits on a stage-router config draft for the settings
 * editor. Every function returns a new object; nothing here touches React
 * or the host.
 */
import type {
  JudgeConfig, RouteConfig, SchemeConfig, StageConfig, StageRouterConfig, TransitionConfig, TransitionEvent,
} from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'

export type Draft = StageRouterConfig

const WILDCARD = '*'

/** Move one item of a list (drag-to-reorder). Out-of-range moves return the list unchanged. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/** A fresh id not in `taken`: `base`, `base-2`, `base-3`, … */
export function freshId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`
}

export function blankRoute(): RouteConfig {
  return { provider: '', model: '' }
}

export function newStage(taken: Iterable<string>): StageConfig {
  return { id: freshId('stage', taken), name: '', description: '', route: blankRoute(), planMode: 'keep' }
}

export function newScheme(taken: Iterable<string>): SchemeConfig {
  const stage = newStage([])
  return {
    id: freshId('scheme', taken),
    name: '',
    initialStage: stage.id,
    judge: null,
    subagents: { enabled: false, stage: 'inherit', classify: true },
    stages: [stage],
    transitions: [{ from: WILDCARD, to: WILDCARD, on: 'user_message' }],
  }
}

export function addScheme(draft: Draft): Draft {
  return { ...draft, schemes: [...draft.schemes, newScheme(draft.schemes.map(s => s.id))] }
}

export function duplicateScheme(draft: Draft, index: number): Draft {
  const source = draft.schemes[index]
  if (source === undefined) return draft
  const copy: SchemeConfig = structuredClone(source)
  copy.id = freshId(`${source.id}-copy`, draft.schemes.map(s => s.id))
  copy.name = source.name === '' ? '' : `${source.name} (copy)`
  const schemes = [...draft.schemes]
  schemes.splice(index + 1, 0, copy)
  return { ...draft, schemes }
}

export function removeScheme(draft: Draft, index: number): Draft {
  return { ...draft, schemes: draft.schemes.filter((_, i) => i !== index) }
}

export function updateScheme(draft: Draft, index: number, change: (scheme: SchemeConfig) => SchemeConfig): Draft {
  const scheme = draft.schemes[index]
  if (scheme === undefined) return draft
  const schemes = [...draft.schemes]
  schemes[index] = change(scheme)
  return { ...draft, schemes }
}

export function setDefaultJudge(draft: Draft, patch: Partial<JudgeConfig>): Draft {
  return { ...draft, defaultJudge: { ...draft.defaultJudge, ...patch } }
}

// ---- stages ----

export function addStage(scheme: SchemeConfig): SchemeConfig {
  return { ...scheme, stages: [...scheme.stages, newStage(scheme.stages.map(s => s.id))] }
}

export function updateStage(scheme: SchemeConfig, index: number, patch: Partial<StageConfig>): SchemeConfig {
  const stage = scheme.stages[index]
  if (stage === undefined) return scheme
  const stages = [...scheme.stages]
  stages[index] = { ...stage, ...patch }
  return { ...scheme, stages }
}

/**
 * Rename a stage and every reference to it (transitions, initial stage,
 * subagent stage). A rename onto an existing id is refused.
 */
export function renameStage(scheme: SchemeConfig, index: number, id: string): SchemeConfig {
  const stage = scheme.stages[index]
  if (stage === undefined || stage.id === id || scheme.stages.some(s => s.id === id)) return scheme
  const old = stage.id
  const swap = (ref: string) => ref === old ? id : ref
  return {
    ...updateStage(scheme, index, { id }),
    initialStage: swap(scheme.initialStage),
    subagents: { ...scheme.subagents, stage: swap(scheme.subagents.stage) },
    transitions: scheme.transitions.map(rule => ({ ...rule, from: swap(rule.from), to: swap(rule.to) })),
  }
}

/**
 * Remove a stage, the transitions that name it, and fix the references that
 * would dangle (initial stage → first remaining stage, subagent stage → inherit).
 */
export function removeStage(scheme: SchemeConfig, index: number): SchemeConfig {
  const stage = scheme.stages[index]
  if (stage === undefined) return scheme
  const stages = scheme.stages.filter((_, i) => i !== index)
  return {
    ...scheme,
    stages,
    initialStage: scheme.initialStage === stage.id ? stages[0]?.id ?? '' : scheme.initialStage,
    subagents: scheme.subagents.stage === stage.id ? { ...scheme.subagents, stage: 'inherit' } : scheme.subagents,
    transitions: scheme.transitions.filter(rule => rule.from !== stage.id && rule.to !== stage.id),
  }
}

export function moveStage(scheme: SchemeConfig, from: number, to: number): SchemeConfig {
  return { ...scheme, stages: move(scheme.stages, from, to) }
}

/** Turn tiers on (two starter levels from the stage route) or off. */
export function toggleTiers(stage: StageConfig, on: boolean): StageConfig {
  if (!on) {
    const { tiers: _dropped, ...rest } = stage
    return rest
  }
  if ((stage.tiers?.levels.length ?? 0) > 0) return stage
  return {
    ...stage,
    tiers: {
      source: 'planner-then-judge',
      default: 'heavy',
      levels: [
        { id: 'light', description: '', route: { ...stage.route } },
        { id: 'heavy', description: '', route: { ...stage.route } },
      ],
    },
  }
}

// ---- transitions ----

export function addTransition(scheme: SchemeConfig, on: TransitionEvent = 'user_message'): SchemeConfig {
  return { ...scheme, transitions: [...scheme.transitions, { from: WILDCARD, to: WILDCARD, on }] }
}

export function updateTransition(scheme: SchemeConfig, index: number, patch: Partial<TransitionConfig>): SchemeConfig {
  const rule = scheme.transitions[index]
  if (rule === undefined) return scheme
  const transitions = [...scheme.transitions]
  transitions[index] = { ...rule, ...patch }
  return { ...scheme, transitions }
}

export function removeTransition(scheme: SchemeConfig, index: number): SchemeConfig {
  return { ...scheme, transitions: scheme.transitions.filter((_, i) => i !== index) }
}

export function moveTransition(scheme: SchemeConfig, from: number, to: number): SchemeConfig {
  return { ...scheme, transitions: move(scheme.transitions, from, to) }
}

/** Concrete edges for the read-only graph: wildcards expanded, duplicates merged. */
export function edges(scheme: SchemeConfig): { from: string; to: string; on: TransitionEvent[] }[] {
  const ids = scheme.stages.map(stage => stage.id)
  const merged = new Map<string, { from: string; to: string; on: TransitionEvent[] }>()
  for (const rule of scheme.transitions) {
    for (const from of rule.from === WILDCARD ? ids : [rule.from]) {
      for (const to of rule.to === WILDCARD ? ids : [rule.to]) {
        if (from === to || !ids.includes(from) || !ids.includes(to)) continue
        const key = `${from}\u0000${to}`
        const edge = merged.get(key) ?? { from, to, on: [] }
        if (!edge.on.includes(rule.on)) edge.on.push(rule.on)
        merged.set(key, edge)
      }
    }
  }
  return [...merged.values()]
}

// ---- issues ----

/** Issues at `path` or below it (`schemes[0].stages` matches `schemes[0].stages[1].id`). */
export function issuesAt(issues: readonly ConfigIssue[], path: string): ConfigIssue[] {
  return issues.filter(issue => issue.path === path || issue.path.startsWith(`${path}.`) || issue.path.startsWith(`${path}[`))
}

/** Schemes addressed in the issues as `schemes[<id>]` (route checks) are mapped back to their index. */
export function normalizeIssues(draft: Draft, issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.map(issue => {
    const match = /^schemes\[([^\]\d][^\]]*)\]/.exec(issue.path)
    if (match === null) return issue
    const index = draft.schemes.findIndex(scheme => scheme.id === match[1])
    return index < 0 ? issue : { ...issue, path: issue.path.replace(match[0], `schemes[${index}]`) }
  })
}
