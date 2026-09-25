import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { RouteConfig } from '../config/schema.js'

/** Judge outcome recorded with a stage notice. */
export interface JudgeRecord {
  ok: boolean
  stage?: string
  confidence?: number
  reason?: string
  error?: string
  elapsedMs: number
}

/**
 * Durable routing facts carried by the plugin's notice messages. dsh 0.1.7
 * refuses unknown session event types on reload, so these user-role notices
 * (a known event type with a plugin-declared source) double as persistence.
 */
export interface StageRouterMessageSource {
  readonly kind: 'stage-router'
  readonly scheme: string
  readonly stage: string
  readonly from: string | null
  readonly route: RouteConfig
  readonly reason: string
  readonly lock: string | null
  readonly judge?: JudgeRecord
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'stage-router': StageRouterMessageSource & ContextFormed
  }
}

/** Folded per-session routing state; also the client wire view. */
export interface StageRouterState {
  scheme: string | null
  stage: string | null
  lock: string | null
  route: RouteConfig | null
  reason: string | null
  judge: JudgeRecord | null
  /** Number of stage-router notices folded so far. */
  notices: number
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'stage-router': StageRouterState
  }
  interface SessionProjectionMap {
    'stage-router': StageRouterState
  }
}

export const PROJECTION_KEY = 'stage-router'

export const INITIAL_STATE: StageRouterState = {
  scheme: null, stage: null, lock: null, route: null, reason: null, judge: null, notices: 0,
}

const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})

const judgeSchema = z.object({
  ok: z.boolean(),
  stage: z.string().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  elapsedMs: z.number(),
})

export const stateSchema = z.object({
  scheme: z.string().nullable(),
  stage: z.string().nullable(),
  lock: z.string().nullable(),
  route: routeSchema.nullable(),
  reason: z.string().nullable(),
  judge: judgeSchema.nullable(),
  notices: z.number().int().nonnegative(),
}) as unknown as z.ZodType<StageRouterState>

/** The source of a stage-router notice, or `undefined` for any other event. */
export function noticeSource(event: { type: string; data?: unknown }): StageRouterMessageSource | undefined {
  if (event.type !== 'user/message') return undefined
  const source = (event.data as { source?: { kind?: unknown } } | undefined)?.source
  return source?.kind === 'stage-router' ? source as StageRouterMessageSource : undefined
}

/** Pure fold: only stage-router notices change the state. */
export function foldStageState(state: StageRouterState, event: { type: string; data?: unknown }): StageRouterState {
  const source = noticeSource(event)
  if (source === undefined) return state
  return {
    scheme: source.scheme,
    stage: source.stage,
    lock: source.lock,
    route: source.route,
    reason: source.reason,
    judge: source.judge ?? null,
    notices: state.notices + 1,
  }
}

export const stageProjection: ProjectionDefinition<'stage-router', StageRouterState> = {
  key: PROJECTION_KEY,
  stateSchema,
  init: () => INITIAL_STATE,
  apply: (state, event) => foldStageState(state, event),
  wire: { viewSchema: stateSchema, view: state => state },
  stateVersion: 1,
}

function routeLabel(route: RouteConfig): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `@${route.reasoningEffort}`}`
}

/**
 * The notice appended when the stage, lock or model changes. The text tells
 * the model what happened (dsh's own model-change notice is filtered out).
 */
export function stageNotice(input: Omit<StageRouterMessageSource, 'kind'> & { stageName: string }): UserMessage {
  const { stageName, ...facts } = input
  const summary = facts.from === facts.stage
    ? `${stageName} · ${routeLabel(facts.route)}`
    : `${facts.from ?? '—'} → ${stageName} · ${routeLabel(facts.route)}`
  const text = `[stage-router: stage "${facts.stage}" (${stageName}), model ${routeLabel(facts.route)}${facts.lock === null ? '' : ', locked'}. `
    + 'Assistant turns above may come from other models.]'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'stage-router', form: 'notice', summary: boundContextSummary(summary), ...facts },
  })
}
