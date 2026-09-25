import { DEFAULT_JEV, type JevConfig } from '../../src/config/schema.js'
import type { FetchFn } from '../../src/engine/jev.js'

export const jev: JevConfig = { ...DEFAULT_JEV, baseUrl: 'https://jev.test/v1/', token: 'secret-token', model: 'jev-test' }

export interface JevCall {
  url: string
  headers: Record<string, string>
  body: {
    model: string
    state: Record<string, unknown>
    questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
  }
}

/** A fake `fetch` answering every Jev call with `respond(body)`; records the calls. */
export function fakeJev(respond: (body: JevCall['body']) => unknown, status = 200): { fetch: FetchFn; calls: JevCall[] } {
  const calls: JevCall[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as JevCall['body']
      calls.push({ url, headers: init.headers, body })
      const answer = await respond(body)
      return { ok: status >= 200 && status < 300, status, json: async () => answer }
    },
  }
}

/** A Jev `choice` answer. */
export const choice = (picked: string, probabilities: Record<string, number> = { [picked]: 0.9 }) =>
  ({ type: 'choice', choice: picked, probabilities })

/** A fake Jev that picks `stage` for the stage question. */
export const stageJev = (stage: string, confidence = 0.9) =>
  fakeJev(() => ({ answers: { stage: choice(stage, { [stage]: confidence }) } }))
