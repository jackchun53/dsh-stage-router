import { describe, expect, it } from 'vitest'
import { JudgeLog, logText, type TierJudgeLog } from '../src/engine/judge-log.js'

const entry = (at: number): TierJudgeLog => ({ kind: 'tier', at, elapsedMs: 1, stage: 's', ok: true, tasks: [] })

describe('JudgeLog', () => {
  it('keeps the newest entries per session and forgets old sessions', () => {
    const log = new JudgeLog(3, 2)
    for (let i = 0; i < 5; i++) log.record('a', entry(i))
    expect(log.recent('a').map(e => e.at)).toEqual([2, 3, 4])
    expect(log.recent('a', 1).map(e => e.at)).toEqual([4])
    log.record('b', entry(0))
    log.record('c', entry(0))
    expect(log.recent('a')).toEqual([])
    log.forget('b')
    expect(log.recent('b')).toEqual([])
  })

  it('flattens and clips logged text', () => {
    expect(logText('  a\n  b ')).toBe('a b')
    expect(logText('x'.repeat(200))).toHaveLength(121)
  })
})
