import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_JUDGE, type JudgeConfig } from '../src/config/schema.js'
import { JudgeCache, parseJudgement, renderPrompt, runJudge, summarizeRecent, type JudgeInput, type StreamFn } from '../src/engine/judge.js'

const input: JudgeInput = {
  current: 'code',
  candidates: [{ id: 'plan', description: 'design' }, { id: 'code', description: 'write code' }],
  recent: 'User: hi',
  message: 'let us plan the refactor',
}

async function* reply(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function recorder(text: string): { stream: StreamFn; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return { calls, stream: options => { calls.push(options); return reply(text) } }
}

const config: JudgeConfig = { ...DEFAULT_JUDGE, route: { provider: 'fake', model: 'judge', reasoningEffort: 'off' } }

describe('renderPrompt', () => {
  it('fills every variable of the default template', () => {
    const text = renderPrompt(null, input)
    expect(text).toContain('Current stage: code')
    expect(text).toContain('- plan: design\n- code: write code')
    expect(text).toContain('User: hi')
    expect(text).toContain('let us plan the refactor')
    expect(text).not.toMatch(/\{\{/)
  })

  it('uses a custom template and leaves unknown variables alone', () => {
    expect(renderPrompt('{{ current }}|{{message}}|{{other}}', { ...input, current: null })).toBe('none|let us plan the refactor|{{other}}')
  })
})

describe('summarizeRecent', () => {
  const user = (text: string, kind = 'user'): Message => createUserMessage({ content: [{ type: 'text', text }], source: { kind } as never }) as Message
  const assistant = (text: string): Message => ({ id: 'a', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } as never)

  it('keeps the last N turns and skips notices', () => {
    const history = [user('one'), assistant('r1'), user('[stage]', 'stage-router'), user('two'), assistant('r2'), user('three')]
    expect(summarizeRecent(history, 2)).toBe('User: two\nAssistant: r2\nUser: three')
    expect(summarizeRecent(history, 0)).toBe('(none)')
  })

  it('clips long segments to 800 characters', () => {
    const text = summarizeRecent([user('x'.repeat(2000))], 1)
    expect(text.length).toBe('User: '.length + 800 + 1)
  })
})

describe('parseJudgement', () => {
  it('reads plain JSON', () => {
    expect(parseJudgement('{"stage":"plan","confidence":0.8,"reason":"design talk"}'))
      .toEqual({ ok: true, stage: 'plan', confidence: 0.8, reason: 'design talk' })
  })

  it('reads JSON inside a code fence with prose around it', () => {
    expect(parseJudgement('Sure:\n```json\n{"stage": "code", "confidence": "0.7", "reason": "has {braces}"}\n```'))
      .toEqual({ ok: true, stage: 'code', confidence: 0.7, reason: 'has {braces}' })
  })

  it('clamps confidence into [0, 1]', () => {
    expect(parseJudgement('{"stage":"plan","confidence":7}')).toMatchObject({ ok: true, confidence: 1, reason: '' })
  })

  it('fails on missing fields or garbage', () => {
    expect(parseJudgement('{"confidence":0.9}')).toMatchObject({ ok: false })
    expect(parseJudgement('{"stage":"plan"}')).toMatchObject({ ok: false })
    expect(parseJudgement('no idea')).toMatchObject({ ok: false })
    expect(parseJudgement('{"stage": ')).toMatchObject({ ok: false })
  })
})

describe('runJudge', () => {
  it('calls the judge route without a sessionId and parses the reply', async () => {
    const { stream, calls } = recorder('{"stage":"plan","confidence":0.9,"reason":"r"}')
    const result = await runJudge(stream, config, input)
    expect(result).toMatchObject({ ok: true, stage: 'plan', confidence: 0.9 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'fake', model: 'judge', reasoningEffort: 'off', temperature: 0 })
    expect(calls[0]).not.toHaveProperty('sessionId')
    expect(calls[0]!.system).toMatch(/JSON/)
  })

  it('fails on timeout', async () => {
    const stream: StreamFn = options => (async function* () {
      await new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason)))
      yield* reply('{}')
    })()
    const result = await runJudge(stream, { ...config, timeoutMs: 30 }, input)
    expect(result).toMatchObject({ ok: false, error: '超时（30 毫秒）' })
  })

  it('fails on a provider error finish', async () => {
    const stream: StreamFn = async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'boom' } } } as StreamChunk
    }
    expect(await runJudge(stream, config, input)).toMatchObject({ ok: false, error: '模型服务出错：boom' })
  })

  it('fails when the stream throws', async () => {
    const stream: StreamFn = () => { throw new Error('no adapter') }
    expect(await runJudge(stream, config, input)).toMatchObject({ ok: false, error: 'no adapter' })
  })
})

describe('JudgeCache', () => {
  it('judges each message once', async () => {
    const { stream, calls } = recorder('{"stage":"plan","confidence":0.9}')
    const cache = new JudgeCache()
    const run = () => cache.run('s1', 'm1', () => runJudge(stream, config, input))
    const [a, b] = await Promise.all([run(), run()])
    expect(a).toBe(b)
    await cache.run('s1', 'm2', () => runJudge(stream, config, input))
    expect(calls).toHaveLength(2)
  })

  it('evicts the oldest entry past its limit', async () => {
    const cache = new JudgeCache(2)
    const judged = Promise.resolve({ ok: false as const, error: 'x', elapsedMs: 0 })
    for (const id of ['a', 'b', 'c']) await cache.run('s', id, () => judged)
    expect(cache.size).toBe(2)
  })
})
