/** Config vocabulary shared with the Web client (no schemastery import). */

export const TIER_SOURCES = ['planner', 'judge', 'planner-then-judge'] as const

export const PLAN_MODE_ACTIONS = ['enter', 'exit', 'keep'] as const

export const TRANSITION_EVENTS = ['user_message', 'plan_mode_on', 'plan_mode_off', 'plan_approved', 'todos_done'] as const

/** Wildcard stage reference in transitions. */
export const ANY_STAGE = '*'
