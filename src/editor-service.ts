/**
 * Framework-free core of the settings editor's host service: validate a
 * draft config, and try the judge on one message. The remote wiring lives in
 * index.ts; this module is unit-tested on its own.
 */
import type { RouteConfig, StageRouterConfig } from './config/schema.js'
import { jevConfigured, parseConfig } from './config/schema.js'
import { checkRoutes, schemeRoutes, validateConfig, type ConfigIssue } from './config/validate.js'
import { NO_RECENT, runJudge, type FetchFn, type TimedJudgement } from './engine/judge.js'
import { applyJudgement, decide, type Decision } from './engine/transitions.js'

export interface DraftCheck {
  /** The resolved config when the draft parses; absent on schema errors. */
  config?: StageRouterConfig
  issues: ConfigIssue[]
}

/** Schemastery reports `$.schemes[0].stages[1].id missing required value`; turn it into an issue. */
function schemaIssue(error: unknown): ConfigIssue {
  const path = (error as { options?: { path?: (string | number)[] } }).options?.path
  const dotted = path === undefined
    ? ''
    : path.map((part, i) => typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${part}`).join('')
  const raw = error instanceof Error ? error.message.replace(/^\$\S*\s*/, '') : String(error)
  const message = raw === 'missing required value' ? '缺少必填项' : `格式不正确：${raw}`
  return { path: dotted, message }
}

/**
 * Validate a draft: schema, structure, and (when `usable` is given) that every
 * model resolves. Route issues use `schemes[<index>]…` paths like the rest.
 */
export async function checkDraft(input: unknown, usable?: (route: RouteConfig) => Promise<boolean>): Promise<DraftCheck> {
  let config: StageRouterConfig
  try {
    config = parseConfig(structuredClone(input))
  } catch (error) {
    return { issues: [schemaIssue(error)] }
  }
  const issues = validateConfig(config)
  if (usable !== undefined) {
    for (const [index, scheme] of config.schemes.entries()) {
      const routes = schemeRoutes(scheme, `schemes[${index}]`).filter(({ route }) => route.provider !== '' && route.model !== '')
      const unavailable = await checkRoutes(routes, async route =>
        (await usable(route)) ? undefined : `模型 ${route.provider}/${route.model} 当前不可用`)
      issues.push(...unavailable.map(issue => ({ ...issue, severity: 'warning' as const })))
    }
  }
  if (!jevConfigured(config.jev)) {
    issues.push({ path: 'jev', message: 'Jev 未配置（需要地址和 token），阶段和档位的判断不会生效', severity: 'warning' })
  }
  return { config, issues }
}

export interface TryJudgeInput {
  draft: unknown
  scheme: string
  /** Current stage id, or null for "first message of a session". */
  current: string | null
  message: string
  /** Optional recent conversation excerpt. */
  recent?: string
}

export interface TryJudgeResult {
  /** Candidate stages the transitions offer for this message. */
  candidates: string[]
  judgement?: TimedJudgement
  decision: Decision
  issues: ConfigIssue[]
}

/** Run the draft scheme's `user_message` rules and, when needed, Jev on one message. */
export async function tryJudge(fetchFn: FetchFn, input: TryJudgeInput): Promise<TryJudgeResult> {
  const { config, issues } = await checkDraft(input.draft)
  const scheme = config?.schemes.find(s => s.id === input.scheme)
  if (config === undefined || scheme === undefined) {
    return {
      candidates: [],
      decision: { kind: 'stay', reason: scheme === undefined && config !== undefined ? `没有方案「${input.scheme}」` : '配置有误' },
      issues,
    }
  }
  const current = input.current !== null && scheme.stages.some(s => s.id === input.current) ? input.current : null
  const state = { stage: current, lock: null }
  const decision = decide(state, 'user_message', scheme)
  if (decision.kind !== 'judge') {
    return { candidates: decision.kind === 'goto' ? [decision.stage] : [], decision, issues }
  }
  const byId = new Map(scheme.stages.map(stage => [stage.id, stage]))
  const judgement = await runJudge(fetchFn, config.jev, {
    current,
    ...current === null ? {} : { currentDescription: byId.get(current)?.description ?? '' },
    candidates: decision.candidates.map(id => ({ id, description: byId.get(id)?.description ?? '' })),
    recent: input.recent?.trim() || NO_RECENT,
    message: input.message,
  })
  return {
    candidates: decision.candidates,
    judgement,
    decision: applyJudgement(state, judgement, decision.candidates, config.jev.minConfidence, scheme.initialStage),
    issues,
  }
}

/** Issues that block saving (everything except warnings). */
export const blocking = (issues: readonly ConfigIssue[]) => issues.filter(issue => issue.severity !== 'warning')
