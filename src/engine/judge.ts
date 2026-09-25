import { BlockAssembler, createUserMessage, type GenerateOptions, type Message, type ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JudgeConfig } from '../config/schema.js'
import { DEFAULT_JUDGE_TEMPLATE } from '../config/defaults.js'
import type { Judgement } from './transitions.js'

/** The slice of `ctx.llm` the judge needs. */
export type StreamFn = (options: GenerateOptions) => AsyncIterable<StreamChunk>

export interface JudgeCandidate {
  id: string
  description: string
}

export interface JudgeInput {
  /** Current stage id, `null` before the first message. */
  current: string | null
  candidates: JudgeCandidate[]
  /** Pre-rendered recent conversation excerpt (see {@link summarizeRecent}). */
  recent: string
  /** The new user message. */
  message: string
}

export type TimedJudgement = Judgement & { elapsedMs: number }

/** Each recent-conversation segment is clipped to this many characters. */
export const SEGMENT_LIMIT = 800

export const JUDGE_SYSTEM = 'You are a routing classifier for a coding assistant. Reply with a single JSON object and nothing else.'

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
  if (turns <= 0) return '(none)'
  const lines: string[][] = []
  for (const message of history) {
    if (message.role === 'user' && message.source.kind === 'user') {
      lines.push([`User: ${clip(textOf(message))}`])
    } else if (message.role === 'assistant' && lines.length > 0) {
      const text = textOf(message)
      if (text.trim() !== '') lines.at(-1)!.push(`Assistant: ${clip(text)}`)
    }
  }
  const recent = lines.slice(-turns).flat()
  return recent.length === 0 ? '(none)' : recent.join('\n')
}

export function renderPrompt(template: string | null, input: JudgeInput): string {
  const vars: Record<string, string> = {
    current: input.current ?? 'none',
    candidates: input.candidates.map(c => `- ${c.id}: ${c.description || '(no description)'}`).join('\n'),
    recent: input.recent,
    message: clip(input.message, SEGMENT_LIMIT * 2),
  }
  return (template ?? DEFAULT_JUDGE_TEMPLATE).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => vars[key] ?? whole)
}

/** First balanced `{…}` object in `text`, ignoring braces inside strings. */
export function firstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

/** Tolerant parse of the judge's reply: code fences, surrounding prose, string numbers. */
export function parseJudgement(text: string): Judgement {
  const raw = firstObject(text)
  if (raw === undefined) return { ok: false, error: 'no JSON object in reply' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'malformed JSON' }
  }
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'reply is not an object' }
  const { stage, confidence, reason } = value as Record<string, unknown>
  if (typeof stage !== 'string' || stage.trim() === '') return { ok: false, error: 'missing "stage"' }
  const score = typeof confidence === 'string' ? Number(confidence) : confidence
  if (typeof score !== 'number' || Number.isNaN(score)) return { ok: false, error: 'missing "confidence"' }
  return {
    ok: true,
    stage: stage.trim(),
    confidence: Math.min(1, Math.max(0, score)),
    reason: typeof reason === 'string' ? reason : '',
  }
}

/**
 * Ask the judge model. Never throws: timeouts, provider errors and bad replies
 * come back as `{ ok: false }`. The call carries no `sessionId`, so it never
 * enters a session log.
 */
export async function runJudge(
  stream: StreamFn,
  config: JudgeConfig,
  input: JudgeInput,
  signal?: AbortSignal,
): Promise<TimedJudgement> {
  const started = Date.now()
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const done = (result: Judgement): TimedJudgement => ({ ...result, elapsedMs: Date.now() - started })
  const options: GenerateOptions = {
    provider: config.route.provider,
    model: config.route.model,
    ...config.route.reasoningEffort === undefined ? {} : { reasoningEffort: config.route.reasoningEffort as ReasoningEffortId },
    system: JUDGE_SYSTEM,
    messages: [createUserMessage({
      content: [{ type: 'text', text: renderPrompt(config.promptTemplate, input) }],
      source: { kind: 'user' },
    })],
    maxTokens: 400,
    temperature: 0,
    signal: combined,
  }
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of stream(options)) {
      if (combined.aborted) break
      assembler.push(chunk)
    }
    if (timeout.aborted) return done({ ok: false, error: `timeout after ${config.timeoutMs}ms` })
    if (combined.aborted) return done({ ok: false, error: 'aborted' })
    const finish = assembler.finish
    if (finish.kind === 'error') return done({ ok: false, error: `provider error: ${finish.failure.message}` })
    const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    return done(parseJudgement(text))
  } catch (error) {
    if (timeout.aborted) return done({ ok: false, error: `timeout after ${config.timeoutMs}ms` })
    return done({ ok: false, error: error instanceof Error ? error.message : String(error) })
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
