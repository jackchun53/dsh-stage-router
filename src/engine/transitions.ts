import { ANY_STAGE, type SchemeConfig, type TransitionEvent } from '../config/schema.js'

/** The part of a session's routing state the state machine reads. */
export interface MachineState {
  /** Current stage id; `null` before the session's first message. */
  stage: string | null
  /** Manually locked stage id, or `null` for automatic routing. */
  lock: string | null
}

export type Decision =
  | { kind: 'stay'; reason: string }
  | { kind: 'goto'; stage: string; reason: string }
  /** Only produced for `user_message`: ask the judge to pick among these stages. */
  | { kind: 'judge'; candidates: string[] }

export type Judgement =
  | { ok: true; stage: string; confidence: number; reason: string }
  | { ok: false; error: string }

function move(state: MachineState, stage: string, reason: string): Decision {
  return stage === state.stage ? { kind: 'stay', reason } : { kind: 'goto', stage, reason }
}

/**
 * Candidate target stages for one event, in rule order, deduplicated.
 * `to: '*'` expands to every stage of the scheme.
 */
export function candidatesFor(state: MachineState, event: TransitionEvent, scheme: SchemeConfig): string[] {
  const all = scheme.stages.map(stage => stage.id)
  const out: string[] = []
  for (const rule of scheme.transitions) {
    if (rule.on !== event) continue
    if (rule.from !== ANY_STAGE && rule.from !== state.stage) continue
    for (const target of rule.to === ANY_STAGE ? all : [rule.to]) {
      if (all.includes(target) && !out.includes(target)) out.push(target)
    }
  }
  return out
}

/**
 * Decide what one trigger event does to the stage.
 * - A manual lock wins over everything.
 * - `user_message`: every matching rule contributes candidates; one candidate
 *   moves directly, several go to the judge.
 * - Other events: the first matching rule wins.
 * - The session's first message falls back to `initialStage` when no rule matches.
 */
export function decide(state: MachineState, event: TransitionEvent, scheme: SchemeConfig): Decision {
  if (state.lock !== null && scheme.stages.some(stage => stage.id === state.lock)) {
    return move(state, state.lock, 'locked')
  }
  const candidates = candidatesFor(state, event, scheme)
  if (event !== 'user_message') {
    const first = candidates[0]
    return first === undefined ? { kind: 'stay', reason: `no rule for ${event}` } : move(state, first, event)
  }
  if (candidates.length === 0) {
    return state.stage === null
      ? { kind: 'goto', stage: scheme.initialStage, reason: 'initial' }
      : { kind: 'stay', reason: 'no rule for user_message' }
  }
  if (candidates.length === 1) return move(state, candidates[0]!, 'single candidate')
  return { kind: 'judge', candidates }
}

/**
 * Turn a judge result into a decision. Failure, low confidence or an
 * out-of-candidate answer keeps the current stage; on the first message it
 * enters `initialStage` instead.
 */
export function applyJudgement(
  state: MachineState,
  judgement: Judgement,
  candidates: readonly string[],
  minConfidence: number,
  initialStage: string,
): Decision {
  const fallback = (reason: string): Decision => state.stage === null
    ? { kind: 'goto', stage: initialStage, reason: `initial (${reason})` }
    : { kind: 'stay', reason }
  if (!judgement.ok) return fallback(`judge failed: ${judgement.error}`)
  if (!candidates.includes(judgement.stage)) return fallback(`judge chose non-candidate "${judgement.stage}"`)
  if (judgement.confidence < minConfidence) {
    return fallback(`low confidence ${judgement.confidence} < ${minConfidence}`)
  }
  return move(state, judgement.stage, `judge: ${judgement.reason}`)
}
