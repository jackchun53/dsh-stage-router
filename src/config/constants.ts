/** Config vocabulary shared with the Web client (no schemastery import). */

export const TIER_SOURCES = ['planner', 'judge', 'planner-then-judge'] as const

export const PLAN_MODE_ACTIONS = ['enter', 'exit', 'keep'] as const

export const TRANSITION_EVENTS = ['user_message', 'plan_mode_on', 'plan_mode_off', 'plan_approved', 'todos_done'] as const

/** Wildcard stage reference in transitions. */
export const ANY_STAGE = '*'

/** Chinese labels for transition events, shown in reasons and the editor. */
export const EVENT_LABELS: Record<(typeof TRANSITION_EVENTS)[number], string> = {
  user_message: '用户消息',
  plan_mode_on: '开启计划模式',
  plan_mode_off: '关闭计划模式',
  plan_approved: '计划被批准',
  todos_done: '待办全部完成',
}
