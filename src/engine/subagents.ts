import type { JevConfig, RouteConfig, SchemeConfig } from '../config/schema.js'
import type { TierJudgeLog } from './judge-log.js'
import { hasTiers } from '../config/validate.js'
import { TIER_WAIT_MS, plannerTag, taskTier, type TierClassifier, type TodoLike } from './tiers.js'

/** What the plugin knows about a subagent at its first request. */
export interface ChildView {
  /** Forked from the parent's history (follows the parent's route). */
  fork: boolean
  /** The route the child would use unrouted: the parent's last logged route, or an explicit pick. */
  config: RouteConfig
  /** Task text: the first user message of the child. */
  task: string
  /** The delegation label (`description` of the subagent tool), when known. */
  label?: string
}

/** The routed parent session at the moment its subagent starts. */
export interface ParentView {
  scheme: SchemeConfig
  stage: string | null
  route: RouteConfig | undefined
  todos: readonly TodoLike[] | null | undefined
}

export interface ChildRoute {
  route: RouteConfig
  stage: string
  tier?: string
  reason: string
}

export interface ChildRouteDeps {
  tiers: Pick<TierClassifier, 'classify' | 'lookup'>
  jev: JevConfig
  /** Receives the judge-log entry of a Jev tier call this starts (logged under the parent session). */
  record?(entry: TierJudgeLog): void
  usable(route: RouteConfig): Promise<boolean>
  waitMs?: number
}

const sameModel = (a: RouteConfig, b: RouteConfig) => a.provider === b.provider && a.model === b.model

/**
 * Decide a subagent's route (design §3 "子 agent"). `undefined` leaves the
 * child's request untouched: routing is off for the scheme, the parent has no
 * route yet, or the child's model was picked explicitly.
 */
export async function routeChild(child: ChildView, parent: ParentView, deps: ChildRouteDeps): Promise<ChildRoute | undefined> {
  const settings = parent.scheme.subagents
  if (!settings.enabled || parent.route === undefined) return undefined
  // A child inherits the parent's last logged route; any other model was chosen on purpose.
  if (!sameModel(child.config, parent.route)) return undefined
  if (child.fork) {
    return { route: parent.route, stage: parent.stage ?? parent.scheme.initialStage, reason: 'fork 出来的子 agent 跟随父会话' }
  }
  const stageId = settings.stage === 'inherit' ? parent.stage ?? parent.scheme.initialStage : settings.stage
  const stage = parent.scheme.stages.find(s => s.id === stageId)
  if (stage === undefined) return undefined
  if (!hasTiers(stage)) return { route: stage.route, stage: stage.id, reason: '阶段模型' }

  const tiers = stage.tiers!
  const texts = [child.label, child.task].filter((text): text is string => text !== undefined && text.trim() !== '')
  let tier: string | undefined
  let reason = '默认档'
  for (const text of texts) {
    tier = taskTier(stage, parent.todos, text)
    if (tier !== undefined) {
      reason = `规划任务 [T${plannerTag(text).task}] 的档位`
      break
    }
  }
  if (tier === undefined && settings.classify && tiers.source !== 'planner' && child.task.trim() !== '') {
    deps.tiers.classify(stage, [child.task], deps.jev, deps.record)
    const pending = deps.tiers.lookup(stage, child.task)
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<undefined>(resolve => { timer = setTimeout(resolve, deps.waitMs ?? TIER_WAIT_MS, undefined) })
    tier = pending === undefined ? undefined : await Promise.race([pending, expired])
    clearTimeout(timer)
    if (tier !== undefined) reason = 'Jev 定档'
  }
  tier ??= tiers.default ?? tiers.levels[0]!.id
  const level = tiers.levels.find(l => l.id === tier)
  for (const route of [level?.route, stage.route]) {
    if (route !== undefined && await deps.usable(route)) return { route, stage: stage.id, tier, reason }
  }
  return undefined
}
