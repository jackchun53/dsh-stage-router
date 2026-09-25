import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { checkDraft, tryJudge } from '../src/editor-service.js'
import type { StreamFn } from '../src/engine/judge.js'

const draft = { schemes: [EXAMPLE_SCHEME] }

function replying(text: string): { stream: StreamFn; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return {
    calls,
    stream: options => {
      calls.push(options)
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

describe('checkDraft', () => {
  it('accepts the example and resolves defaults', async () => {
    const { config, issues } = await checkDraft(draft)
    expect(issues).toEqual([])
    expect(config!.defaultJudge.timeoutMs).toBe(6000)
  })

  it('turns a schema error into a field issue', async () => {
    const { config, issues } = await checkDraft({ schemes: [{ id: 'x', stages: [] }] })
    expect(config).toBeUndefined()
    expect(issues).toEqual([{ path: 'schemes[0].initialStage', message: '缺少必填项' }])
  })

  it('reports structural issues and unusable or empty models by path', async () => {
    const broken = structuredClone(EXAMPLE_SCHEME)
    broken.initialStage = 'nope'
    broken.stages[0]!.route = { provider: '', model: '' }
    const { issues } = await checkDraft({ schemes: [broken] }, async route => route.model !== 'deepseek-v4-pro')
    expect(issues.map(i => i.path)).toEqual(expect.arrayContaining([
      'schemes[0].initialStage',
      'schemes[0].stages[0].route',
      'schemes[0].stages[1].tiers.levels[1].route',
      'schemes[0].stages[2].route',
    ]))
    expect(issues.find(i => i.path === 'schemes[0].stages[0].route')!.message).toBe('请选择模型')
  })

  it('checks the default judge model', async () => {
    const { issues } = await checkDraft(draft, async route => route.model !== 'deepseek-flash')
    expect(issues.map(i => i.path)).toContain('defaultJudge.route')
  })
})

describe('tryJudge', () => {
  it('runs the draft judge on a message and applies its answer', async () => {
    const { stream, calls } = replying('{"stage":"plan","confidence":0.8,"reason":"design talk"}')
    const result = await tryJudge(stream, { draft, scheme: 'dev-default', current: 'code', message: 'how should we structure this?' })
    expect(result.candidates).toEqual(['plan', 'code', 'review'])
    expect(result.judgement).toMatchObject({ ok: true, stage: 'plan', confidence: 0.8 })
    expect(result.decision).toEqual({ kind: 'goto', stage: 'plan', reason: '判断器：design talk' })
    expect(calls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(calls[0]).not.toHaveProperty('sessionId')
  })

  it('shows the fallback when confidence is too low', async () => {
    const { stream } = replying('{"stage":"plan","confidence":0.2}')
    const result = await tryJudge(stream, { draft, scheme: 'dev-default', current: null, message: 'hi' })
    expect(result.decision).toMatchObject({ kind: 'goto', stage: 'code' })
  })

  it('skips the judge when the rules leave one candidate', async () => {
    const single = structuredClone(EXAMPLE_SCHEME)
    single.transitions = [{ from: '*', to: 'review', on: 'user_message' }]
    const { stream, calls } = replying('{}')
    const result = await tryJudge(stream, { draft: { schemes: [single] }, scheme: 'dev-default', current: 'code', message: 'x' })
    expect(result).toMatchObject({ candidates: ['review'], decision: { kind: 'goto', stage: 'review' } })
    expect(result.judgement).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('reports an unknown scheme or an invalid draft', async () => {
    const { stream } = replying('{}')
    expect((await tryJudge(stream, { draft, scheme: 'nope', current: null, message: 'x' })).decision).toEqual({ kind: 'stay', reason: '没有方案「nope」' })
    expect((await tryJudge(stream, { draft: { schemes: [{}] }, scheme: 'x', current: null, message: 'x' })).issues).toHaveLength(1)
  })
})
