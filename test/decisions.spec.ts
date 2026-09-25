import { describe, expect, it } from 'vitest'
import { DecisionLog, type Decision } from '../src/engine/decisions.js'

const decision = (step: number): Decision => ({
  at: step, turn: 1, step, stage: 'code', tier: null, route: { provider: 'p', model: 'm' }, reason: 'r', lock: null, judge: null,
})

describe('DecisionLog', () => {
  it('keeps the newest decisions per session', () => {
    const log = new DecisionLog(3)
    for (let step = 1; step <= 5; step++) log.record('s1', decision(step))
    log.record('s2', decision(9))
    expect(log.recent('s1').map(d => d.step)).toEqual([3, 4, 5])
    expect(log.recent('s1', 2).map(d => d.step)).toEqual([4, 5])
    expect(log.recent('s2')).toHaveLength(1)
    expect(log.recent('none')).toEqual([])
  })

  it('bounds the number of sessions and can forget one', () => {
    const log = new DecisionLog(5, 2)
    for (const id of ['a', 'b', 'c']) log.record(id, decision(1))
    expect(log.recent('a')).toEqual([])
    log.forget('c')
    expect(log.recent('c')).toEqual([])
    expect(log.recent('b')).toHaveLength(1)
  })
})
