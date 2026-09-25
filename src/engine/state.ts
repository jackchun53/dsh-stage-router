import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { RouteConfig } from '../config/schema.js'
import {
  PROJECTION_KEY, STAGE_COMMAND, TURN_HISTORY, modelLabel, parseStageCommand,
  type JudgeRecord, type StageRef, type StageRouterState, type TurnRecord,
} from '../shared/wire.js'

export { PROJECTION_KEY, STAGE_COMMAND, parseStageCommand } from '../shared/wire.js'
export type { JudgeRecord, StageRef, StageRouterState, TurnRecord } from '../shared/wire.js'

/**
 * Durable routing facts carried by the plugin's notice messages. dsh 0.1.7
 * refuses unknown session event types on reload, so these user-role notices
 * (a known event type with a plugin-declared source) double as persistence.
 */
export interface StageRouterMessageSource {
  readonly kind: 'stage-router'
  readonly scheme: string
  readonly stage: string
  readonly stageName?: string
  readonly stages?: readonly StageRef[]
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

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'stage-router': StageRouterState
  }
  interface SessionProjectionMap {
    'stage-router': StageRouterState
  }
}

export const INITIAL_STATE: StageRouterState = {
  scheme: null,
  stage: null,
  stageName: null,
  stages: [],
  tier: null,
  lock: null,
  route: null,
  reason: null,
  judge: null,
  tierOverrides: {},
  turns: [],
  detached: false,
  pendingCommand: null,
  notices: 0,
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
  stageName: z.string().nullable(),
  stages: z.array(z.object({ id: z.string(), name: z.string() })),
  tier: z.string().nullable(),
  lock: z.string().nullable(),
  route: routeSchema.nullable(),
  reason: z.string().nullable(),
  judge: judgeSchema.nullable(),
  tierOverrides: z.record(z.string(), z.string()),
  turns: z.array(z.object({
    turn: z.number(),
    fromStage: z.string().nullable(),
    fromModel: z.string().nullable(),
    toStage: z.string().nullable(),
    toModel: z.string().nullable(),
  })),
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

/** Apply a successful `/stage` command to the durable state. */
function applyCommand(state: StageRouterState, args: string): StageRouterState {
  const command = parseStageCommand(args)
  if (command.kind === 'lock') return { ...state, lock: command.stage }
  if (command.kind !== 'tier') return state
  const tierOverrides = { ...state.tierOverrides }
  if (command.tier === null) delete tierOverrides[String(command.task)]
  else tierOverrides[String(command.task)] = command.tier
  return { ...state, tierOverrides }
}

/**
 * Pure fold over stage-router notices, `/stage` command lifecycle events,
 * turn starts and explicit model picks (`model/selection`, appended by the
 * Web session controller).
 */
export function foldStageState(state: StageRouterState, event: { type: string; data?: unknown }): StageRouterState {
  // `/stage` changes are durable through dsh's own command lifecycle events.
  if (event.type === 'command/run') {
    const run = event.data as { commandId?: unknown; name?: unknown; args?: unknown } | undefined
    if (run?.name !== STAGE_COMMAND || typeof run.commandId !== 'string') return state
    return { ...state, pendingCommand: { id: run.commandId, args: typeof run.args === 'string' ? run.args : '' } }
  }
  if (event.type === 'command/done') {
    const done = event.data as { commandId?: unknown; kind?: unknown } | undefined
    const pending = state.pendingCommand
    if (pending === null || done?.commandId !== pending.id) return state
    const cleared = { ...state, pendingCommand: null }
    return done.kind === 'success' ? applyCommand(cleared, pending.args) : cleared
  }
  if (event.type === 'turn/start') {
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn !== 'number') return state
    const model = modelLabel(state.route)
    const record: TurnRecord = { turn, fromStage: state.stage, fromModel: model, toStage: state.stage, toModel: model }
    return { ...state, turns: [...state.turns, record].slice(-TURN_HISTORY) }
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
  const last = state.turns.at(-1)
  const turns = last === undefined
    ? state.turns
    : [...state.turns.slice(0, -1), { ...last, toStage: source.stage, toModel: modelLabel(source.route) }]
  return {
    ...state,
    scheme: source.scheme,
    stage: source.stage,
    stageName: source.stageName ?? source.stage,
    stages: source.stages === undefined ? state.stages : [...source.stages],
    tier: source.tier ?? null,
    lock: source.lock,
    route: source.route,
    reason: source.reason,
    judge: source.judge ?? null,
    turns,
    detached: false,
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
  stateVersion: 2,
}

function routeLabel(route: RouteConfig): string {
  return `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : `@${route.reasoningEffort}`}`
}

/**
 * The notice appended when the stage, tier, lock or model changes. The text
 * tells the model what happened (dsh's own model-change notice is filtered out).
 */
export function stageNotice(input: Omit<StageRouterMessageSource, 'kind' | 'stageName'> & { stageName: string }): UserMessage {
  const facts = input
  const where = facts.tier === undefined ? facts.stageName : `${facts.stageName} · ${facts.tier}`
  const summary = facts.from === facts.stage
    ? `${where} · ${routeLabel(facts.route)}`
    : `${facts.from ?? '—'} → ${where} · ${routeLabel(facts.route)}`
  const tierText = facts.tier === undefined ? '' : `, tier ${facts.tier}`
  const text = `[stage-router: stage "${facts.stage}" (${facts.stageName})${tierText}, model ${routeLabel(facts.route)}${facts.lock === null ? '' : ', locked'}. `
    + 'Assistant turns above may come from other models.]'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'stage-router', form: 'notice', summary: boundContextSummary(summary), ...facts },
  })
}
