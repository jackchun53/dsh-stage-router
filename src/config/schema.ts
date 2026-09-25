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

/** The Jev judge (`POST <baseUrl>/systemone`), the only stage and tier judge. */
export interface JevConfig {
  /** API base, e.g. `https://api.typesafe.ai/v1`; requests go to `<baseUrl>/systemone`. */
  baseUrl: string
  model: string
  /** Bearer token; a settings secret, never sent to the Web client. */
  token: string
  /** Abort a Jev call after this many milliseconds and stay in the current stage. */
  timeoutMs: number
  /** Judgements below this confidence are ignored. */
  minConfidence: number
  /** Recent conversation turns passed to Jev, each clipped to 800 characters. */
  contextTurns: number
}

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
  subagents: SubagentsConfig
  stages: StageConfig[]
  transitions: TransitionConfig[]
}

export interface StageRouterConfig {
  jev: JevConfig
  schemes: SchemeConfig[]
}

const Route: z<RouteConfig> = z.object({
  provider: z.string().required().description('Provider route id'),
  model: z.string().required().description('Model id'),
  reasoningEffort: z.string().description('Reasoning effort id; provider default when empty'),
})

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1'

export const DEFAULT_JEV: JevConfig = {
  baseUrl: DEFAULT_JEV_BASE_URL,
  model: 'jev-latest',
  token: '',
  timeoutMs: 3000,
  minConfidence: 0.6,
  contextTurns: 2,
}

/** Jev is usable once it has an address and a token. */
export function jevConfigured(jev: Pick<JevConfig, 'baseUrl' | 'token'>): boolean {
  return jev.baseUrl.trim() !== '' && jev.token.trim() !== ''
}

export const JevSchema: z<JevConfig> = z.object({
  baseUrl: z.string().default(DEFAULT_JEV.baseUrl),
  model: z.string().default(DEFAULT_JEV.model),
  token: z.string().role('secret').default(''),
  timeoutMs: z.natural().default(DEFAULT_JEV.timeoutMs),
  minConfidence: z.number().min(0).max(1).default(DEFAULT_JEV.minConfidence),
  contextTurns: z.natural().default(DEFAULT_JEV.contextTurns),
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
  subagents: SubagentsSchema.default({ enabled: false, stage: 'inherit', classify: true }),
  stages: z.array(StageSchema).default([]),
  transitions: z.array(TransitionSchema).default([]),
})

export const ConfigSchema: z<StageRouterConfig> = z.object({
  jev: JevSchema.default(DEFAULT_JEV),
  schemes: z.array(SchemeSchema).default([]),
})

/** Resolve raw YAML-shaped input into a full config; throws a schemastery ValidationError. */
export function parseConfig(input: unknown): StageRouterConfig {
  return ConfigSchema(dropLegacy(input) as StageRouterConfig)
}

/**
 * Drop the fields of the old model-based judge (`defaultJudge`, per-scheme
 * `judge`) so configs written before the switch to Jev still load cleanly.
 */
export function dropLegacy(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input
  const { defaultJudge: _judge, ...rest } = input as Record<string, unknown>
  if (!Array.isArray(rest.schemes)) return rest
  return {
    ...rest,
    schemes: rest.schemes.map(scheme => {
      if (typeof scheme !== 'object' || scheme === null) return scheme
      const { judge: _override, ...kept } = scheme as Record<string, unknown>
      return kept
    }),
  }
}
