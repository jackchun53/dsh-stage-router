/** `stage-router` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.aria': '阶段路由：{label}，点击查看详情',
  'chip.locked': '已锁定',
  'panel.title': '阶段路由',
  'panel.stage': '当前阶段',
  'panel.model': '模型',
  'panel.tier': '档位',
  'panel.reason': '原因',
  'panel.judge': '最近一次判断',
  'panel.judge.ok': '{stage}，置信度 {confidence}',
  'panel.judge.failed': '判断失败：{error}',
  'panel.judge.none': '本轮没有调用判断器',
  'panel.lock': '锁定到',
  'panel.unlock': '恢复自动',
  'panel.busy': '执行中…',
  'panel.failed': '操作失败：{error}',
  'turn.changed': '本轮：{from} → {to}（{fromModel} → {toModel}）',
  'turn.modelOnly': '本轮：{to}（{fromModel} → {toModel}）',
  'turn.first': '本轮：{to}（{toModel}）',
} satisfies Record<string, string>

export type StageRouterKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.aria': 'Stage router: {label}. Click for details',
  'chip.locked': 'locked',
  'panel.title': 'Stage router',
  'panel.stage': 'Stage',
  'panel.model': 'Model',
  'panel.tier': 'Tier',
  'panel.reason': 'Reason',
  'panel.judge': 'Last judgement',
  'panel.judge.ok': '{stage}, confidence {confidence}',
  'panel.judge.failed': 'Judge failed: {error}',
  'panel.judge.none': 'No judge call for this decision',
  'panel.lock': 'Lock to',
  'panel.unlock': 'Automatic',
  'panel.busy': 'Working…',
  'panel.failed': 'Failed: {error}',
  'turn.changed': 'This turn: {from} → {to} ({fromModel} → {toModel})',
  'turn.modelOnly': 'This turn: {to} ({fromModel} → {toModel})',
  'turn.first': 'This turn: {to} ({toModel})',
} satisfies Record<StageRouterKey, string>
