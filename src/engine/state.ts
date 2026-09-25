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
  /** Tier inside the stage, when the stage has tiers and work is in progress. */
  readonly tier?: string
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
  tier: string | null
  lock: string | null
  route: RouteConfig | null
  reason: string | null
  judge: JudgeRecord | null
  /**
   * True after the user explicitly picked a non-stage-router model
   * (`model/selection`); a later stage-router pick or notice clears it.
   */
  detached: boolean
  /** A `/stage` command seen in `command/run`, applied when its `command/done` succeeds. */
  pendingCommand: { id: string; args: string } | null
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
  scheme: null, stage: null, tier: null, lock: null, route: null, reason: null, judge: null, detached: false, pendingCommand: null, notices: 0,
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
  tier: z.string().nullable(),
  lock: z.string().nullable(),
  route: routeSchema.nullable(),
  reason: z.string().nullable(),
  judge: judgeSchema.nullable(),
  detached: z.boolean(),
  pendingCommand: z.object({ id: z.string(), args: z.string() }).nullable(),
  notices: z.number().int().nonnegative(),
}) as unknown as z.ZodType<StageRouterState>

/** The source of a stage-router notice, or `undefined` for any other event. */
export function noticeSource(event: { type: string; data?: unknown }): StageRouterMessageSource | undefined {
  if (event.type !== 'user/message') return undefined
  const source = (event.data as { source?: { kind?: unknown } } | undefined)?.source
  return source?.kind === 'stage-router' ? source as StageRouterMessageSource : undefined
}

/** Virtual provider id (duplicated from adapter.ts to keep this module standalone). */
const PROVIDER = 'stage-router'

/** Name of the slash command that locks or unlocks the stage. */
export const STAGE_COMMAND = 'stage'

/**
 * What `/stage <args>` asks for: a lock on a stage id, `null` to unlock
 * (`auto`), or `undefined` for a read-only status query (empty / `status`).
 */
export function parseStageArgs(args: string): string | null | undefined {
  const arg = args.trim()
  if (arg === '' || arg === 'status') return undefined
  return arg === 'auto' ? null : arg
}

/**
 * Pure fold over stage-router notices and explicit model picks
 * (`model/selection`, appended by the Web session controller).
 */
export function foldStageState(state: StageRouterState, event: { type: string; data?: unknown }): StageRouterState {
  // `/stage` locks are durable through dsh's own command lifecycle events.
  if (event.type === 'command/run') {
    const run = event.data as { commandId?: unknown; name?: unknown; args?: unknown } | undefined
    if (run?.name !== STAGE_COMMAND || typeof run.commandId !== 'string') return state
    return { ...state, pendingCommand: { id: run.commandId, args: typeof run.args === 'string' ? run.args : '' } }
  }
  if (event.type === 'command/done') {
    const done = event.data as { commandId?: unknown; kind?: unknown } | undefined
    const pending = state.pendingCommand
    if (pending === null || done?.commandId !== pending.id) return state
    const lock = done.kind === 'success' ? parseStageArgs(pending.args) : undefined
    return lock === undefined ? { ...state, pendingCommand: null } : { ...state, lock, pendingCommand: null }
  }
  if (event.type === 'model/selection') {
    const picked = event.data as { provider?: unknown; model?: unknown } | undefined
    if (picked?.provider === PROVIDER && typeof picked.model === 'string') {
      return state.detached || state.scheme !== picked.model ? { ...state, scheme: picked.model, detached: false } : state
    }
    return state.detached ? state : { ...state, detached: true }
  }
  const source = noticeSource(event)
  if (source === undefined) return state
  return {
    scheme: source.scheme,
    stage: source.stage,
    tier: source.tier ?? null,
    lock: source.lock,
    route: source.route,
    reason: source.reason,
    judge: source.judge ?? null,
    detached: false,
    pendingCommand: state.pendingCommand,
    notices: state.notices + 1,
  }
}

/** The scheme a session is routed by according to its log, or `null`. */
export function persistedScheme(state: StageRouterState): string | null {
  return state.detached ? null : state.scheme
}

type WiredProjection = Omit<ProjectionDefinition<'stage-router', StageRouterState>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'stage-router', StageRouterState>['wire']> }

export const stageProjection: WiredProjection = {
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
  const where = facts.tier === undefined ? stageName : `${stageName} · ${facts.tier}`
  const summary = facts.from === facts.stage
    ? `${where} · ${routeLabel(facts.route)}`
    : `${facts.from ?? '—'} → ${where} · ${routeLabel(facts.route)}`
  const tierText = facts.tier === undefined ? '' : `, tier ${facts.tier}`
  const text = `[stage-router: stage "${facts.stage}" (${stageName})${tierText}, model ${routeLabel(facts.route)}${facts.lock === null ? '' : ', locked'}. `
    + 'Assistant turns above may come from other models.]'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'stage-router', form: 'notice', summary: boundContextSummary(summary), ...facts },
  })
}
