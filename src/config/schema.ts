import z from '@deepseek-ai/schemastery'
import { ANY_STAGE, PLAN_MODE_ACTIONS, TIER_SOURCES, TRANSITION_EVENTS } from './constants.js'

export { ANY_STAGE, PLAN_MODE_ACTIONS, TIER_SOURCES, TRANSITION_EVENTS } from './constants.js'

/** A concrete model route: one provider/model pair plus an optional reasoning effort. */
export interface RouteConfig {
  provider: string
  model: string
  /** Adapter-owned effort id (`off`, `high`, `max`, …); provider default when absent. */
  reasoningEffort?: string
}

export interface JudgeConfig {
  route: RouteConfig
  /** Abort the judge call after this many milliseconds and stay in the current stage. */
  timeoutMs: number
  /** Judgements below this confidence are ignored. */
  minConfidence: number
  /** Recent conversation turns passed to the judge, each clipped to 800 characters. */
  contextTurns: number
  /** Prompt template; `null` uses the built-in default. */
  promptTemplate: string | null
}

/** Per-scheme judge override: any subset of {@link JudgeConfig}. */
export type JudgeOverride = Partial<JudgeConfig>

export type TierSource = typeof TIER_SOURCES[number]

export interface TierLevel {
  id: string
  description: string
  route: RouteConfig
}

export interface TiersConfig {
  source: TierSource
  /** Tier used when no tag or judgement is available in time. */
  default?: string
  /** Ordered from lightest to heaviest. */
  levels: TierLevel[]
}

export type PlanModeAction = typeof PLAN_MODE_ACTIONS[number]

export interface StageConfig {
  id: string
  name: string
  /** What the stage is for; shown to the judge. */
  description: string
  route: RouteConfig
  /** Injected into the system prompt while this stage is active. */
  prompt?: string
  planMode: PlanModeAction
  tiers?: TiersConfig
}

export type TransitionEvent = typeof TRANSITION_EVENTS[number]


export interface TransitionConfig {
  /** Source stage id or `*`. */
  from: string
  /** Target stage id, or `*` for "every stage is a candidate". */
  to: string
  on: TransitionEvent
}

export interface SubagentsConfig {
  enabled: boolean
  /** `inherit` follows the parent session, otherwise a fixed stage id. */
  stage: string
  classify: boolean
}

export interface SchemeConfig {
  id: string
  name: string
  initialStage: string
  judge?: JudgeOverride | null
  subagents: SubagentsConfig
  stages: StageConfig[]
  transitions: TransitionConfig[]
}

export interface StageRouterConfig {
  defaultJudge: JudgeConfig
  schemes: SchemeConfig[]
}

const Route: z<RouteConfig> = z.object({
  provider: z.string().required().description('Provider route id'),
  model: z.string().required().description('Model id'),
  reasoningEffort: z.string().description('Reasoning effort id; provider default when empty'),
})

export const JudgeSchema: z<JudgeConfig> = z.object({
  route: Route.required(),
  timeoutMs: z.natural().default(6000),
  minConfidence: z.number().min(0).max(1).default(0.6),
  contextTurns: z.natural().default(2),
  promptTemplate: z.union([z.string(), z.const(null)]).default(null),
})

// Inner fields stay optional: schemastery resolves an absent optional object
// as `{}`, and a partial override must not require a route.
const RouteOverride: z<Partial<RouteConfig>> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

const JudgeOverrideSchema: z<JudgeOverride> = z.object({
  route: RouteOverride as z<RouteConfig>,
  timeoutMs: z.natural(),
  minConfidence: z.number().min(0).max(1),
  contextTurns: z.natural(),
  promptTemplate: z.union([z.string(), z.const(null)]),
})

const TierLevelSchema: z<TierLevel> = z.object({
  id: z.string().required(),
  description: z.string().default(''),
  route: Route.required(),
})

const TiersSchema: z<TiersConfig> = z.object({
  source: z.union([...TIER_SOURCES]).default('planner-then-judge'),
  // Not `.required()`: schemastery resolves an absent optional object as `{}`,
  // so the "tiers need a default" rule lives in validateScheme().
  default: z.string(),
  levels: z.array(TierLevelSchema).default([]),
})

const StageSchema: z<StageConfig> = z.object({
  id: z.string().required(),
  name: z.string().default(''),
  description: z.string().default(''),
  route: Route.required(),
  prompt: z.string(),
  planMode: z.union([...PLAN_MODE_ACTIONS]).default('keep'),
  tiers: TiersSchema,
})

const TransitionSchema: z<TransitionConfig> = z.object({
  from: z.string().default(ANY_STAGE),
  to: z.string().required(),
  on: z.union([...TRANSITION_EVENTS]).required(),
})

const SubagentsSchema: z<SubagentsConfig> = z.object({
  enabled: z.boolean().default(false),
  stage: z.string().default('inherit'),
  classify: z.boolean().default(true),
})

export const SchemeSchema: z<SchemeConfig> = z.object({
  id: z.string().required(),
  name: z.string().default(''),
  initialStage: z.string().required(),
  judge: z.union([JudgeOverrideSchema, z.const(null)]).default(null),
  subagents: SubagentsSchema.default({ enabled: false, stage: 'inherit', classify: true }),
  stages: z.array(StageSchema).default([]),
  transitions: z.array(TransitionSchema).default([]),
})

export const DEFAULT_JUDGE: JudgeConfig = {
  route: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' },
  timeoutMs: 6000,
  minConfidence: 0.6,
  contextTurns: 2,
  promptTemplate: null,
}

export const ConfigSchema: z<StageRouterConfig> = z.object({
  defaultJudge: JudgeSchema.default(DEFAULT_JUDGE),
  schemes: z.array(SchemeSchema).default([]),
})

/** The judge settings a scheme actually uses: its override merged over the default. */
export function effectiveJudge(defaults: JudgeConfig, scheme: Pick<SchemeConfig, 'judge'>): JudgeConfig {
  const override = scheme.judge
  if (override == null) return defaults
  const merged: JudgeConfig = { ...defaults }
  for (const key of Object.keys(override) as (keyof JudgeConfig)[]) {
    const value = override[key]
    if (value === undefined) continue
    // An absent route resolves as `{}`; only a complete route overrides.
    if (key === 'route' && !isCompleteRoute(value as Partial<RouteConfig>)) continue
    Object.assign(merged, { [key]: value })
  }
  return merged
}

function isCompleteRoute(route: Partial<RouteConfig>): route is RouteConfig {
  return typeof route.provider === 'string' && route.provider !== '' && typeof route.model === 'string' && route.model !== ''
}

/** Resolve raw YAML-shaped input into a full config; throws a schemastery ValidationError. */
export function parseConfig(input: unknown): StageRouterConfig {
  return ConfigSchema(input as StageRouterConfig)
}
