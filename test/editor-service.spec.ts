import { describe, expect, it } from 'vitest'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { blocking, checkDraft, tryJudge } from '../src/editor-service.js'
import { fakeJev, jev, stageJev } from './helpers/fake-jev.js'

const draft = { jev, schemes: [EXAMPLE_SCHEME] }

describe('checkDraft', () => {
  it('accepts the example and resolves defaults', async () => {
    const { config, issues } = await checkDraft(draft)
    expect(issues).toEqual([])
    expect(config!.jev.minConfidence).toBe(0.6)
  })

  it('warns, without blocking, when Jev has no token', async () => {
    const { issues } = await checkDraft({ schemes: [EXAMPLE_SCHEME] })
    expect(issues).toEqual([expect.objectContaining({ path: 'jev', severity: 'warning' })])
    expect(blocking(issues)).toEqual([])
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
    const { issues } = await checkDraft({ jev, schemes: [broken] }, async route => route.model !== 'deepseek-v4-pro')
    expect(issues.map(i => i.path)).toEqual(expect.arrayContaining([
      'schemes[0].initialStage',
      'schemes[0].stages[0].route',
      'schemes[0].stages[1].tiers.levels[1].route',
      'schemes[0].stages[2].route',
    ]))
    expect(issues.find(i => i.path === 'schemes[0].stages[0].route')!.message).toBe('请选择模型')
    expect(issues.find(i => i.path === 'schemes[0].stages[2].route')!.severity).toBe('warning')
    expect(blocking(issues).map(i => i.path).sort()).toEqual(['schemes[0].initialStage', 'schemes[0].stages[0].route'])
  })
})

describe('tryJudge', () => {
  it('asks Jev with the draft settings and applies its answer', async () => {
    const { fetch, calls } = stageJev('plan', 0.8)
    const result = await tryJudge(fetch, { draft, scheme: 'dev-default', current: 'code', message: 'how should we structure this?' })
    expect(result.candidates).toEqual(['plan', 'code', 'review'])
    expect(result.judgement).toMatchObject({ ok: true, stage: 'plan', confidence: 0.8, probabilities: { plan: 0.8 } })
    expect(result.decision).toEqual({ kind: 'goto', stage: 'plan', reason: 'Jev 判断（置信度 80%）' })
    expect(calls[0]!.url).toBe('https://jev.test/v1/systemone')
    expect(Object.keys(calls[0]!.body.questions.stage!.criteria)).toEqual(['plan', 'code', 'review'])
  })

  it('shows the fallback when confidence is too low', async () => {
    const { fetch } = stageJev('plan', 0.2)
    const result = await tryJudge(fetch, { draft, scheme: 'dev-default', current: null, message: 'hi' })
    expect(result.decision).toMatchObject({ kind: 'goto', stage: 'code' })
  })

  it('skips Jev when the rules leave one candidate', async () => {
    const single = structuredClone(EXAMPLE_SCHEME)
    single.transitions = [{ from: '*', to: 'review', on: 'user_message' }]
    const { fetch, calls } = fakeJev(() => ({}))
    const result = await tryJudge(fetch, { draft: { jev, schemes: [single] }, scheme: 'dev-default', current: 'code', message: 'x' })
    expect(result).toMatchObject({ candidates: ['review'], decision: { kind: 'goto', stage: 'review' } })
    expect(result.judgement).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('reports an unknown scheme or an invalid draft', async () => {
    const { fetch } = fakeJev(() => ({}))
    expect((await tryJudge(fetch, { draft, scheme: 'nope', current: null, message: 'x' })).decision).toEqual({ kind: 'stay', reason: '没有方案「nope」' })
    expect((await tryJudge(fetch, { draft: { schemes: [{}] }, scheme: 'x', current: null, message: 'x' })).issues).toHaveLength(1)
  })
})
