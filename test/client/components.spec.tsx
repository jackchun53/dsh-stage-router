// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_STATE } from '../../src/engine/state.js'
import { zh } from '../../src/client/locales.js'
import { StageChip, chipLabel } from '../../src/client/StageChip.js'
import { TurnTail, changedTurn } from '../../src/client/TurnTail.js'
import type { JudgeLogEntry, StageRouterState } from '../../src/shared/wire.js'

afterEach(cleanup)

const t = (key: string, params: Record<string, unknown> = {}) =>
  (zh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

const routed: StageRouterState = {
  ...INITIAL_STATE,
  scheme: 'dev',
  stage: 'code',
  stageName: '编码',
  stages: [{ id: 'plan', name: '规划' }, { id: 'code', name: '编码' }, { id: 'review', name: '审查' }],
  tier: 'heavy',
  route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  reason: 'judge: writes code',
  judge: { ok: true, stage: 'code', confidence: 0.82, reason: 'writes code', elapsedMs: 120 },
  notices: 3,
}

type RunStage = (args: string) => Promise<string | null>
type ChipProps = Parameters<typeof StageChip>[0]
type TailProps = Parameters<typeof TurnTail>[0]

const log: JudgeLogEntry[] = [
  {
    kind: 'stage', at: Date.now() - 120_000, elapsedMs: 310, message: '先把接口定下来', from: 'code', candidates: ['plan', 'code', 'review'],
    ok: true, choice: 'plan', confidence: 0.45, probabilities: { plan: 0.45, code: 0.4, review: 0.15 }, to: 'code', reason: 'Jev 置信度 45% 低于 60%',
  },
  { kind: 'tier', at: Date.now() - 60_000, elapsedMs: 200, stage: 'code', ok: true, tasks: [{ text: '[T1] small fix', tier: 'light', confidence: 0.9 }] },
  {
    kind: 'stage', at: Date.now(), elapsedMs: 280, message: '写实现', from: 'code', candidates: ['plan', 'code', 'review'],
    ok: true, choice: 'review', confidence: 0.82, probabilities: { plan: 0.08, code: 0.1, review: 0.82 }, to: 'review', reason: 'Jev 判断（置信度 82%）',
  },
  { kind: 'stage', at: Date.now(), elapsedMs: 3000, message: '超时的那条', from: 'review', candidates: ['plan', 'code'], ok: false, error: 'Jev 超时（3000 毫秒）', to: 'review', reason: '判断失败' },
]

function chipProps(state: StageRouterState | undefined, runStage = vi.fn<RunStage>(async () => null), judgeLog = vi.fn(async () => log)): ChipProps {
  return { useProjection: () => state, runStage, judgeLog, t } as unknown as ChipProps
}

describe('StageChip', () => {
  it('renders nothing for sessions not routed by stage-router', () => {
    const { container } = render(<StageChip {...chipProps(undefined)} />)
    expect(container.innerHTML).toBe('')
    render(<StageChip {...chipProps({ ...routed, detached: true })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows stage, tier and model', () => {
    expect(chipLabel(routed)).toBe('编码 · heavy · deepseek-v4-pro@high')
    render(<StageChip {...chipProps(routed)} />)
    const chip = screen.getByRole('button')
    expect(chip.textContent).toBe('编码heavy · deepseek-v4-pro@high')
    expect(chip.getAttribute('aria-label')).toBe('阶段路由：编码 · heavy · deepseek-v4-pro@high，点击查看详情')
  })

  it('opens a panel with the reason and locks a stage via /stage', async () => {
    const runStage = vi.fn<RunStage>(async () => null)
    render(<StageChip {...chipProps(routed, runStage)} />)
    fireEvent.click(screen.getByRole('button'))
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('judge: writes code')
    expect(panel.textContent).toContain('deepseek-official/deepseek-v4-pro@high')
    fireEvent.click(screen.getByRole('button', { name: '审查' }))
    expect(runStage).toHaveBeenCalledWith('review')
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers unlock when locked and shows a failed action', async () => {
    const runStage = vi.fn<RunStage>(async () => 'Unknown stage')
    render(<StageChip {...chipProps({ ...routed, lock: 'code' }, runStage)} />)
    expect(screen.getByLabelText('已锁定')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: '恢复自动' }))
    expect(runStage).toHaveBeenCalledWith('auto')
    await screen.findByText('操作失败：Unknown stage')
  })
})

describe('judge log', () => {
  it('lists the session judgements newest first and expands one to its probabilities', async () => {
    const judgeLog = vi.fn(async () => log)
    render(<StageChip {...chipProps(routed, undefined, judgeLog)} />)
    fireEvent.click(screen.getByRole('button'))
    const section = await screen.findByRole('region', { name: '判断日志' })
    const items = await within(section).findAllByRole('button', { expanded: false })
    expect(items.map(item => item.textContent)).toEqual([
      '刚刚判断失败3000 ms超时的那条',
      '刚刚→ 审查82% · 280 ms写实现',
      '1 分钟前定档 T1→light200 ms编码',
      '2 分钟前留在 编码45% · 310 ms先把接口定下来',
    ])
    fireEvent.click(items[3]!)
    expect(within(section).getAllByRole('meter').map(m => m.getAttribute('aria-label'))).toEqual(['规划', '编码', '审查'])
    expect(within(section).getByText('Jev 置信度 45% 低于 60%')).toBeTruthy()
    fireEvent.click(items[0]!)
    expect(within(section).getByText('Jev 超时（3000 毫秒）')).toBeTruthy()
    expect(judgeLog).toHaveBeenCalledTimes(1)
    fireEvent.click(within(section).getByRole('button', { name: '刷新' }))
    await vi.waitFor(() => expect(judgeLog).toHaveBeenCalledTimes(2))
  })

  it('shows an empty log and a failed read', async () => {
    const { unmount } = render(<StageChip {...chipProps(routed, undefined, vi.fn(async () => []))} />)
    fireEvent.click(screen.getByRole('button'))
    await screen.findByText('本会话还没有判断记录')
    unmount()
    render(<StageChip {...chipProps(routed, undefined, vi.fn(async () => { throw new Error('offline') }))} />)
    fireEvent.click(screen.getByRole('button'))
    await screen.findByText('读取判断日志失败：offline')
  })
})

describe('TurnTail', () => {
  const withTurns: StageRouterState = {
    ...routed,
    turns: [
      { turn: 1, fromStage: null, fromModel: null, toStage: 'plan', toModel: 'deepseek-v4-pro@max' },
      { turn: 2, fromStage: 'plan', fromModel: 'deepseek-v4-pro@max', toStage: 'code', toModel: 'deepseek-flash' },
      { turn: 3, fromStage: 'code', fromModel: 'deepseek-flash', toStage: 'code', toModel: 'deepseek-flash' },
      { turn: 4, fromStage: 'code', fromModel: 'deepseek-flash', toStage: 'code', toModel: 'deepseek-v4-pro@high' },
    ],
  }
  const tail = (turn: number) => render(<TurnTail {...({ useProjection: () => withTurns, turn: { turn }, t } as unknown as TailProps)} />)

  it('summarises a stage change', () => {
    tail(2)
    expect(screen.getByText('本轮：规划 → 编码（deepseek-v4-pro@max → deepseek-flash）')).toBeTruthy()
  })

  it('summarises a model-only change (tier) and stays silent otherwise', () => {
    tail(4)
    expect(screen.getByText('本轮：编码（deepseek-flash → deepseek-v4-pro@high）')).toBeTruthy()
    expect(changedTurn(withTurns, 3)).toBeUndefined()
    expect(changedTurn(withTurns, 9)).toBeUndefined()
    expect(changedTurn(withTurns, 1)).toBeDefined()
  })

  it('names only the destination on the first routed turn', () => {
    tail(1)
    expect(screen.getByText('本轮：规划（deepseek-v4-pro@max）')).toBeTruthy()
  })
})
