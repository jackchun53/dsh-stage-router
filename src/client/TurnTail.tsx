import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import './projection.js'
import type { StageRouterState, TurnRecord } from '../shared/wire.js'
import { useStageRouterStyles } from './styles.js'

export type TurnTailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'stage-router'>

/** The record for one turn, when its stage or model changed. */
export function changedTurn(state: StageRouterState | undefined, turn: number): TurnRecord | undefined {
  const record = state?.turns.find(item => item.turn === turn)
  if (record === undefined || record.toStage === null) return undefined
  return record.fromStage === record.toStage && record.fromModel === record.toModel ? undefined : record
}

/** "本轮：规划 → 编码（v4-pro → flash）" under turns where routing changed. */
export function TurnTail({ useProjection, turn, t }: TurnTailProps) {
  useStageRouterStyles()
  const state = useProjection('stage-router')
  const record = changedTurn(state, turn.turn)
  if (record === undefined || state === undefined) return null
  const name = (id: string | null) => id === null ? '—' : state.stages.find(stage => stage.id === id)?.name ?? id
  const params = {
    from: name(record.fromStage),
    to: name(record.toStage),
    fromModel: record.fromModel ?? '—',
    toModel: record.toModel ?? '—',
  }
  const text = record.fromStage === null
    ? t('turn.first', params)
    : record.fromStage === record.toStage ? t('turn.modelOnly', params) : t('turn.changed', params)
  return <div className="sr-turn-tail">{text}</div>
}
