# 第 2 期：阶段内分档与子 agent 路由

> 设计：`docs/superpowers/specs/2026-09-25-stage-router-design.md` §3「分档」「子 agent」
> **状态：已完成**。单元测试 94 个、集成测试 13 个全部通过（`pnpm test`）。

## 做了什么

| 任务 | 文件 | 测试 |
|---|---|---|
| 分档纯逻辑：规划者标签、分档判断（每批最多 30 条，按内容哈希缓存）、取进行中待办里最重的一档、最多等 1.5 秒后用默认档、按 `[Tn]` 查任务档位 | `src/engine/tiers.ts` | `test/tiers.spec.ts` |
| 分档接入路由：每次组装时对当前阶段的待办启动判断；解析路由时按「档位 → 阶段 → 初始阶段 → 选择器默认」回退；档位写进提示消息和 `stage-router` 投影 | `src/engine/session-router.ts`、`src/engine/state.ts`、`src/index.ts` | `test/session-router.spec.ts`、`test/state.spec.ts` |
| 子 agent 路由决策 | `src/engine/subagents.ts` | `test/subagents.spec.ts` |
| 子 agent 接线：取出第一条用户消息作为任务，第一次请求时决定并缓存 | `src/index.ts` | 集成测试 |
| 集成测试：两种档位场景、新建和 fork 两种子 agent 场景 | `test/integration/*` | 13 项 |

示例方案（`cordis.patch.yml`、`src/config/defaults.ts`）的编码阶段按设计 §2 加上了 light / heavy 两档。

## 和设计不同的地方（已写回设计 §3、§9）

1. **子 agent 不经过虚拟模型。** 0.1.7 里子 agent 继承父会话**最近一次记录的请求头**（`subagent/subagent/src/child-agent.ts:69-86`）。本插件改写之后，那里记的是真实模型，所以：
   - 子 agent 的 `await next()` 拿到的是真实模型，不能靠 `provider === 'stage-router'` 识别；
   - 改为按会话头 `origin === 'subagent'` 加 `parentSession` 识别；
   - 父会话用 `ctx.agents.get(parentSession)` 找回。
2. **「显式指定」的判断依据。** 子 agent 第一次请求时的模型，和父会话当前路由的 provider/model 不一样，就视为显式指定，不改写。例如 subagent 工具在 `modelSelectionSettings` 开启时可以带 `provider` / `model` 参数。决定在第一次请求时做一次并缓存，否则子 agent 从第二次请求起，自己的请求头就会被误判为显式指定。
3. **fork 的识别。** 会话头 `isSeeded`，或者子会话里 `subagent/descriptor` 事件的 `provider === 'fork'`。父会话还没完成过一轮时 fork 出来，会话头看起来和新建一样，只能靠后者识别。
4. **任务文本。** 取子 agent 第一条用户消息的第一个文字块；continuable 模式在第二个文字块里附加了给父会话发消息的说明，要忽略。`[Tn]` 先在 descriptor 的 `label`（工具的 `description`）里找，再在任务文本里找。
5. **fork 出来的子会话带着父会话的历史**，包括本插件的阶段提示。子 agent 不走本插件的 pre-step 和 assemble 钩子（这两个只注册给根 agent），所以不会重复追加提示；子会话上的 `stage-router` 投影会折叠到父会话的阶段，目前没有用到。

## 尚未覆盖

- 显式指定模型的子 agent 只有单元测试，没有端到端测试：要在 profile 里打开 `modelSelectionSettings`。
- 后台（continuable）子 agent：集成测试用的是前台运行（`run_in_background:false`），因为无界面模式下 `whenIdle` 可能在后台子 agent 结束前就返回。决策逻辑两种模式共用。
- 按任务手动改档：属于第 3 期的远程服务。
