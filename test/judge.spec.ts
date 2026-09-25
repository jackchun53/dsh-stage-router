import { describe, expect, it } from 'vitest'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { JudgeCache, NO_RECENT, STAGE_QUESTION, runJudge, summarizeRecent, type JudgeInput } from '../src/engine/judge.js'
import { choice, fakeJev, jev } from './helpers/fake-jev.js'

const input: JudgeInput = {
  current: 'code',
  currentDescription: 'write code',
  candidates: [{ id: 'plan', description: 'design' }, { id: 'code', description: '' }],
  recent: '用户：hi',
  message: 'let us plan the refactor',
}

describe('summarizeRecent', () => {
  const user = (text: string, kind = 'user'): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind } as never }) as Message
  const assistant = (text: string): Message => ({ id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } as never)

  it('keeps the last N turns and skips notices', () => {
    const history = [user('one'), assistant('r1'), user('[stage]', 'stage-router'), user('two'), assistant('r2'), user('three')]
    expect(summarizeRecent(history, 2)).toBe('用户：two\n助手：r2\n用户：three')
    expect(summarizeRecent(history, 0)).toBe(NO_RECENT)
  })

  it('clips long segments to 800 characters', () => {
    const text = summarizeRecent([user('x'.repeat(2000))], 1)
    expect(text.length).toBe('用户：'.length + 800 + 1)
  })
})

describe('runJudge', () => {
  it('asks Jev one choice question over the candidate stages', async () => {
    const { fetch, calls } = fakeJev(() => ({ answers: { stage: { type: 'choice', choice: 'plan', probabilities: { plan: 0.8, code: 0.2 } } } }))
    const result = await runJudge(fetch, jev, input)
    expect(result).toMatchObject({ ok: true, stage: 'plan', confidence: 0.8, probabilities: { plan: 0.8, code: 0.2 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://jev.test/v1/systemone')
    expect(calls[0]!.headers.authorization).toBe('Bearer secret-token')
    expect(calls[0]!.body.model).toBe('jev-test')
    expect(calls[0]!.body.questions[STAGE_QUESTION]).toMatchObject({ type: 'choice', criteria: { plan: 'design', code: 'code' } })
    expect(calls[0]!.body.state).toEqual({ prompt: 'let us plan the refactor', current: 'code：write code', recent: '用户：hi' })
  })

  it('prefers Jev confidence and names the first message', async () => {
    const { fetch, calls } = fakeJev(() => ({ answers: { stage: { ...choice('code', { code: 0.5 }), confidence: 0.7 } } }))
    expect(await runJudge(fetch, jev, { ...input, current: null })).toMatchObject({ ok: true, stage: 'code', confidence: 0.7 })
    expect(calls[0]!.body.state.current).toBe('（会话第一条消息）')
  })

  it('fails when Jev gives no stage answer', async () => {
    const { fetch } = fakeJev(() => ({ answers: { stage: { type: 'noul', noul: true } } }))
    expect(await runJudge(fetch, jev, input)).toMatchObject({ ok: false, error: 'Jev 没有给出阶段选择' })
  })

  it('passes Jev failures through', async () => {
    const { fetch } = fakeJev(() => ({}), 500)
    expect(await runJudge(fetch, jev, input)).toMatchObject({ ok: false, error: 'Jev 返回 HTTP 500' })
  })
})

describe('JudgeCache', () => {
  it('judges each message once', async () => {
    const { fetch, calls } = fakeJev(() => ({ answers: { stage: choice('plan') } }))
    const cache = new JudgeCache()
    const run = () => cache.run('s1', 'm1', () => runJudge(fetch, jev, input))
    const [a, b] = await Promise.all([run(), run()])
    expect(a).toBe(b)
    await cache.run('s1', 'm2', () => runJudge(fetch, jev, input))
    expect(calls).toHaveLength(2)
  })

  it('evicts the oldest entry past its limit', async () => {
    const cache = new JudgeCache(2)
    const judged = Promise.resolve({ ok: false as const, error: 'x', elapsedMs: 0 })
    for (const id of ['a', 'b', 'c']) await cache.run('s', id, () => judged)
    expect(cache.size).toBe(2)
  })
})
