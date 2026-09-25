import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { INITIAL_STATE, foldStageState, persistedScheme, stageNotice, stageProjection, stateSchema, type StageRouterState } from '../src/engine/state.js'

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
      asEvent(notice('plan', { from: 'review', lock: 'plan', reason: 'locked' })),
    ])
    expect(state).toEqual({
      scheme: 'dev', stage: 'plan', lock: 'plan', route, reason: 'locked', judge: null, detached: false, notices: 3,
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
