import { createHash } from 'node:crypto'
import type { JevConfig, StageConfig, TierSource, TiersConfig } from '../config/schema.js'
import { hasTiers } from '../config/validate.js'
import { askJev, type FetchFn, type JevChoiceQuestion } from './jev.js'
import { clip } from './judge.js'
import { logText, type TierJudgeLog } from './judge-log.js'

/** The slice of a todo the tier logic reads. */
export interface TodoLike {
  content: string
  status: string
}

/** Tier judge batches hold at most this many todos. */
export const TIER_BATCH_LIMIT = 30
/** How long a request waits for pending tier judgements before using the default tier. */
export const TIER_WAIT_MS = 1500

const TAG = /^\s*\[T(\d+)\]\s*(?:\[([\w.-]+)\])?/i

/**
 * Parse the planner's task tag: `[T3][heavy] …` → `{ task: 3, tier: 'heavy' }`,
 * `[T3] …` → `{ task: 3 }`, untagged text → `{}`.
 */
export function plannerTag(text: string): { task?: number; tier?: string } {
  const match = TAG.exec(text)
  if (match === null) return {}
  return { task: Number(match[1]), ...match[2] === undefined ? {} : { tier: match[2] } }
}

/** Index of a tier in lightest-to-heaviest order, or -1. */
export function tierRank(tiers: TiersConfig, id: string | undefined): number {
  return id === undefined ? -1 : tiers.levels.findIndex(level => level.id === id)
}

/** The heaviest known tier among `ids`, or `undefined` when none is known. */
export function heaviest(tiers: TiersConfig, ids: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined
  for (const id of ids) if (tierRank(tiers, id) > tierRank(tiers, best)) best = id
  return best
}

/** Characters of one task text sent to Jev. */
export const TASK_TEXT_LIMIT = 500

/**
 * Jev questions for one batch: one `choice` per task, keyed `t1…tn`, whose
 * options are the stage's tiers (lightest first) and their descriptions.
 */
export function tierQuestions(tiers: TiersConfig, count: number): Record<string, JevChoiceQuestion> {
  const criteria = Object.fromEntries(tiers.levels.map(level => [level.id, level.description.trim() || level.id]))
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`t${i + 1}`, {
    type: 'choice' as const,
    instructions: `判断 tasks 中键为 t${i + 1} 的任务需要哪个档位（选项从轻到重）`,
    criteria,
  }]))
}

function key(stage: StageConfig, text: string): string {
  const levels = stage.tiers?.levels.map(level => level.id).join(',') ?? ''
  return createHash('sha256').update(`${stage.id}\u0000${levels}\u0000${text.trim()}`).digest('hex')
}

/**
 * Tier judgements for todo texts (and subagent task descriptions), cached by
 * content hash so an unchanged todo is judged once. Failures resolve to
 * `undefined`, which callers treat as "use the default tier".
 */
export class TierClassifier {
  private readonly cache = new Map<string, Promise<string | undefined>>()

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly log: (message: string, ...args: unknown[]) => void,
    private readonly limit = 2000,
  ) {}

  /**
   * Start judging every text not judged yet, in batches of {@link TIER_BATCH_LIMIT}.
   * @param record - receives one judge-log entry per Jev call this starts.
   */
  classify(stage: StageConfig, texts: readonly string[], jev: JevConfig, record?: (entry: TierJudgeLog) => void): void {
    if (!hasTiers(stage)) return
    const fresh = [...new Set(texts.map(text => text.trim()))].filter(text => text !== '' && !this.cache.has(key(stage, text)))
    for (let i = 0; i < fresh.length; i += TIER_BATCH_LIMIT) {
      const batch = fresh.slice(i, i + TIER_BATCH_LIMIT)
      const result = this.judgeBatch(stage, batch, jev, record)
      batch.forEach((text, j) => this.remember(key(stage, text), result.then(tiers => tiers[j])))
    }
  }

  /** The pending or settled judgement for one text, if one was started. */
  lookup(stage: StageConfig, text: string): Promise<string | undefined> | undefined {
    return this.cache.get(key(stage, text.trim()))
  }

  private remember(entry: string, value: Promise<string | undefined>): void {
    this.cache.set(entry, value)
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!)
  }

  private async judgeBatch(stage: StageConfig, texts: string[], jev: JevConfig, record?: (entry: TierJudgeLog) => void): Promise<(string | undefined)[]> {
    const tiers = stage.tiers!
    const result = await askJev(this.fetchFn, jev, {
      tasks: texts.map((text, i) => ({ key: `t${i + 1}`, text: clip(text, TASK_TEXT_LIMIT) })),
    }, tierQuestions(tiers, texts.length))
    const answers = texts.map((_, i) => {
      const answer = result.ok ? result.answers[`t${i + 1}`] : undefined
      return answer !== undefined && tierRank(tiers, answer.choice) >= 0 ? answer : undefined
    })
    if (result.ok) this.log('stage-router: Jev tiered %d task(s) in %dms', texts.length, result.elapsedMs)
    else this.log('stage-router: Jev tier judgement failed (%s); using the default tier', result.error)
    record?.({
      kind: 'tier',
      at: Date.now(),
      elapsedMs: result.elapsedMs,
      stage: stage.id,
      ok: result.ok,
      ...result.ok ? {} : { error: result.error },
      tasks: texts.map((text, i) => ({ text: logText(text), tier: answers[i]?.choice ?? null, confidence: answers[i]?.confidence ?? null })),
    })
    return answers.map(answer => answer?.choice)
  }
}

export interface TierPick {
  tier: string
  /** Where the winning tier came from. */
  reason: 'manual' | 'planner' | 'judge' | 'default'
}

/** How one todo's tier is sourced, per `tiers.source`. */
function tagTier(source: TierSource, tiers: TiersConfig, text: string): string | undefined {
  if (source === 'judge') return undefined
  const tier = plannerTag(text).tier
  return tierRank(tiers, tier) >= 0 ? tier : undefined
}

/**
 * Pick the tier for a request: the heaviest tier among in-progress todos.
 * Returns `undefined` when the stage has no tiers or nothing is in progress
 * (the stage's own route applies). Pending judgements are awaited up to
 * `waitMs`, after which they count as the default tier.
 */
export async function pickTier(
  stage: StageConfig,
  todos: readonly TodoLike[] | null | undefined,
  classifier: Pick<TierClassifier, 'lookup'>,
  waitMs = TIER_WAIT_MS,
  /** Manual tier per planner task number (`/stage tier T2 light`). */
  overrides: Readonly<Record<string, string>> = {},
): Promise<TierPick | undefined> {
  if (!hasTiers(stage)) return undefined
  const tiers = stage.tiers!
  const active = (todos ?? []).filter(todo => todo.status === 'in_progress')
  if (active.length === 0) return undefined
  const fallback = tiers.default ?? tiers.levels[0]!.id
  let deadline: NodeJS.Timeout | undefined
  const expired = new Promise<undefined>(resolve => { deadline = setTimeout(resolve, waitMs, undefined) })
  try {
    const picks = await Promise.all(active.map(async (todo): Promise<TierPick> => {
      const task = plannerTag(todo.content).task
      const manual = task === undefined ? undefined : overrides[String(task)]
      if (tierRank(tiers, manual) >= 0) return { tier: manual!, reason: 'manual' }
      const tagged = tagTier(tiers.source, tiers, todo.content)
      if (tagged !== undefined) return { tier: tagged, reason: 'planner' }
      const pending = tiers.source === 'planner' ? undefined : classifier.lookup(stage, todo.content)
      const judged = pending === undefined ? undefined : await Promise.race([pending, expired])
      return judged === undefined ? { tier: fallback, reason: 'default' } : { tier: judged, reason: 'judge' }
    }))
    const tier = heaviest(tiers, picks.map(pick => pick.tier)) ?? fallback
    return picks.find(pick => pick.tier === tier) ?? { tier, reason: 'default' }
  } finally {
    clearTimeout(deadline)
  }
}

/** The tier a subagent's `[Tn]` task number refers to, looked up in the parent's todos. */
export function taskTier(stage: StageConfig, todos: readonly TodoLike[] | null | undefined, description: string): string | undefined {
  if (!hasTiers(stage)) return undefined
  const task = plannerTag(description).task
  if (task === undefined) return undefined
  const todo = (todos ?? []).find(item => plannerTag(item.content).task === task)
  return todo === undefined ? undefined : tagTier(stage.tiers!.source, stage.tiers!, todo.content)
}
