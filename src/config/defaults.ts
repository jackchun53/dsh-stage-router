import type { SchemeConfig } from './schema.js'

/** Example scheme shipped in the bundle layer (`cordis.patch.yml`). */
export const EXAMPLE_SCHEME: SchemeConfig = {
  id: 'dev-default',
  name: '研发默认',
  initialStage: 'code',
  subagents: { enabled: false, stage: 'inherit', classify: true },
  stages: [
    {
      id: 'plan',
      name: '规划',
      description: '讨论方案、做设计或规划实现步骤，尚未要求动手写代码',
      route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      prompt: '当前处于规划阶段：先澄清需求，再把实现拆成编号任务，形如 [T1][light] …，不要直接改代码。',
      planMode: 'enter',
    },
    {
      id: 'code',
      name: '编码',
      description: '编写、修改、调试代码',
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      planMode: 'exit',
      tiers: {
        source: 'planner-then-judge',
        default: 'heavy',
        levels: [
          { id: 'light', description: '局部改动、步骤明确', route: { provider: 'deepseek-official', model: 'deepseek-flash' } },
          { id: 'heavy', description: '跨模块、需要设计取舍', route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } },
        ],
      },
    },
    {
      id: 'review',
      name: '审查',
      description: '审查已完成的改动，找出缺陷和遗漏',
      route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      prompt: '当前处于审查阶段：逐项核对刚完成的改动，指出缺陷、遗漏的测试和风险，不要扩大改动范围。',
      planMode: 'keep',
    },
  ],
  transitions: [
    { from: '*', to: 'plan', on: 'plan_mode_on' },
    { from: 'plan', to: 'code', on: 'plan_approved' },
    { from: 'code', to: 'review', on: 'todos_done' },
    { from: '*', to: '*', on: 'user_message' },
  ],
}
