# dsh-stage-router 设计文档

> 状态：设计已确认（2026-09-25），待审阅后拆分实施计划。

## Context

skill-vault 客户端的「预设模型」（`skill-vault/packages/dsh-plugin`）已经能在 DeepSeek Harness 里按对话阶段切换模型，但它的通用性不够：
- 阶段固定为 plan / code / review，兜底阶段固定为 code。
- 判断器只能用 Jev，也就是公司内部的 `/systemone` 接口；判断用的提示词写死在代码里。
- 预设和模型都由 skill-vault 服务端下发。
- 分档只有轻 / 重两档，而且只作用于编码阶段。

本项目（`D:\workspace\skills\dsh-stage-router`，目前只有 LICENSE）要做一个独立的 dsh 插件：
- 所有模型，包括判断器，都来自 dsh 里已配置的服务商和模型（`ctx.llm`）。
- 阶段、状态转换、阶段内分档都能自由配置。
- 附带可视化编辑器和对话内的状态展示。

### 已和你确认的决策
1. 流程形态：自定义阶段 + 状态机。事件触发的转换和判断器决定的转换并存，仍在同一个对话里切换模型。
2. 阶段内分档：任何阶段都能配置多个档位。档位来源可以是规划者写的标签、判断器，或者两者结合。
3. 多套方案：每套方案在模型选择器里显示为 `stage-router/<方案id>` 这样一个条目。
4. 界面范围：第一版就包含完整的可视化编辑器、输入框旁的状态小标签、每轮末尾的摘要。
5. 判断失败或置信度不足时：留在当前阶段。只有会话的第一条消息进入 `initialStage`。
6. 阶段能配置的内容：模型和推理强度、阶段提示词（注入系统提示词）、与 dsh 计划模式联动。
7. 子 agent 路由：每套方案单独开关，默认关闭。

## 1. 整体架构

**打包方式**
- TypeScript，参照 `D:\workspace\nodejs\dsh-oss-sync` 的项目骨架：`tsc` 编译后端代码，`scripts/build-client.mjs` 打包 Web 端。
- 用 `package.json` 的 `dsh.bundle.patch` 字段指向 `cordis.patch.yml`，用 `dsh.client` 字段声明 Web 端入口。
- `@deepseek-ai/*` 全部写成 `peerDependencies: "*"`。
- `cordis.patch.yml` 里的插件行，名称用不带子路径的包名，否则 Web 端不会被加载。

**虚拟服务商 `stage-router`**（`src/adapter.ts`）
- 通过 `ctx.llm.registerAdapter(['stage-router'], adapter)` 注册。
- `listModels()` 把每套方案列成一个模型。
- `resolveModel()`：方案里任一阶段模型支持图片，就声明这个虚拟模型也支持图片。原因是 dsh 在接收用户消息时，是按虚拟模型来检查能否输入图片的（`session-controller/src/commands.ts:335`）。
- `stream()` 正常情况下不会被调用。万一被调用，就把请求转给方案初始阶段的真实模型（`ctx.llm.stream`），保证会话不会卡死。
- 方案有增删时，用 `handle.replace(ids)` 更新注册的模型列表。

**四个核心钩子**

| 钩子 | 在哪里注册 | 作用 |
|---|---|---|
| `agent/inbox/claimed` | 插件的根作用域 | 用户新消息被取出时执行状态机，决定本轮阶段，并联动计划模式 |
| `ctx.systemPrompt.section({name:'stage-router:stage', text:c=>…})` | 插件的根作用域 | 按 agent 注入当前阶段的提示词。做法与 `plan-mode/src/index.ts:212` 相同 |
| `agent/pre-step`（`prepend`） | **在 `agent/created` 事件里，为每个 agent 单独注册**，在 `agent/disposed` 时注销 | 必须这样注册，才能排在 dsh 自带的模型切换提示钩子之前（`model-selection.ts:108`）。作用：过滤掉 `source.plugin==='model-selection'` 的提示（仅当当前选择的是本插件的虚拟模型时）；处理 `todos_done` 转换；阶段或模型真的变化时，追加一条本插件的提示 |
| `agent/request`（`prepend`） | 插件的根作用域 | 先 `await next()` 拿到原配置。如果 provider 是 `stage-router`（或属于要路由的子 agent），就改写成当前阶段和档位对应的真实 `{provider, model, reasoningEffort}`。同一次请求失败重试时，沿用第一次的结果 |

**这样做带来的好处**
- dsh 记录的请求头就是真实模型，所以：
  - 历史消息的回放和思考签名由 dsh 原生处理，不用像 skill-vault 那样修补历史（`withRealReplayModels`）。
  - 上下文压缩和标题生成会自然用上真实模型。
- 模型选择器仍显示虚拟方案：dsh 的 `modelSelection` 投影里，`pending` 字段会一直保留虚拟路由。
- 判断当前会话是否选用了本插件的方案，读 `sessionProjections.stateOf(session,'modelSelection').pending`，不读请求头。

**判断器调用**
- 直接用 `ctx.llm.stream({provider, model, system, messages, maxTokens, temperature, signal})`，用 `BlockAssembler` 收集返回的文字。
- **不带 `sessionId`**，这样不会写入会话历史，也不会触发会话存盘。
- 提示词里要求返回 JSON，由插件自己解析。可以参考 `session-title-llm/src/index.ts:248-288` 的写法。

**会话状态的持久化**
- 不能往会话里写 dsh 不认识的事件类型，否则重新加载时会话会打不开（`storage-contract.ts:74`）。
- **首选方案**：换阶段时追加的那条提示消息（`source:{kind:'plugin',plugin:'stage-router',form:'notice'}`）同时作为持久化载体。再注册一个会话投影 `stage-router`，把这些消息折叠成「当前阶段、手动锁定、最近一次判断」，并带上 wire 视图，让 Web 端能用 `useProjection` 直接读到。
- **备选方案**：用插件自己的 JSON 文件 `~/.dsh/stage-router/state.json`，按 sessionId 保存，插件卸载时写盘，会话销毁时清理。skill-vault 就是这么做的。
- 两者选哪个，由第 0 期的实验结果决定。

## 2. 配置结构（`settings.yaml` → `stage-router`）

```yaml
stage-router:
  defaultJudge:
    route: { provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: off }
    timeoutMs: 6000
    minConfidence: 0.6
    contextTurns: 2          # 带上最近几轮对话摘要，每段截断到 800 字
    promptTemplate: null     # null 表示用内置的默认模板
  schemes:
    - id: dev-default
      name: 研发默认
      initialStage: code
      judge: null            # 可以覆盖 defaultJudge 里的部分字段
      subagents: { enabled: false, stage: inherit, classify: true }
      stages:
        - id: plan
          name: 规划
          description: 讨论方案、做设计或规划实现步骤，尚未要求动手写代码
          route: { provider: deepseek-official, model: deepseek-v4-pro, reasoningEffort: max }
          prompt: "把实现拆成编号任务 [T1][light] …"
          planMode: enter    # enter | exit | keep（默认 keep）
        - id: code
          name: 编码
          description: 编写、修改、调试代码
          route: { provider: deepseek-official, model: deepseek-v4-flash }
          tiers:
            source: planner-then-judge   # planner | judge | planner-then-judge
            default: heavy
            levels:                      # 从轻到重排列
              - { id: light, description: 局部改动、步骤明确, route: {…} }
              - { id: heavy, description: 跨模块、需要设计取舍, route: {…} }
        - { id: review, name: 审查, description: …, route: {…}, prompt: … }
      transitions:           # 按顺序匹配，第一条命中的生效
        - { from: '*',  to: plan,   on: plan_mode_on }
        - { from: plan, to: code,   on: plan_approved }
        - { from: code, to: review, on: todos_done }
        - { from: '*',  to: '*',    on: user_message }
```

**触发事件**

| 事件 | 什么时候触发 |
|---|---|
| `user_message` | 用户发来新消息。这是唯一会调用判断器的事件 |
| `plan_mode_on` / `plan_mode_off` | 用户切换 dsh 计划模式 |
| `plan_approved` | `exit_plan_mode` 被批准 |
| `todos_done` | 待办全部完成 |

**匹配规则**
- 同一个事件命中多条规则、目标又不同时，这些目标合起来作为判断器的候选阶段。只剩一个候选时，不调用判断器。
- 手动锁定的优先级最高。

**保存时的校验**
- 用 `settings.installSection` 注册配置段，在它的 `validate` 钩子里做校验。
- 每个模型都用 `ctx.llm.resolveCallConfig` 检查是否真实存在、推理强度是否支持。
- 阶段 ID 要唯一，转换规则引用的阶段要存在，`initialStage` 和 `tiers.default` 要合法。
- 注意：dsh 0.1.7 移除了 `settings.register`，要先检测 dsh 是否提供对应接口再调用，做法参考 skill-vault 的 `preferences-store.js:101`。

## 3. 运行流程

1. **用户消息被取出时**（只处理根 agent，且选用了本插件方案的会话），按下面顺序决定阶段：
   - 有手动锁定 → 用锁定的阶段。
   - 计划模式变化或计划已批准 → 按事件转换。
   - 否则应用 `user_message` 规则，必要时调用判断器。
   - 判断失败或置信度不足 → 留在当前阶段；如果是会话第一条消息 → 进入 `initialStage`。
2. **进入新阶段时**：
   - 按 `planMode` 调用 `agentPresets.serviceFor(agent,'planMode').set(agent, bool)`。拿不到时退回 `ctx.get('planMode')`。
   - 自己发起的计划模式切换要做标记，不再按这个事件跳转阶段，避免来回循环。
3. **组装系统提示词时**：注入当前阶段的 `prompt`。
4. **每一步开始前**：
   - `todo/write` 事件显示待办全部完成 → 应用 `todos_done` 规则。
   - 过滤 dsh 的模型切换提示；阶段或模型真的变了，才追加本插件的提示。
5. **请求发出前**：定档 → 改写请求。

**判断器**
- 默认模板要求输出 `{"stage","confidence","reason"}`。
- 模板变量：`{{current}}`、`{{candidates}}`、`{{recent}}`、`{{message}}`。
- 解析容错：能从代码块里取出 JSON；`stage` 不在候选里就视为失败。
- 每条消息只判断一次，结果按「会话 ID + 消息 ID」缓存。

**分档**
- **什么时候判断**：`todo/write` 事件出现时，对新增或变化的待办，异步批量调用判断器（一次最多 30 条）。结果按待办内容的哈希缓存。
- **规划者标签**：待办文本带 `[Tn][<档位id>]` 标签时，直接采用。
- **请求发出前**：
  - 取所有进行中的待办，最重的一档胜出。
  - 有待办还没判断完 → 最多等 1.5 秒，仍无结果就用 `default` 档。
  - 没有进行中的待办 → 用该阶段本身的 `route`。
- **注意**：dsh 的待办列表在每轮开始时会被清空（`tool-todo/src/index.ts:134`）。

**子 agent**（`subagents.enabled=true` 时才处理）
- **识别**：子 agent 的会话头里有 `parentSession`，且父会话选用了本插件的方案。
- **尊重显式指定**：子 agent 请求的模型和父会话最近一次请求用的模型不同，说明是显式指定的 → 不改写。
- **fork 出来的子 agent**：跟随父会话的当前阶段和档位。
- **新建的子 agent**：
  - 任务描述以 `[Tn]` 开头 → 用第 n 号任务的档位。
  - 否则当 `classify=true` 时，对任务描述调用判断器定档。
  - `stage` 可以写 `inherit`（跟随父会话），也可以写死某个阶段 ID。

**可观测性**
- 每次路由决策写一条 dsh 日志：阶段、档位、原因、判断器耗时。
- 在内存里保留每个会话最近 50 条决策，通过一个远程服务提供给 Web 端。

## 4. 界面（`src/client/`）

**设置页编辑器**（注册到 `settings.section` 插槽）
- **读写配置**：`settingsScope.bind({namespace:'stage-router'})`。
- **模型下拉**：数据来自 `remote.session.modelCatalog()`，排除 `stage-router` 自己。推理强度下拉跟所选模型联动。
- **页面结构**：左侧是方案列表（新建、复制、删除），右侧四个标签页：

| 标签页 | 内容 |
|---|---|
| 基本 | 名称、ID、初始阶段 |
| 阶段 | 可拖动排序的卡片：名称、描述、模型、提示词、计划模式、分档 |
| 转换 | 规则表格，可拖动排序；上方用只读小图画出阶段节点和连线 |
| 判断器 & 子 agent | 覆盖判断器设置、编辑提示词模板（可恢复默认）、「试一试」实时调用判断器、子 agent 开关及子项 |

- **全局设置**：页面顶部设置默认判断器。
- **保存**：保存时由后端校验，报错定位到具体字段。

**对话里的展示**
- **输入框右侧小标签**（`conversation.input.right`）：只在选用了本插件方案的会话里显示，例如 `编码 · heavy · v4-pro`。点开是一个面板：最近一次判断的原因和置信度、锁定或解锁阶段、按任务手动改档。
- **每轮末尾摘要**（`conversation.chat.turnTail`）：例如 `本轮：规划 → 编码（v4-pro → v4-flash）`。
- **命令**：`/stage <id>` 和 `/stage auto`。先确认 dsh 支持插件注册命令；不支持就只保留界面入口。
- 插槽注册的写法参考 skill-vault 的 `client/index.jsx:740-751`：用 `injectSlot` 包一层 try/catch，兼容旧版 dsh。

## 5. 错误处理

| 情况 | 怎么处理 |
|---|---|
| 判断器超时、出错或返回格式不对 | 留在当前阶段，写一条 warn 日志，小标签上显示「判断失败」 |
| 某阶段配置的模型已不存在或未授权 | 退回 `initialStage` 的模型；如果它也不可用，就退回模型选择器的默认模型；同时写一条 error 日志，并在界面上标红 |
| 虚拟模型的 `stream()` 被直接调用 | 把请求转给初始阶段的模型 |
| 切换计划模式的服务拿不到 | 忽略 `planMode` 设置，写一条 warn 日志 |
| 插件热重载 | 钩子会随插件作用域自动清理；每个 agent 单独注册的钩子，由插件自己维护的注销函数表负责清理 |

## 6. 目录结构

```
package.json  cordis.patch.yml  tsconfig.json  tsconfig.client.json  scripts/build-client.mjs
src/
  index.ts                  插件入口，负责把各模块组装起来
  config/schema.ts          配置结构、默认值、校验
  config/defaults.ts        默认判断器提示词模板、示例方案
  adapter.ts                虚拟服务商
  engine/transitions.ts     纯函数：(状态, 触发事件, 方案) → 候选阶段 / 下一阶段
  engine/judge.ts           构造提示词、调用判断器、解析 JSON、缓存
  engine/tiers.ts           从待办推导档位、解析规划者标签
  engine/state.ts           每个会话的状态；会话投影或 JSON 文件
  hooks/{inbox,prompt,prestep,request,planmode,subagent}.ts
  remote.ts                 提供给 Web 端的服务：决策记录、试一试、锁定、改档
  client/{index.tsx, editor/*, StageChip.tsx, TurnTail.tsx}
test/
```

## 7. 分期交付

- **第 0 期：技术验证**（每项写一个最小插件，用 `pnpm dsh web --patch` 加载，逐项验证。失败就回到对应设计点调整）
  1. 在根作用域以 `prepend` 注册的 `agent/request` 钩子，能胜过 dsh 自带的模型选择；dsh 记录的请求头是真实模型。
  2. 在 `agent/created` 里以 `prepend` 注册的 `pre-step` 钩子，能过滤掉 dsh 的模型切换提示。
  3. 会话投影能读到插件写入的提示消息的来源信息。读不到就改用 JSON 文件保存状态。
  4. 在用户消息被取出时调用 `planMode.set`，当步就能生效。
  5. 插件能否注册 `/stage` 命令。
  6. 虚拟模型声明支持图片后，dsh 接收图片消息的检查能通过。
- **第 1 期：核心能力**：配置结构和校验、虚拟服务商、状态机、判断器、四个核心钩子、计划模式联动、状态持久化。完成后只写 YAML 配置就能用。
- **第 2 期**：阶段内分档、子 agent 路由。
- **第 3 期**：对话里的小标签、每轮末尾摘要、`/stage` 命令，以及对应的远程服务。
- **第 4 期**：可视化编辑器，包括「试一试」。

## 8. 验证方式

- **单元测试**（`node --test` 或 vitest）：
  - `transitions`：各事件、通配符、多个候选、手动锁定、判断失败时留在原阶段。
  - `judge`：模板渲染、JSON 容错解析、超时、缓存。
  - `tiers`：规划者标签、最重一档胜出、等待超时后用默认档。
  - `schema`：各类校验错误。
- **集成测试**：在测试用的 patch 里注册一个假的 LLM 服务商，按脚本返回判断器的 JSON，同时记录收到的请求。无界面启动 dsh 跑一个多轮会话，断言：
  - 每一步请求的 provider、model、reasoningEffort 符合预期；
  - 会话历史里没有 `[model changed]` 提示，只有本插件的阶段提示；
  - 重新加载会话后阶段能恢复；
  - 计划被批准后自动进入编码阶段；
  - 子 agent 开关的两种状态各自表现正确。
- **手动验证**：用 `dsh plugin --profile web add .` 安装后打开 Web 端，确认：
  - 选择器里出现各方案；
  - 编辑器的模型下拉和 `~/.dsh/settings.yaml` 里配置的模型一致；
  - 「试一试」能返回判断结果；
  - 小标签和每轮末尾摘要随对话更新。

