import { jevConfigured, type JevConfig } from '../config/schema.js'

/** The slice of `fetch` the Jev client needs; injectable for tests. */
export type FetchFn = (url: string, init: {
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** One Jev question: pick one of `criteria` (option id → what it means). */
export interface JevChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export interface JevChoice {
  choice: string
  /** Jev's own confidence, else the probability of the chosen option; 0–1. */
  confidence: number
  probabilities: Record<string, number>
}

export type JevResult =
  | { ok: true; answers: Record<string, JevChoice | undefined>; elapsedMs: number }
  | { ok: false; error: string; elapsedMs: number }

/** `<baseUrl>/systemone`, tolerating a trailing slash. */
export function jevEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/systemone`
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** Read one `choice` answer; anything else (missing, other type, bad shape) is `undefined`. */
export function readChoice(answer: unknown): JevChoice | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined
  const { type, choice, probabilities, confidence } = answer as Record<string, unknown>
  if (type !== 'choice' || typeof choice !== 'string' || choice === '') return undefined
  const probs: Record<string, number> = {}
  if (typeof probabilities === 'object' && probabilities !== null) {
    for (const [key, value] of Object.entries(probabilities)) {
      if (typeof value === 'number' && Number.isFinite(value)) probs[key] = clamp(value)
    }
  }
  const score = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : probs[choice] ?? 0
  return { choice, confidence: clamp(score), probabilities: probs }
}

/**
 * Ask Jev a set of choice questions about one state. Never throws: missing
 * configuration, timeouts, HTTP and decode failures come back as `{ ok: false }`
 * with a user-facing reason.
 */
export async function askJev(
  fetchFn: FetchFn,
  jev: JevConfig,
  state: Record<string, unknown>,
  questions: Record<string, JevChoiceQuestion>,
  signal?: AbortSignal,
): Promise<JevResult> {
  const started = Date.now()
  const fail = (error: string): JevResult => ({ ok: false, error, elapsedMs: Date.now() - started })
  if (!jevConfigured(jev)) return fail('Jev 未配置')
  const timeout = AbortSignal.timeout(jev.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetchFn(jevEndpoint(jev.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${jev.token.trim()}`,
      },
      body: JSON.stringify({ model: jev.model, state, questions }),
      signal: combined,
    })
    if (response.status === 401) return fail('Jev 认证失败（401），请检查 token')
    if (!response.ok) return fail(`Jev 返回 HTTP ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return fail('Jev 返回格式不对')
    }
    const answers = (body as { answers?: unknown } | null)?.answers
    if (typeof answers !== 'object' || answers === null) return fail('Jev 返回格式不对')
    const read: Record<string, JevChoice | undefined> = {}
    for (const key of Object.keys(questions)) read[key] = readChoice((answers as Record<string, unknown>)[key])
    return { ok: true, answers: read, elapsedMs: Date.now() - started }
  } catch (error) {
    if (timeout.aborted) return fail(`Jev 超时（${jev.timeoutMs} 毫秒）`)
    if (combined.aborted) return fail('已取消')
    return fail(`无法连接 Jev：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The global `fetch`, typed as {@link FetchFn}. */
export const globalFetch: FetchFn = (url, init) => fetch(url, init)
