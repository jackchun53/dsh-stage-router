import { describe, expect, it } from 'vitest'
import { parseConfig, type StageConfig, type TierSource } from '../src/config/schema.js'
import type { FetchFn } from '../src/engine/jev.js'
import type { TierJudgeLog } from '../src/engine/judge-log.js'
import {
  TIER_BATCH_LIMIT, TierClassifier, heaviest, pickTier, plannerTag, taskTier, tierQuestions,
} from '../src/engine/tiers.js'
import { fakeJev, jev } from './helpers/fake-jev.js'

const route = { provider: 'p', model: 'm' }

function stage(source: TierSource = 'planner-then-judge', levels = ['light', 'medium', 'heavy'], tierDefault = 'medium'): StageConfig {
  return parseConfig({
    schemes: [{
      id: 's',
      initialStage: 'code',
      stages: [{
        id: 'code',
        route,
        tiers: { source, default: tierDefault, levels: levels.map(id => ({ id, description: `${id} work`, route: { provider: 'p', model: id } })) },
      }],
    }],
  }).schemes[0]!.stages[0]!
}

/** A fake Jev that answers each task question by mapping the task text through `answer`. */
function tierJev(answer: (task: string) => string, delayMs = 0) {
  return fakeJev(async body => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    const tasks = body.state.tasks as { key: string; text: string }[]
    return { answers: Object.fromEntries(tasks.map(task => [task.key, { type: 'choice', choice: answer(task.text), probabilities: { [answer(task.text)]: 0.8 } }])) }
  })
}
const tierStream = (answer: (task: string) => string, delayMs = 0) => {
  const { fetch, calls } = tierJev(answer, delayMs)
  return { stream: fetch, calls }
}

const noop = () => {}
const doing = (content: string) => ({ content, status: 'in_progress' })

describe('plannerTag', () => {
  it('reads task numbers and tiers', () => {
    expect(plannerTag('[T3][heavy] refactor the loader')).toEqual({ task: 3, tier: 'heavy' })
    expect(plannerTag('  [t12] [light] fix typo')).toEqual({ task: 12, tier: 'light' })
    expect(plannerTag('[T4] write tests')).toEqual({ task: 4 })
    expect(plannerTag('no tag [T1][heavy]')).toEqual({})
  })
})

describe('heaviest', () => {
  it('ranks by level order and ignores unknown ids', () => {
    const tiers = stage().tiers!
    expect(heaviest(tiers, ['light', 'heavy', 'medium'])).toBe('heavy')
    expect(heaviest(tiers, ['light', 'mega', undefined])).toBe('light')
    expect(heaviest(tiers, [])).toBeUndefined()
  })
})

describe('tierQuestions', () => {
  it('asks one choice per task over the tiers, lightest first', () => {
    const questions = tierQuestions(stage().tiers!, 2)
    expect(Object.keys(questions)).toEqual(['t1', 't2'])
    expect(questions.t2).toMatchObject({ type: 'choice', criteria: { light: 'light work', medium: 'medium work', heavy: 'heavy work' } })
    expect(Object.keys(questions.t1!.criteria)).toEqual(['light', 'medium', 'heavy'])
    expect(questions.t2!.instructions).toContain('t2')
  })
})

describe('TierClassifier', () => {
  it('judges each text once, in batches of at most 30', async () => {
    const { stream, calls } = tierStream(() => 'light')
    const classifier = new TierClassifier(stream, noop)
    const s = stage()
    const texts = Array.from({ length: TIER_BATCH_LIMIT + 5 }, (_, i) => `task ${i}`)
    classifier.classify(s, texts, jev)
    classifier.classify(s, texts, jev)
    expect(calls).toHaveLength(2)
    expect(await classifier.lookup(s, 'task 34')).toBe('light')
    expect((calls[1]!.body.state.tasks as unknown[]).length).toBe(5)
  })

  it('records one judge-log entry per Jev call and drops unknown tiers', async () => {
    const { stream } = tierStream(task => task === 'odd' ? 'mega' : 'heavy')
    const classifier = new TierClassifier(stream, noop)
    const s = stage()
    const entries: TierJudgeLog[] = []
    classifier.classify(s, ['odd', 'big'], jev, entry => entries.push(entry))
    expect(await classifier.lookup(s, 'odd')).toBeUndefined()
    expect(await classifier.lookup(s, 'big')).toBe('heavy')
    expect(entries).toEqual([expect.objectContaining({
      kind: 'tier', stage: 'code', ok: true,
      tasks: [{ text: 'odd', tier: null, confidence: null }, { text: 'big', tier: 'heavy', confidence: 0.8 }],
    })])
  })

  it('resolves to undefined when Jev fails, and logs the failure', async () => {
    const stream: FetchFn = async () => { throw new Error('down') }
    const classifier = new TierClassifier(stream, noop)
    const s = stage()
    const entries: TierJudgeLog[] = []
    classifier.classify(s, ['x'], jev, entry => entries.push(entry))
    expect(await classifier.lookup(s, 'x')).toBeUndefined()
    expect(entries[0]).toMatchObject({ ok: false, error: '无法连接 Jev：down', tasks: [{ text: 'x', tier: null }] })
  })

  it('does nothing for a stage without tiers', () => {
    const { stream, calls } = tierStream(() => 'light')
    const plain = parseConfig({ schemes: [{ id: 's', initialStage: 'a', stages: [{ id: 'a', route }] }] }).schemes[0]!.stages[0]!
    new TierClassifier(stream, noop).classify(plain, ['x'], jev)
    expect(calls).toHaveLength(0)
  })
})

describe('pickTier', () => {
  it('uses the stage route when nothing is in progress', async () => {
    const classifier = new TierClassifier(tierStream(() => 'heavy').stream, noop)
    expect(await pickTier(stage(), [{ content: 'a', status: 'pending' }], classifier)).toBeUndefined()
    expect(await pickTier(stage(), null, classifier)).toBeUndefined()
  })

  it('takes the heaviest in-progress todo, planner tags first', async () => {
    const s = stage()
    const classifier = new TierClassifier(tierStream(task => task.includes('big') ? 'heavy' : 'light').stream, noop)
    const todos = [doing('[T1][light] small fix'), doing('big redesign'), { content: '[T3][heavy] later', status: 'pending' }]
    classifier.classify(s, todos.map(t => t.content), jev)
    expect(await pickTier(s, todos, classifier)).toEqual({ tier: 'heavy', reason: 'judge' })
    expect(await pickTier(s, [todos[0]!], classifier)).toEqual({ tier: 'light', reason: 'planner' })
  })

  it('ignores planner tags when the source is judge, and the judge when it is planner', async () => {
    const classifier = new TierClassifier(tierStream(() => 'light').stream, noop)
    const judgeOnly = stage('judge')
    classifier.classify(judgeOnly, ['[T1][heavy] x'], jev)
    expect(await pickTier(judgeOnly, [doing('[T1][heavy] x')], classifier)).toEqual({ tier: 'light', reason: 'judge' })
    const plannerOnly = stage('planner')
    classifier.classify(plannerOnly, ['untagged'], jev)
    expect(await pickTier(plannerOnly, [doing('untagged')], classifier)).toEqual({ tier: 'medium', reason: 'default' })
  })

  it('waits at most the budget for a slow judge, then uses the default tier', async () => {
    const s = stage()
    const classifier = new TierClassifier(tierStream(() => 'heavy', 200).stream, noop)
    classifier.classify(s, ['slow one'], jev)
    const started = Date.now()
    expect(await pickTier(s, [doing('slow one')], classifier, 30)).toEqual({ tier: 'medium', reason: 'default' })
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('uses the default tier for a todo nobody judged', async () => {
    const classifier = new TierClassifier(tierStream(() => 'heavy').stream, noop)
    expect(await pickTier(stage(), [doing('never classified')], classifier)).toEqual({ tier: 'medium', reason: 'default' })
  })
})

describe('taskTier', () => {
  it('maps a subagent [Tn] prefix to that planner task tier', () => {
    const todos = [{ content: '[T1][light] a', status: 'completed' }, { content: '[T2][heavy] b', status: 'in_progress' }]
    expect(taskTier(stage(), todos, '[T2] implement b')).toBe('heavy')
    expect(taskTier(stage(), todos, '[T9] unknown')).toBeUndefined()
    expect(taskTier(stage(), todos, 'no tag')).toBeUndefined()
  })
})

describe('pickTier overrides', () => {
  it('lets a manual pin win over the planner tag', async () => {
    const classifier = new TierClassifier(tierStream(() => 'light').stream, noop)
    expect(await pickTier(stage(), [doing('[T1][light] tweak')], classifier, 20, { 1: 'heavy' })).toEqual({ tier: 'heavy', reason: 'manual' })
    expect(await pickTier(stage(), [doing('[T1][light] tweak')], classifier, 20, { 1: 'mega' })).toEqual({ tier: 'light', reason: 'planner' })
  })
})
