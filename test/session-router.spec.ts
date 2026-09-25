import { describe, expect, it } from 'vitest'
import { DEFAULT_JUDGE, parseConfig, type RouteConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { SessionRouter, type RouterDeps } from '../src/engine/session-router.js'
import { INITIAL_STATE, foldStageState, type StageRouterState } from '../src/engine/state.js'
import type { TimedJudgement } from '../src/engine/judge.js'

const scheme = parseConfig({ schemes: [EXAMPLE_SCHEME] }).schemes[0]!
const flash = { provider: 'deepseek-official', model: 'deepseek-flash' }
const pro = (effort: string) => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: effort })

function deps(options: { verdict?: TimedJudgement; unusable?: string[]; fallback?: RouteConfig; tiers?: RouterDeps['tiers'] } = {}) {
  const logs: string[] = []
  const judged: string[] = []
  const d: RouterDeps = {
    judge: async (input, _config, messageId) => {
      judged.push(`${messageId}:${input.candidates.map(c => c.id).join(',')}`)
      return options.verdict ?? { ok: false, error: 'no verdict', elapsedMs: 1 }
    },
    judgeConfig: () => DEFAULT_JUDGE,
    usable: async route => !(options.unusable ?? []).includes(route.model),
    defaultRoute: () => options.fallback,
    log: (level, message) => { logs.push(`${level}:${message}`) },
    tiers: options.tiers ?? { classify: () => {}, lookup: () => undefined },
    tierWaitMs: 20,
  }
  return { d, logs, judged }
}

const turn = (id: string) => ({ messageId: id, text: 'msg', recent: '(none)' })
const verdict = (stage: string, confidence = 0.9): TimedJudgement => ({ ok: true, stage, confidence, reason: 'r', elapsedMs: 5 })

describe('SessionRouter', () => {
  it('enters the initial stage when the first message cannot be judged, and announces it', async () => {
    const { d, judged } = deps()
    const router = new SessionRouter(scheme, INITIAL_STATE, d)
    expect(await router.onUserMessage(turn('m1'))).toEqual({ planMode: false })
    expect(judged).toEqual(['m1:plan,code,review'])
    expect(await router.resolveRoute()).toEqual(flash)
    const notice = router.takeNotice()!
    expect(notice.source).toMatchObject({ kind: 'stage-router', stage: 'code', from: null, route: flash, judge: { ok: false } })
    expect(router.takeNotice()).toBeUndefined()
  })

  it('follows a confident judgement and asks for plan mode on the plan stage', async () => {
    const { d } = deps({ verdict: verdict('plan') })
    const router = new SessionRouter(scheme, INITIAL_STATE, d)
    expect(await router.onUserMessage(turn('m1'))).toEqual({ planMode: true })
    expect(await router.resolveRoute()).toEqual(pro('max'))
  })

  it('resumes from the persisted projection and stays on a failed judgement', async () => {
    const { d } = deps()
    const first = new SessionRouter(scheme, INITIAL_STATE, deps({ verdict: verdict('review') }).d)
    await first.onUserMessage(turn('m1'))
    await first.resolveRoute()
    const persisted: StageRouterState = foldStageState(INITIAL_STATE, { type: 'user/message', data: first.takeNotice() })
    const resumed = new SessionRouter(scheme, persisted, d)
    expect(resumed.stage).toBe('review')
    expect(await resumed.onUserMessage(turn('m2'))).toBeUndefined()
    expect(resumed.stage).toBe('review')
    await resumed.resolveRoute()
    expect(resumed.takeNotice()).toBeUndefined()
  })

  it('ignores persisted state from another scheme', () => {
    const other: StageRouterState = { ...INITIAL_STATE, scheme: 'other', stage: 'review', notices: 1 }
    expect(new SessionRouter(scheme, other, deps().d).stage).toBeNull()
  })

  it('treats its own plan-mode switch as no trigger, a user switch as plan_mode_on', async () => {
    const router = new SessionRouter(scheme, INITIAL_STATE, deps({ verdict: verdict('plan') }).d)
    expect(router.observePlanMode(false)).toBeUndefined()
    await router.onUserMessage(turn('m1'))
    expect(router.observePlanMode(true)).toBeUndefined()
    const idle = new SessionRouter(scheme, { ...INITIAL_STATE, scheme: scheme.id, stage: 'code', route: flash, notices: 1 }, deps().d)
    idle.observePlanMode(false)
    expect(idle.observePlanMode(true)).toBe('plan_mode_on')
    expect(idle.onTrigger('plan_mode_on')).toEqual({ planMode: true })
    expect(idle.stage).toBe('plan')
  })

  it('reads plan mode turning off after a plan review as approval', () => {
    const router = new SessionRouter(scheme, { ...INITIAL_STATE, scheme: scheme.id, stage: 'plan', route: pro('max'), notices: 1 }, deps().d)
    router.observePlanMode(true)
    router.markPlanReview()
    expect(router.observePlanMode(false)).toBe('plan_approved')
    expect(router.onTrigger('plan_approved')).toEqual({ planMode: false })
    expect(router.stage).toBe('code')
  })

  it('reads plan mode turning off without a review as plan_mode_off', () => {
    const router = new SessionRouter(scheme, { ...INITIAL_STATE, scheme: scheme.id, stage: 'plan', notices: 1 }, deps().d)
    router.observePlanMode(true)
    expect(router.observePlanMode(false)).toBe('plan_mode_off')
  })

  it('fires todos_done once per completed checklist', () => {
    const router = new SessionRouter(scheme, INITIAL_STATE, deps().d)
    const done = [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]
    expect(router.observeTodos(null)).toBe(false)
    expect(router.observeTodos([{ content: 'a', status: 'in_progress' }])).toBe(false)
    expect(router.observeTodos(done)).toBe(true)
    expect(router.observeTodos(done)).toBe(false)
    expect(router.observeTodos([...done, { content: 'c', status: 'completed' }])).toBe(true)
  })

  it('locks a stage over the judge and unlocks again', async () => {
    const { d, judged } = deps({ verdict: verdict('plan') })
    const router = new SessionRouter(scheme, { ...INITIAL_STATE, scheme: scheme.id, stage: 'code', route: flash, notices: 1 }, d)
    expect(router.setLock('review')).toEqual({ planMode: undefined })
    await router.onUserMessage(turn('m1'))
    expect(router.stage).toBe('review')
    expect(judged).toEqual([])
    await router.resolveRoute()
    expect(router.takeNotice()!.source).toMatchObject({ lock: 'review', reason: 'locked' })
    router.setLock(null)
    await router.onUserMessage(turn('m2'))
    expect(router.stage).toBe('plan')
    expect(() => router.setLock('nope')).toThrow()
  })

  it('falls back to the initial stage model, then the picker default', async () => {
    const plan = { ...INITIAL_STATE, scheme: scheme.id, stage: 'plan', notices: 1 }
    const a = deps({ unusable: ['deepseek-v4-pro'] })
    const router = new SessionRouter(scheme, plan, a.d)
    expect(await router.resolveRoute()).toEqual(flash)
    expect(a.logs.some(line => line.startsWith('error:'))).toBe(true)
    const fallback = { provider: 'other', model: 'x' }
    const b = new SessionRouter(scheme, plan, deps({ unusable: ['deepseek-v4-pro', 'deepseek-flash'], fallback }).d)
    expect(await b.resolveRoute()).toEqual(fallback)
  })
})

describe('SessionRouter tiers', () => {
  const tiered = parseConfig({
    schemes: [{
      ...EXAMPLE_SCHEME,
      stages: EXAMPLE_SCHEME.stages.map(s => s.id !== 'code' ? s : {
        ...s,
        tiers: {
          source: 'planner-then-judge',
          default: 'heavy',
          levels: [
            { id: 'light', description: 'local change', route: { provider: 'p', model: 'light' } },
            { id: 'heavy', description: 'cross-module', route: { provider: 'p', model: 'heavy', reasoningEffort: 'max' } },
          ],
        },
      }),
    }],
  }).schemes[0]!
  const atCode = { ...INITIAL_STATE, scheme: tiered.id, stage: 'code', route: flash, notices: 1 }

  it('routes to the heaviest in-progress tier and announces it', async () => {
    const classified: string[] = []
    const tiers: RouterDeps['tiers'] = {
      classify: (_stage, texts) => { classified.push(...texts) },
      lookup: (_stage, text) => text.includes('big') ? Promise.resolve('heavy') : undefined,
    }
    const router = new SessionRouter(tiered, atCode, deps({ tiers }).d)
    const todos = [{ content: '[T1][light] tweak', status: 'in_progress' }, { content: 'big rewrite', status: 'pending' }]
    router.classifyTodos(todos)
    expect(classified).toEqual(['[T1][light] tweak', 'big rewrite'])
    expect(await router.resolveRoute(todos)).toEqual({ provider: 'p', model: 'light' })
    expect(router.takeNotice()!.source).toMatchObject({ stage: 'code', tier: 'light' })
    todos[1]!.status = 'in_progress'
    expect(await router.resolveRoute(todos)).toEqual({ provider: 'p', model: 'heavy', reasoningEffort: 'max' })
    expect(router.takeNotice()!.source).toMatchObject({ tier: 'heavy' })
  })

  it('uses the stage route when nothing is in progress', async () => {
    const router = new SessionRouter(tiered, atCode, deps().d)
    expect(await router.resolveRoute([{ content: 'x', status: 'completed' }])).toEqual(flash)
    expect(router.tier).toBeUndefined()
  })

  it('falls back from an unusable tier model to the stage model', async () => {
    const router = new SessionRouter(tiered, atCode, deps({ unusable: ['heavy'] }).d)
    expect(await router.resolveRoute([{ content: 'unjudged', status: 'in_progress' }])).toEqual(flash)
  })
})

describe('SessionRouter.describe', () => {
  it('summarises stage, model and lock for /stage', async () => {
    const router = new SessionRouter(scheme, { ...INITIAL_STATE, scheme: scheme.id, stage: 'code', route: flash, notices: 1 }, deps().d)
    expect(router.describe()).toBe('stage code (编码) · model deepseek-official/deepseek-flash · automatic. Stages: plan, code, review.')
    router.setLock('review')
    expect(router.describe()).toContain('locked to review')
  })
})
