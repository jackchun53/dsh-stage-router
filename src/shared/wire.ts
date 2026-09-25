/**
 * Types and pure helpers shared by the host plugin and the Web client. This
 * module must stay free of host-only imports: the client bundle includes it.
 */

export interface RouteView {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Judge outcome recorded with a stage notice. */
export interface JudgeRecord {
  ok: boolean
  stage?: string
  confidence?: number
  reason?: string
  error?: string
  elapsedMs: number
}

export interface StageRef {
  id: string
  name: string
}

/** Where one turn started and ended, for the per-turn summary. */
export interface TurnRecord {
  turn: number
  fromStage: string | null
  fromModel: string | null
  toStage: string | null
  toModel: string | null
}

/** Folded per-session routing state; also the client wire view (`useProjection('stage-router')`). */
export interface StageRouterState {
  scheme: string | null
  stage: string | null
  stageName: string | null
  /** The scheme's stages, for the lock menu. */
  stages: StageRef[]
  tier: string | null
  lock: string | null
  route: RouteView | null
  reason: string | null
  judge: JudgeRecord | null
  /** Manual tier per planner task number (`/stage tier T2 light`). */
  tierOverrides: Record<string, string>
  /** The most recent turns, oldest first. */
  turns: TurnRecord[]
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

export const PROJECTION_KEY = 'stage-router'

/** Name of the slash command that shows, locks and re-tiers stages. */
export const STAGE_COMMAND = 'stage'

/** Turns kept in the projection for the per-turn summary. */
export const TURN_HISTORY = 20

export type StageCommand =
  | { kind: 'status' }
  | { kind: 'log' }
  | { kind: 'lock'; stage: string | null }
  | { kind: 'tier'; task: number; tier: string | null }
  | { kind: 'invalid'; message: string }

/**
 * Parse `/stage` arguments:
 * `` / `status` · `log` · `auto` · `<stage id>` · `tier T<n> <tier id | auto>`.
 */
export function parseStageCommand(args: string): StageCommand {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [first, ...rest] = words
  if (first === undefined || first === 'status') return { kind: 'status' }
  if (first === 'log') return { kind: 'log' }
  if (first === 'auto') return { kind: 'lock', stage: null }
  if (first === 'tier') {
    const task = /^T?(\d+)$/i.exec(rest[0] ?? '')
    const tier = rest[1]
    if (task === null || tier === undefined || rest.length > 2) {
      return { kind: 'invalid', message: 'Usage: /stage tier T<n> <tier id | auto>' }
    }
    return { kind: 'tier', task: Number(task[1]), tier: tier === 'auto' ? null : tier }
  }
  if (rest.length > 0) return { kind: 'invalid', message: 'Usage: /stage [status | log | auto | <stage id> | tier T<n> <tier>]' }
  return { kind: 'lock', stage: first }
}

/** Short model label: the model id plus a non-default effort. */
export function modelLabel(route: RouteView | null | undefined): string | null {
  if (route == null) return null
  return route.reasoningEffort === undefined ? route.model : `${route.model}@${route.reasoningEffort}`
}
