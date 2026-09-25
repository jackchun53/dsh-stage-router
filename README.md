# dsh-stage-router

DeepSeek Harness（dsh）插件：在同一个对话里，按对话所处的阶段切换模型。阶段划分、阶段之间怎么切换、阶段内的分档都可以自由配置。

- 在模型选择器里，每套方案显示为一个模型 `stage-router/<方案 id>`。选中后，每一步请求都会改写成当前阶段对应的真实模型。
- 阶段靠状态机切换。有些切换由事件直接触发：计划模式开关、计划被批准、待办全部完成；用户发来新消息时，交给判断器模型从候选阶段里挑一个。
- 阶段内可以再分档，例如轻活用快模型、重活用强模型。档位可以来自规划者写的 `[T1][light]` 标签，也可以让判断器给待办定档。
- 子 agent 也可以按方案路由（每套方案单独开关）。
- 界面：输入框右侧有阶段标签，点开是详情和锁定面板；阶段变化的那一轮，回复下方有一行摘要；设置页里有可视化的方案编辑器，并提供「试一试」。

目标版本：`@deepseek-ai/dsh@0.1.7-rc.2`。

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile web add /path/to/dsh-stage-router
dsh web
```

安装后，本插件自带一套示例方案「研发默认」，包含规划、编码、审查三个阶段，模型都用 DeepSeek 官方服务商，其中编码阶段分 light / heavy 两档。示例方案在 `cordis.patch.yml` 里。

## 配置

推荐在 设置 → Built-in plugins → Stage router 里编辑，保存后立即生效。

也可以手工写 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。注意这一行的 `config` 会整体替换默认配置：

```yaml
- id: stage-router
  config:
    defaultJudge:
      route: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: 'off' }
      timeoutMs: 6000
      minConfidence: 0.6
      contextTurns: 2
      promptTemplate: null        # null 表示使用内置模板
    schemes:
      - id: dev-default
        name: 研发默认
        initialStage: code
        subagents: { enabled: false, stage: inherit, classify: true }
        stages:
          - id: plan
            description: 讨论方案、做设计或规划实现步骤
            route: { provider: deepseek-official, model: deepseek-v4-pro, reasoningEffort: max }
            prompt: 先澄清需求，再把实现拆成编号任务 [T1][light] …
            planMode: enter        # enter | exit | keep
          - id: code
            description: 编写、修改、调试代码
            route: { provider: deepseek-official, model: deepseek-flash }
            tiers:
              source: planner-then-judge   # planner | judge | planner-then-judge
              default: heavy
              levels:
                - { id: light, description: 局部改动, route: { provider: deepseek-official, model: deepseek-flash } }
                - { id: heavy, description: 跨模块, route: { provider: deepseek-official, model: deepseek-v4-pro, reasoningEffort: high } }
          - id: review
            description: 审查已完成的改动
            route: { provider: deepseek-official, model: deepseek-v4-pro, reasoningEffort: high }
        transitions:                # 按顺序匹配
          - { from: '*', to: plan, on: plan_mode_on }
          - { from: plan, to: code, on: plan_approved }
          - { from: code, to: review, on: todos_done }
          - { from: '*', to: '*', on: user_message }   # 所有阶段都作为判断器的候选
```

完整说明见 `docs/superpowers/specs/2026-09-25-stage-router-design.md`。

## 对话里的命令

| 命令 | 作用 |
|---|---|
| `/stage` | 查看当前阶段、档位、模型和锁定状态 |
| `/stage log` | 查看最近的路由决策 |
| `/stage <阶段 id>` | 锁定到某个阶段，锁定后不再调用判断器 |
| `/stage auto` | 恢复自动路由 |
| `/stage tier T<n> <档位 \| auto>` | 手动指定第 n 号任务的档位 |

## 开发

| 命令 | 作用 |
|---|---|
| `pnpm build` | 编译后端（tsc，输出 `lib/`）并打包 Web 端（`lib/client.js`） |
| `pnpm typecheck` | 对后端、测试、客户端做类型检查 |
| `pnpm test` | 构建后运行单元测试、客户端测试和无界面集成测试（集成测试接假模型服务，不需要 API key） |
| `pnpm test:web` | Web 端到端测试：阶段标签、每轮摘要、从面板锁定。需要 Playwright，可通过 `PLAYWRIGHT_MODULE` 指定路径 |
| `pnpm test:web:editor` | 编辑器端到端测试：试一试、保存、实时生效 |

各期的实施记录和截图在 `docs/superpowers/plans/`。
