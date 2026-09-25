// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_STATE } from '../../src/engine/state.js'
import { zh } from '../../src/client/locales.js'
import { StageChip, chipLabel } from '../../src/client/StageChip.js'
import { TurnTail, changedTurn } from '../../src/client/TurnTail.js'
import type { StageRouterState } from '../../src/shared/wire.js'

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

function chipProps(state: StageRouterState | undefined, runStage = vi.fn<RunStage>(async () => null)): ChipProps {
  return { useProjection: () => state, runStage, t } as unknown as ChipProps
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
    expect(screen.getByRole('button').textContent).toBe('编码 · heavy · deepseek-v4-pro@high')
  })

  it('opens a panel with the last judgement and locks a stage via /stage', async () => {
    const runStage = vi.fn<RunStage>(async () => null)
    render(<StageChip {...chipProps(routed, runStage)} />)
    fireEvent.click(screen.getByRole('button'))
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('code，置信度 0.82')
    expect(panel.textContent).toContain('judge: writes code')
    fireEvent.click(screen.getByRole('button', { name: '审查' }))
    expect(runStage).toHaveBeenCalledWith('review')
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers unlock when locked and shows a failed action', async () => {
    const runStage = vi.fn<RunStage>(async () => 'Unknown stage')
    render(<StageChip {...chipProps({ ...routed, lock: 'code' }, runStage)} />)
    expect(screen.getByRole('button').textContent).toContain('已锁定')
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button', { name: '恢复自动' }))
    expect(runStage).toHaveBeenCalledWith('auto')
    await screen.findByText('操作失败：Unknown stage')
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
