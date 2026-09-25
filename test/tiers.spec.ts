import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_JUDGE, parseConfig, type StageConfig, type TierSource } from '../src/config/schema.js'
import {
  TIER_BATCH_LIMIT, TierClassifier, heaviest, parseTierReply, pickTier, plannerTag, renderTierPrompt, taskTier,
} from '../src/engine/tiers.js'
import type { StreamFn } from '../src/engine/judge.js'

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

async function* reply(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** A stream that answers each batch by mapping task lines through `answer`. */
function tierStream(answer: (task: string) => string, delayMs = 0) {
  const calls: GenerateOptions[] = []
  const stream: StreamFn = options => {
    calls.push(options)
    const prompt = (options.messages[0]!.content[0] as { text: string }).text
    const tasks = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map(match => match[1]!)
    return (async function* () {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      yield* reply(JSON.stringify({ tiers: tasks.map(answer) }))
    })()
  }
  return { stream, calls }
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

describe('tier prompt and reply', () => {
  const tiers = stage().tiers!

  it('lists tiers lightest first and numbers the tasks', () => {
    const prompt = renderTierPrompt(tiers, ['a', 'b'])
    expect(prompt).toContain('- light: light work\n- medium: medium work\n- heavy: heavy work')
    expect(prompt).toContain('1. a\n2. b')
  })

  it('accepts an array or a numbered object and drops unknown tiers', () => {
    expect(parseTierReply('```json\n{"tiers": ["heavy", "nope"]}\n```', 3, tiers)).toEqual(['heavy', undefined, undefined])
    expect(parseTierReply('{"1": "light", "2": " medium "}', 2, tiers)).toEqual(['light', 'medium'])
    expect(parseTierReply('no json', 2, tiers)).toEqual([undefined, undefined])
  })
})

describe('TierClassifier', () => {
  it('judges each text once, in batches of at most 30', async () => {
    const { stream, calls } = tierStream(() => 'light')
    const classifier = new TierClassifier(stream, noop)
    const s = stage()
    const texts = Array.from({ length: TIER_BATCH_LIMIT + 5 }, (_, i) => `task ${i}`)
    classifier.classify(s, texts, DEFAULT_JUDGE)
    classifier.classify(s, texts, DEFAULT_JUDGE)
    expect(calls).toHaveLength(2)
    expect(await classifier.lookup(s, 'task 34')).toBe('light')
    expect(calls[0]).not.toHaveProperty('sessionId')
  })

  it('resolves to undefined when the judge fails', async () => {
    const stream: StreamFn = () => { throw new Error('down') }
    const classifier = new TierClassifier(stream, noop)
    const s = stage()
    classifier.classify(s, ['x'], DEFAULT_JUDGE)
    expect(await classifier.lookup(s, 'x')).toBeUndefined()
  })

  it('does nothing for a stage without tiers', () => {
    const { stream, calls } = tierStream(() => 'light')
    const plain = parseConfig({ schemes: [{ id: 's', initialStage: 'a', stages: [{ id: 'a', route }] }] }).schemes[0]!.stages[0]!
    new TierClassifier(stream, noop).classify(plain, ['x'], DEFAULT_JUDGE)
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
    classifier.classify(s, todos.map(t => t.content), DEFAULT_JUDGE)
    expect(await pickTier(s, todos, classifier)).toEqual({ tier: 'heavy', reason: 'judge' })
    expect(await pickTier(s, [todos[0]!], classifier)).toEqual({ tier: 'light', reason: 'planner' })
  })

  it('ignores planner tags when the source is judge, and the judge when it is planner', async () => {
    const classifier = new TierClassifier(tierStream(() => 'light').stream, noop)
    const judgeOnly = stage('judge')
    classifier.classify(judgeOnly, ['[T1][heavy] x'], DEFAULT_JUDGE)
    expect(await pickTier(judgeOnly, [doing('[T1][heavy] x')], classifier)).toEqual({ tier: 'light', reason: 'judge' })
    const plannerOnly = stage('planner')
    classifier.classify(plannerOnly, ['untagged'], DEFAULT_JUDGE)
    expect(await pickTier(plannerOnly, [doing('untagged')], classifier)).toEqual({ tier: 'medium', reason: 'default' })
  })

  it('waits at most the budget for a slow judge, then uses the default tier', async () => {
    const s = stage()
    const classifier = new TierClassifier(tierStream(() => 'heavy', 200).stream, noop)
    classifier.classify(s, ['slow one'], DEFAULT_JUDGE)
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
