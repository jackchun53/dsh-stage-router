import { describe, expect, it } from 'vitest'
import { parseConfig, type SchemeConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { applyJudgement, candidatesFor, decide, type MachineState } from '../src/engine/transitions.js'

const scheme: SchemeConfig = parseConfig({ schemes: [EXAMPLE_SCHEME] }).schemes[0]!
const at = (stage: string | null, lock: string | null = null): MachineState => ({ stage, lock })

function withRules(transitions: unknown[]): SchemeConfig {
  return parseConfig({ schemes: [{ ...EXAMPLE_SCHEME, transitions }] }).schemes[0]!
}

describe('decide', () => {
  it('sends a user message to the judge with every stage as candidate', () => {
    expect(decide(at('code'), 'user_message', scheme)).toEqual({ kind: 'judge', candidates: ['plan', 'code', 'review'] })
  })

  it('applies event rules by source stage', () => {
    expect(decide(at('code'), 'plan_mode_on', scheme)).toEqual({ kind: 'goto', stage: 'plan', reason: '开启计划模式' })
    expect(decide(at('plan'), 'plan_approved', scheme)).toEqual({ kind: 'goto', stage: 'code', reason: '计划被批准' })
    expect(decide(at('code'), 'todos_done', scheme)).toEqual({ kind: 'goto', stage: 'review', reason: '待办全部完成' })
  })

  it('stays when no rule matches the event from this stage', () => {
    expect(decide(at('review'), 'plan_approved', scheme).kind).toBe('stay')
    expect(decide(at('code'), 'plan_mode_off', scheme).kind).toBe('stay')
  })

  it('stays rather than re-entering the current stage', () => {
    expect(decide(at('plan'), 'plan_mode_on', scheme)).toEqual({ kind: 'stay', reason: '开启计划模式' })
  })

  it('uses the first matching rule for non-message events', () => {
    const s = withRules([
      { from: 'code', to: 'review', on: 'todos_done' },
      { from: '*', to: 'plan', on: 'todos_done' },
    ])
    expect(decide(at('code'), 'todos_done', s)).toMatchObject({ stage: 'review' })
    expect(decide(at('review'), 'todos_done', s)).toMatchObject({ stage: 'plan' })
  })

  it('unions user_message targets and skips the judge for a single candidate', () => {
    const two = withRules([
      { from: 'code', to: 'review', on: 'user_message' },
      { from: '*', to: 'code', on: 'user_message' },
    ])
    expect(decide(at('code'), 'user_message', two)).toEqual({ kind: 'judge', candidates: ['review', 'code'] })
    expect(decide(at('plan'), 'user_message', two)).toEqual({ kind: 'goto', stage: 'code', reason: '规则只剩一个候选阶段' })
  })

  it('enters initialStage on the first message when no rule matches', () => {
    const none = withRules([{ from: 'code', to: 'review', on: 'user_message' }])
    expect(decide(at(null), 'user_message', none)).toEqual({ kind: 'goto', stage: 'code', reason: '会话第一条消息，进入初始阶段' })
    expect(decide(at('plan'), 'user_message', none).kind).toBe('stay')
  })

  it('lets a manual lock win over every event', () => {
    expect(decide(at('code', 'review'), 'user_message', scheme)).toEqual({ kind: 'goto', stage: 'review', reason: '已锁定' })
    expect(decide(at('review', 'review'), 'plan_mode_on', scheme)).toEqual({ kind: 'stay', reason: '已锁定' })
  })

  it('ignores a lock on a stage the scheme no longer has', () => {
    expect(decide(at('code', 'gone'), 'todos_done', scheme)).toMatchObject({ stage: 'review' })
  })

  it('ignores rules that point at unknown stages', () => {
    const s = withRules([{ from: '*', to: 'gone', on: 'user_message' }, { from: '*', to: 'code', on: 'user_message' }])
    expect(candidatesFor(at('plan'), 'user_message', s)).toEqual(['code'])
  })
})

describe('applyJudgement', () => {
  const candidates = ['plan', 'code', 'review']
  const ok = (stage: string, confidence = 0.9) => ({ ok: true as const, stage, confidence, reason: 'r' })

  it('moves to a confident candidate', () => {
    expect(applyJudgement(at('code'), ok('plan'), candidates, 0.6, 'code')).toEqual({ kind: 'goto', stage: 'plan', reason: '判断器：r' })
  })

  it('stays on failure, low confidence or a non-candidate answer', () => {
    expect(applyJudgement(at('code'), { ok: false, error: 'timeout' }, candidates, 0.6, 'code').kind).toBe('stay')
    expect(applyJudgement(at('code'), ok('plan', 0.3), candidates, 0.6, 'code').kind).toBe('stay')
    expect(applyJudgement(at('code'), ok('deploy'), candidates, 0.6, 'code').kind).toBe('stay')
  })

  it('enters initialStage when the first message cannot be judged', () => {
    expect(applyJudgement(at(null), { ok: false, error: 'timeout' }, candidates, 0.6, 'code'))
      .toEqual({ kind: 'goto', stage: 'code', reason: '会话第一条消息，进入初始阶段（判断失败：timeout）' })
  })

  it('stays when the judge picks the current stage', () => {
    expect(applyJudgement(at('code'), ok('code'), candidates, 0.6, 'code').kind).toBe('stay')
  })
})
