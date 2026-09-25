import { describe, expect, it } from 'vitest'
import { askJev, jevEndpoint, readChoice, type FetchFn } from '../src/engine/jev.js'
import { fakeJev, jev } from './helpers/fake-jev.js'

const question = { q: { type: 'choice' as const, instructions: 'pick', criteria: { a: 'A', b: 'B' } } }

describe('jevEndpoint', () => {
  it('appends /systemone, tolerating a trailing slash and spaces', () => {
    expect(jevEndpoint(' https://api.typesafe.ai/v1/ ')).toBe('https://api.typesafe.ai/v1/systemone')
  })
})

describe('readChoice', () => {
  it('reads a choice, clamps, and falls back to the chosen probability', () => {
    expect(readChoice({ type: 'choice', choice: 'a', probabilities: { a: 1.4, b: 'x' } })).toEqual({ choice: 'a', confidence: 1, probabilities: { a: 1 } })
    expect(readChoice({ type: 'choice', choice: 'b', probabilities: {}, confidence: 0.3 })).toMatchObject({ confidence: 0.3 })
    expect(readChoice({ type: 'choice', choice: 'b' })).toMatchObject({ confidence: 0 })
  })

  it('ignores other answer types and bad shapes', () => {
    expect(readChoice({ type: 'score', score: 1 })).toBeUndefined()
    expect(readChoice(null)).toBeUndefined()
    expect(readChoice({ type: 'choice', choice: '' })).toBeUndefined()
  })
})

describe('askJev', () => {
  it('posts model, state and questions with bearer auth', async () => {
    const { fetch, calls } = fakeJev(() => ({ answers: { q: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 } } } }))
    const result = await askJev(fetch, jev, { prompt: 'x' }, question)
    expect(result).toMatchObject({ ok: true, answers: { q: { choice: 'b', confidence: 0.9 } } })
    expect(calls[0]).toMatchObject({
      url: 'https://jev.test/v1/systemone',
      headers: { authorization: 'Bearer secret-token', accept: 'application/json' },
      body: { model: 'jev-test', state: { prompt: 'x' }, questions: question },
    })
  })

  it('does not call Jev without an address or token', async () => {
    const { fetch, calls } = fakeJev(() => ({}))
    expect(await askJev(fetch, { ...jev, token: ' ' }, {}, question)).toMatchObject({ ok: false, error: 'Jev 未配置' })
    expect(await askJev(fetch, { ...jev, baseUrl: '' }, {}, question)).toMatchObject({ ok: false, error: 'Jev 未配置' })
    expect(calls).toHaveLength(0)
  })

  it('reports 401, other HTTP errors and bad bodies', async () => {
    expect(await askJev(fakeJev(() => ({}), 401).fetch, jev, {}, question)).toMatchObject({ ok: false, error: expect.stringContaining('401') })
    expect(await askJev(fakeJev(() => ({}), 502).fetch, jev, {}, question)).toMatchObject({ ok: false, error: 'Jev 返回 HTTP 502' })
    expect(await askJev(fakeJev(() => ({ nope: 1 })).fetch, jev, {}, question)).toMatchObject({ ok: false, error: 'Jev 返回格式不对' })
    const badJson: FetchFn = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } })
    expect(await askJev(badJson, jev, {}, question)).toMatchObject({ ok: false, error: 'Jev 返回格式不对' })
  })

  it('times out and reports network errors', async () => {
    const hang: FetchFn = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await askJev(hang, { ...jev, timeoutMs: 20 }, {}, question)).toMatchObject({ ok: false, error: 'Jev 超时（20 毫秒）' })
    const down: FetchFn = async () => { throw new TypeError('fetch failed') }
    expect(await askJev(down, jev, {}, question)).toMatchObject({ ok: false, error: '无法连接 Jev：fetch failed' })
  })

  it('leaves a missing answer undefined', async () => {
    const result = await askJev(fakeJev(() => ({ answers: {} })).fetch, jev, {}, question)
    expect(result).toMatchObject({ ok: true, answers: { q: undefined } })
  })
})
