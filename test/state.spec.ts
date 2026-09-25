import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { INITIAL_STATE, foldStageState, parseStageCommand, persistedScheme, stageNotice, stageProjection, stateSchema, type StageRouterState } from '../src/engine/state.js'

const route = { provider: 'fake', model: 'real-code' }

function notice(stage: string, extra: Partial<Parameters<typeof stageNotice>[0]> = {}) {
  return stageNotice({ stageName: stage, scheme: 'dev', stage, from: null, route, reason: 'test', lock: null, ...extra })
}

const asEvent = (data: unknown, type = 'user/message') => ({ type, data })

function fold(events: { type: string; data?: unknown }[]): StageRouterState {
  return events.reduce(foldStageState, INITIAL_STATE)
}

describe('stageNotice', () => {
  it('builds a user-role notice whose source carries the routing facts', () => {
    const message = notice('review', { from: 'code', route: { ...route, reasoningEffort: 'high' } })
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'stage-router', form: 'notice', stage: 'review', from: 'code' })
    expect((message.source as { summary: string }).summary).toBe('code → review · fake/real-code@high')
    expect(message.content[0]).toMatchObject({ type: 'text' })
  })
})

describe('foldStageState', () => {
  it('rebuilds stage, lock and last judgement from notices', () => {
    const judge = { ok: true, stage: 'review', confidence: 0.8, reason: 'r', elapsedMs: 12 }
    const state = fold([
      asEvent(notice('code')),
      asEvent(notice('review', { from: 'code', judge })),
      asEvent(notice('plan', { from: 'review', lock: 'plan', reason: '已锁定' })),
    ])
    expect(state).toEqual({
      ...INITIAL_STATE, scheme: 'dev', stage: 'plan', stageName: 'plan', lock: 'plan', route, reason: '已锁定', notices: 3,
    })
  })

  it('keeps the latest judgement', () => {
    const judge = { ok: false, error: 'timeout', elapsedMs: 6000 }
    expect(fold([asEvent(notice('code', { judge }))]).judge).toEqual(judge)
  })

  it('ignores unrelated messages and events', () => {
    const user = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const before = fold([asEvent(notice('code'))])
    const after = [asEvent(user), asEvent({ source: { kind: 'model-selection' } }), { type: 'todo/write', data: {} }, asEvent(notice('x'), 'turn/start')]
      .reduce(foldStageState, before)
    expect(after).toBe(before)
  })
})

describe('stageProjection', () => {
  it('starts empty and its wire view passes the view schema', () => {
    const state = fold([asEvent(notice('code', { judge: { ok: true, stage: 'code', confidence: 1, elapsedMs: 3 } }))])
    expect(stageProjection.init(undefined as never, 0 as never)).toEqual(INITIAL_STATE)
    expect(stateSchema.parse(INITIAL_STATE)).toEqual(INITIAL_STATE)
    const view = stageProjection.wire.view(state)
    expect(stageProjection.wire.viewSchema.parse(view)).toEqual(view)
  })

  it('survives a JSON round trip, as the projection cache stores it', () => {
    const state = fold([asEvent(notice('code'))])
    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })
})

describe('explicit model picks', () => {
  const pick = (provider: string, model: string) => ({ type: 'model/selection', data: { provider, model } })

  it('detaches on a real-model pick and re-attaches on a scheme pick or notice', () => {
    const routed = fold([asEvent(notice('code'))])
    expect(persistedScheme(routed)).toBe('dev')
    const detached = foldStageState(routed, pick('deepseek-official', 'deepseek-flash'))
    expect(persistedScheme(detached)).toBeNull()
    expect(detached.stage).toBe('code')
    expect(persistedScheme(foldStageState(detached, pick('stage-router', 'other')))).toBe('other')
    expect(persistedScheme(foldStageState(detached, asEvent(notice('review'))))).toBe('dev')
  })

  it('records a scheme pick before any notice', () => {
    expect(persistedScheme(foldStageState(INITIAL_STATE, pick('stage-router', 'dev')))).toBe('dev')
  })
})

describe('tier facts', () => {
  it('folds the tier and names it in the notice', () => {
    const message = notice('code', { tier: 'heavy', from: 'code' })
    expect((message.source as { summary: string }).summary).toBe('code · heavy · fake/real-code')
    expect(fold([asEvent(message)]).tier).toBe('heavy')
    expect(fold([asEvent(message), asEvent(notice('review'))]).tier).toBeNull()
  })
})

describe('/stage command lifecycle', () => {
  const run = (commandId: string, args: string, name = 'stage') => ({ type: 'command/run', data: { commandId, name, args, source: { kind: 'user' } } })
  const done = (commandId: string, kind = 'success') => ({ type: 'command/done', data: { commandId, kind } })

  it('parses /stage arguments', () => {
    expect(parseStageCommand('')).toEqual({ kind: 'status' })
    expect(parseStageCommand(' status ')).toEqual({ kind: 'status' })
    expect(parseStageCommand('log')).toEqual({ kind: 'log' })
    expect(parseStageCommand(' auto')).toEqual({ kind: 'lock', stage: null })
    expect(parseStageCommand(' review ')).toEqual({ kind: 'lock', stage: 'review' })
    expect(parseStageCommand('tier T2 light')).toEqual({ kind: 'tier', task: 2, tier: 'light' })
    expect(parseStageCommand('tier 3 auto')).toEqual({ kind: 'tier', task: 3, tier: null })
    expect(parseStageCommand('tier T2')).toMatchObject({ kind: 'invalid' })
    expect(parseStageCommand('review now')).toMatchObject({ kind: 'invalid' })
  })

  it('pins and releases task tiers', () => {
    const pinned = [run('c1', 'tier T2 light'), done('c1'), run('c2', 'tier T3 heavy'), done('c2')].reduce(foldStageState, INITIAL_STATE)
    expect(pinned.tierOverrides).toEqual({ 2: 'light', 3: 'heavy' })
    expect([run('c3', 'tier T2 auto'), done('c3')].reduce(foldStageState, pinned).tierOverrides).toEqual({ 3: 'heavy' })
  })

  it('locks only when the command succeeds', () => {
    const base = fold([asEvent(notice('code'))])
    expect(fold([asEvent(notice('code')), run('c1', ' review'), done('c1')]).lock).toBe('review')
    expect([run('c2', ' nope'), done('c2', 'error')].reduce(foldStageState, base).lock).toBeNull()
    expect([run('c3', ' review'), run('x', 'y', 'plan'), done('c3')].reduce(foldStageState, base).lock).toBe('review')
  })

  it('unlocks with auto and ignores status queries', () => {
    const locked = [run('c1', 'review'), done('c1')].reduce(foldStageState, INITIAL_STATE)
    expect([run('c2', ''), done('c2')].reduce(foldStageState, locked).lock).toBe('review')
    expect([run('c3', 'auto'), done('c3')].reduce(foldStageState, locked).lock).toBeNull()
  })
})

describe('turn records and stage names', () => {
  const turnStart = (turn: number) => ({ type: 'turn/start', data: { turn } })

  it('records where each turn started and ended', () => {
    const review = { provider: 'fake', model: 'm-review', reasoningEffort: 'high' }
    const state = fold([
      turnStart(1), asEvent(notice('code', { stageName: 'Code' })),
      turnStart(2),
      turnStart(3), asEvent(notice('review', { from: 'code', route: review, stageName: 'Review' })),
    ])
    expect(state.turns).toEqual([
      { turn: 1, fromStage: null, fromModel: null, toStage: 'code', toModel: 'real-code' },
      { turn: 2, fromStage: 'code', fromModel: 'real-code', toStage: 'code', toModel: 'real-code' },
      { turn: 3, fromStage: 'code', fromModel: 'real-code', toStage: 'review', toModel: 'm-review@high' },
    ])
    expect(state.stageName).toBe('Review')
  })

  it('keeps only the latest turns', () => {
    const state = fold(Array.from({ length: 30 }, (_, i) => turnStart(i + 1)))
    expect(state.turns).toHaveLength(20)
    expect(state.turns[0]!.turn).toBe(11)
  })

  it('keeps the stage list from the latest notice that carries one', () => {
    const stages = [{ id: 'code', name: 'Code' }, { id: 'review', name: 'Review' }]
    const state = fold([asEvent(notice('code', { stages })), asEvent(notice('review'))])
    expect(state.stages).toEqual(stages)
  })
})
