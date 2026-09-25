import { createHash } from 'node:crypto'
import { BlockAssembler, createUserMessage, type GenerateOptions, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { JudgeConfig, StageConfig, TierSource, TiersConfig } from '../config/schema.js'
import { hasTiers } from '../config/validate.js'
import { JUDGE_SYSTEM, clip, firstObject, type StreamFn } from './judge.js'

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

export function renderTierPrompt(tiers: TiersConfig, tasks: readonly string[]): string {
  return [
    'Classify each coding task by how much reasoning it needs, choosing exactly one tier per task.',
    '',
    'Tiers, lightest first:',
    ...tiers.levels.map(level => `- ${level.id}: ${level.description || '(no description)'}`),
    '',
    'Tasks:',
    ...tasks.map((task, i) => `${i + 1}. ${clip(task)}`),
    '',
    'Reply with JSON only, no prose:',
    '{"tiers": ["<tier id for task 1>", "<tier id for task 2>", ...]}',
  ].join('\n')
}

/**
 * Parse a tier reply. Accepts `{"tiers": [...]}` or `{"1": "light", ...}`;
 * unknown tiers and missing entries come back as `undefined`.
 */
export function parseTierReply(text: string, count: number, tiers: TiersConfig): (string | undefined)[] {
  const out: (string | undefined)[] = Array.from({ length: count }, () => undefined)
  const raw = firstObject(text)
  if (raw === undefined) return out
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof value !== 'object' || value === null) return out
  const record = value as Record<string, unknown>
  const list = Array.isArray(record.tiers)
    ? record.tiers
    : Array.from({ length: count }, (_, i) => record[String(i + 1)])
  for (let i = 0; i < count; i++) {
    const tier = list[i]
    if (typeof tier === 'string' && tierRank(tiers, tier.trim()) >= 0) out[i] = tier.trim()
  }
  return out
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
    private readonly stream: StreamFn,
    private readonly log: (message: string, ...args: unknown[]) => void,
    private readonly limit = 2000,
  ) {}

  /** Start judging every text not judged yet, in batches of {@link TIER_BATCH_LIMIT}. */
  classify(stage: StageConfig, texts: readonly string[], judge: JudgeConfig): void {
    if (!hasTiers(stage)) return
    const fresh = [...new Set(texts.map(text => text.trim()))].filter(text => text !== '' && !this.cache.has(key(stage, text)))
    for (let i = 0; i < fresh.length; i += TIER_BATCH_LIMIT) {
      const batch = fresh.slice(i, i + TIER_BATCH_LIMIT)
      const result = this.judgeBatch(stage.tiers!, batch, judge)
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

  private async judgeBatch(tiers: TiersConfig, texts: string[], judge: JudgeConfig): Promise<(string | undefined)[]> {
    const started = Date.now()
    const timeout = AbortSignal.timeout(judge.timeoutMs)
    const options: GenerateOptions = {
      provider: judge.route.provider,
      model: judge.route.model,
      ...judge.route.reasoningEffort === undefined ? {} : { reasoningEffort: judge.route.reasoningEffort as ReasoningEffortId },
      system: JUDGE_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: renderTierPrompt(tiers, texts) }], source: { kind: 'user' } })],
      maxTokens: 50 + 20 * texts.length,
      temperature: 0,
      signal: timeout,
    }
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of this.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind === 'error') throw new Error(assembler.finish.failure.message)
      const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      const tiersOut = parseTierReply(text, texts.length, tiers)
      this.log('stage-router: tier judge classified %d task(s) in %dms', texts.length, Date.now() - started)
      return tiersOut
    } catch (error) {
      this.log('stage-router: tier judge failed (%s); using the default tier', timeout.aborted ? `timeout after ${judge.timeoutMs}ms` : String(error))
      return texts.map(() => undefined)
    }
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
