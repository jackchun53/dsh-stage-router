import type { Message } from '@deepseek-ai/dsh-llm'
import type { JevConfig } from '../config/schema.js'
import { askJev, type FetchFn } from './jev.js'
import type { Judgement } from './transitions.js'

export type { FetchFn } from './jev.js'

export interface JudgeCandidate {
  id: string
  description: string
}

export interface JudgeInput {
  /** Current stage id, `null` before the first message. */
  current: string | null
  /** Description of the current stage, when there is one. */
  currentDescription?: string
  candidates: JudgeCandidate[]
  /** Pre-rendered recent conversation excerpt (see {@link summarizeRecent}). */
  recent: string
  /** The new user message. */
  message: string
}

export type TimedJudgement = Judgement & {
  elapsedMs: number
  /** Jev's probability per candidate stage, when it answered. */
  probabilities?: Record<string, number>
}

/** Each recent-conversation segment is clipped to this many characters. */
export const SEGMENT_LIMIT = 800
/** The user message is clipped to this many characters before it goes to Jev. */
export const MESSAGE_LIMIT = 4000

/** `recent` when there is no earlier conversation. */
export const NO_RECENT = '（无）'

export const STAGE_QUESTION = 'stage'
export const STAGE_INSTRUCTIONS = '判断这条开发者消息接下来应处于哪个工作阶段'

export function clip(text: string, limit = SEGMENT_LIMIT): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

function textOf(message: Pick<Message, 'content'>): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Render the last `turns` conversation turns for the judge. A turn starts at a
 * real user message (`source.kind === 'user'`) and includes the assistant text
 * after it; tool traffic and notices are skipped.
 */
export function summarizeRecent(history: readonly Message[], turns: number): string {
  if (turns <= 0) return NO_RECENT
  const lines: string[][] = []
  for (const message of history) {
    if (message.role === 'user' && message.source.kind === 'user') {
      lines.push([`用户：${clip(textOf(message))}`])
    } else if (message.role === 'assistant' && lines.length > 0) {
      const text = textOf(message)
      if (text.trim() !== '') lines.at(-1)!.push(`助手：${clip(text)}`)
    }
  }
  const recent = lines.slice(-turns).flat()
  return recent.length === 0 ? NO_RECENT : recent.join('\n')
}

/**
 * Ask Jev which candidate stage the new message belongs to: one `choice`
 * question whose options are the candidate stages and their descriptions.
 * Never throws; failures come back as `{ ok: false }`.
 */
export async function runJudge(
  fetchFn: FetchFn,
  jev: JevConfig,
  input: JudgeInput,
  signal?: AbortSignal,
): Promise<TimedJudgement> {
  const criteria = Object.fromEntries(input.candidates.map(c => [c.id, c.description.trim() || c.id]))
  const current = input.current === null
    ? '（会话第一条消息）'
    : input.currentDescription ? `${input.current}：${input.currentDescription}` : input.current
  const result = await askJev(fetchFn, jev, {
    prompt: clip(input.message, MESSAGE_LIMIT),
    current,
    recent: input.recent,
  }, { [STAGE_QUESTION]: { type: 'choice', instructions: STAGE_INSTRUCTIONS, criteria } }, signal)
  if (!result.ok) return { ok: false, error: result.error, elapsedMs: result.elapsedMs }
  const answer = result.answers[STAGE_QUESTION]
  if (answer === undefined) return { ok: false, error: 'Jev 没有给出阶段选择', elapsedMs: result.elapsedMs }
  return {
    ok: true,
    stage: answer.choice,
    confidence: answer.confidence,
    reason: '',
    elapsedMs: result.elapsedMs,
    probabilities: answer.probabilities,
  }
}

/** One judgement per (session, message); bounded so long-lived hosts do not grow. */
export class JudgeCache {
  private readonly entries = new Map<string, Promise<TimedJudgement>>()

  constructor(private readonly limit = 500) {}

  run(sessionId: string, messageId: string, compute: () => Promise<TimedJudgement>): Promise<TimedJudgement> {
    const key = `${sessionId}\u0000${messageId}`
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit
    const pending = compute()
    this.entries.set(key, pending)
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
    return pending
  }

  get size(): number {
    return this.entries.size
  }
}
