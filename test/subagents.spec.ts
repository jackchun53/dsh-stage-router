import { describe, expect, it } from 'vitest'
import { DEFAULT_JEV, parseConfig, type SchemeConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { routeChild, type ChildRouteDeps, type ChildView, type ParentView } from '../src/engine/subagents.js'

const light = { provider: 'p', model: 'light' }
const heavy = { provider: 'p', model: 'heavy', reasoningEffort: 'max' }
const flash = { provider: 'deepseek-official', model: 'deepseek-flash' }
const review = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

function scheme(subagents: Record<string, unknown> = {}): SchemeConfig {
  return parseConfig({
    schemes: [{
      ...EXAMPLE_SCHEME,
      subagents: { enabled: true, stage: 'inherit', classify: true, ...subagents },
      stages: EXAMPLE_SCHEME.stages.map(s => s.id !== 'code' ? s : {
        ...s,
        tiers: {
          source: 'planner-then-judge',
          default: 'heavy',
          levels: [{ id: 'light', description: 'small', route: light }, { id: 'heavy', description: 'big', route: heavy }],
        },
      }),
    }],
  }).schemes[0]!
}

function deps(judged: Record<string, string> = {}, unusable: string[] = []): ChildRouteDeps & { classified: string[] } {
  const classified: string[] = []
  return {
    classified,
    tiers: {
      classify: (_stage, texts) => { classified.push(...texts) },
      lookup: (_stage, text) => text in judged ? Promise.resolve(judged[text]) : undefined,
    },
    jev: DEFAULT_JEV,
    usable: async route => !unusable.includes(route.model),
    waitMs: 20,
  }
}

const parent = (s: SchemeConfig, stage: string, route = flash, todos: ParentView['todos'] = null): ParentView => ({ scheme: s, stage, route, todos })
const child = (patch: Partial<ChildView> = {}): ChildView => ({ fork: false, config: flash, task: 'do things', ...patch })

describe('routeChild', () => {
  it('leaves children alone when subagent routing is off', async () => {
    expect(await routeChild(child(), parent(scheme({ enabled: false }), 'code'), deps())).toBeUndefined()
  })

  it('respects an explicitly chosen child model', async () => {
    expect(await routeChild(child({ config: { provider: 'other', model: 'x' } }), parent(scheme(), 'code'), deps())).toBeUndefined()
  })

  it('lets a fork follow the parent route', async () => {
    expect(await routeChild(child({ fork: true, config: review }), parent(scheme(), 'review', review), deps()))
      .toEqual({ route: review, stage: 'review', reason: 'fork 出来的子 agent 跟随父会话' })
  })

  it('uses the tier of the parent todo named by a [Tn] prefix', async () => {
    const todos = [{ content: '[T2][light] rename helper', status: 'in_progress' }]
    const d = deps()
    expect(await routeChild(child({ label: '[T2] rename', task: 'rename it' }), parent(scheme(), 'code', flash, todos), d))
      .toMatchObject({ route: light, stage: 'code', tier: 'light', reason: '规划任务 [T2] 的档位' })
    expect(d.classified).toEqual([])
  })

  it('judges the task when there is no tag, else falls back to the default tier', async () => {
    expect(await routeChild(child({ task: 'tiny fix' }), parent(scheme(), 'code'), deps({ 'tiny fix': 'light' })))
      .toMatchObject({ route: light, tier: 'light', reason: 'Jev 定档' })
    expect(await routeChild(child({ task: 'unknown' }), parent(scheme(), 'code'), deps()))
      .toMatchObject({ route: heavy, tier: 'heavy', reason: '默认档' })
    const noClassify = deps({ 'tiny fix': 'light' })
    expect(await routeChild(child({ task: 'tiny fix' }), parent(scheme({ classify: false }), 'code'), noClassify))
      .toMatchObject({ tier: 'heavy' })
    expect(noClassify.classified).toEqual([])
  })

  it('uses a fixed stage when configured, with that stage route when it has no tiers', async () => {
    expect(await routeChild(child(), parent(scheme({ stage: 'review' }), 'code'), deps()))
      .toEqual({ route: review, stage: 'review', reason: '阶段模型' })
  })

  it('falls back to the stage route when the tier model is unusable', async () => {
    expect(await routeChild(child({ task: 'x' }), parent(scheme(), 'code'), deps({}, ['heavy'])))
      .toMatchObject({ route: flash, tier: 'heavy' })
  })

  it('does nothing before the parent has a route', async () => {
    expect(await routeChild(child(), { ...parent(scheme(), 'code'), route: undefined }, deps())).toBeUndefined()
  })
})
