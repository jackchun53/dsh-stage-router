# dsh-stage-router 设计文档

> 状态：第 0～4 期全部实现（2026-09-25），各期记录见 `docs/superpowers/plans/`；与本文不同之处以 §9 的修订记录为准。
> 目标版本：`@deepseek-ai/dsh@0.1.7-rc.2`（源码 deepseek-harness `477b4f4`）。实施计划见 `docs/superpowers/plans/`。

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
- `@deepseek-ai/*` 全部写成 `peerDependencies: "*"`；开发依赖锁精确版本 `0.1.7-rc.2`（子包的 npm `latest` 标签还停在 0.0.1-rc.1，不能用）。
- `cordis.patch.yml` 里的插件行，名称用不带子路径的包名，否则 Web 端不会被加载。
- patch 里的一行会**整体替换**该行的 `config`，覆盖时要把本插件负责的键写全（`boot/app-boot/src/profile.ts:59`）。

**虚拟服务商 `stage-router`**（`src/adapter.ts`）
- 通过 `ctx.llm.registerAdapter(['stage-router'], adapter)` 注册（`llm/llm/src/index.ts:396`）。`LlmAdapter` 是抽象类，只有 `stream()` 必须实现，`listModels` / `resolveModel` 有默认实现（`:208-290`）。写法参考 `llm/llm-deepseek/src/host.ts:39`。
- `listModels()` 把每套方案列成一个模型。
- `resolveModel()`：方案里任一阶段模型支持图片，就在 `inputModalities` 里带上 `'image'`（或干脆不填 `inputModalities`）。原因是 dsh 在接收用户消息时，是按虚拟模型来检查能否输入图片的，只有 `inputModalities` 有值且不含 `'image'` 时才拒绝（`api/session-controller/src/commands.ts:336-345`）。
- `stream()` 正常情况下不会被调用。万一被调用，就把请求转给方案初始阶段的真实模型（`ctx.llm.stream`），保证会话不会卡死。
- 方案有增删时（插件收到 `loader/volatile-update`），用 `handle.replace(['stage-router'])` 重新注册；`listModels()` 每次按当前配置返回方案列表。

**四个核心钩子**

| 钩子 | 在哪里注册 | 作用 |
|---|---|---|
| `agent/inbox/claimed` | 插件的根作用域 | 只记下被取出的用户消息。这个事件是同步的，不会等待，所以不能在这里调用判断器 |
| `system-prompt/assemble`（`prepend`） | 在 `agent/created` 里按 agent 注册 | **每一步里第一个会被等待的钩子**，顺序是：取出消息 → 求值各段落 → 本钩子 → pre-step → request。在这里执行状态机和判断器、联动计划模式、解析路由。dsh 在进入这个钩子**之前**就已经求值了各段落，所以当决策改变了阶段提示词或计划模式时，本钩子会带防重入保护地调用 `systemPrompt.assemble(context)` 重新组装一次，这样这一步的系统提示词就是完整的 |
| `ctx.systemPrompt.section({name:'stage-router:stage', order, text:c=>…})` | 插件的根作用域 | 按 agent 注入当前阶段的提示词。`order` 必填，取 `ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1`，紧跟计划模式的段落。做法与 `plan/plan-mode/src/index.ts:217` 相同 |
| `agent/pre-step`（`prepend`） | **在 `agent/created` 事件里，为每个 agent 单独注册**，在 `agent/disposed` 时注销 | dsh 自带的模型切换提示钩子也是按 agent、以 `prepend` 注册的（`core/agent/src/model-selection.ts:113-126`）。本插件的钩子注册得更晚、同样 `prepend`，就排在它外层，`await next()` 之后能看到它追加的提示。作用：过滤掉 `source.kind==='model-selection'` 的提示（仅当当前选择的是本插件的虚拟模型时）；阶段或模型真的变化时，追加一条本插件的提示（转换已在 assemble 钩子里处理） |
| `agent/request`（`prepend`） | 插件的根作用域（第 0 期已验证能胜过 model-selection） | 先 `await next()` 拿到原配置。dsh 的 model-selection 在它自己的 `agent/request` 钩子里、`next()` 之后把 provider/model 覆盖成所选模型（`model-selection.ts:96-112`），所以本插件的钩子必须在它外层。如果 provider 是 `stage-router`（或属于要路由的子 agent），就改写成当前阶段和档位对应的真实 `{provider, model, reasoningEffort}`。同一次请求失败重试时，沿用第一次的结果 |

**这样做带来的好处**
- dsh 记录的请求头就是真实模型，所以：
  - 历史消息的回放和思考签名由 dsh 原生处理，不用像 skill-vault 那样修补历史（`withRealReplayModels`）。
  - 上下文压缩和标题生成会自然用上真实模型。
- 模型选择器仍显示虚拟方案：dsh 的 `modelSelection` 投影里，`pending` 字段会一直保留虚拟路由。
- 判断当前会话是否选用了本插件的方案，不读请求头（请求头已是真实模型）。`sessionProjections.stateOf(session,'modelSelection')` 只在 session-controller 里有，无界面模式下是 `undefined`，所以：在 `agent/request` 里看 `await next()` 之后的 `provider==='stage-router'`；在用户消息被取出时用 agent 服务的 `selectionFor(agent).current`（`api/session-controller/src/commands.ts:338` 的用法）。

**判断器调用**
- 直接用 `ctx.llm.stream({provider, model, system, messages, maxTokens, temperature, signal})`，用 `BlockAssembler` 收集返回的文字。
- **不带 `sessionId`**，这样不会写入会话历史，也不会触发会话存盘。
- 提示词里要求返回 JSON，由插件自己解析。可以参考 `session-title-llm/src/index.ts:248-288` 的写法。

**会话状态的持久化**
- 不能往会话里写 dsh 不认识的事件类型，否则重新加载时会话会打不开（`storage-contract.ts:74`）。
- 外部插件**不能**追加自定义的会话事件类型：`Session.append` 没有办法设置 `ignorable`，而已知事件类型的列表是 dsh 仓库内生成的（`core/session/src/known-event-types.ts`）。
- **首选方案**：换阶段时追加的那条提示消息同时作为持久化载体。0.1.7 里没有 `{kind:'plugin'}` 来源，改为通过模块扩充在 `MessageSourceMap`（`@deepseek-ai/dsh-llm`）里声明 `'stage-router'` 来源，形如 `{kind:'stage-router', form:'notice', summary, stage, tier?, route, lock?, judge?}`（`form:'notice'` 要求带 `summary`，见 `llm/llm/src/message.ts:86`）。写法参考 goal 插件的 `goal/goal/src/domain.ts:54`。再用 `ctx.sessionProjections.register({key:'stage-router', stateSchema, init, apply, wire:{viewSchema, view}, stateVersion})` 注册会话投影，把这些消息折叠成「当前阶段、手动锁定、最近一次判断」；`wire` 要通过模块扩充 `SessionProjectionMap` 才能通过类型检查。Web 端插槽组件通过 props 拿到 `useProjection` 来读。
- **备选方案**：用插件自己的 JSON 文件 `~/.dsh/stage-router/state.json`，按 sessionId 保存，插件卸载时写盘，会话销毁时清理。skill-vault 就是这么做的。
- 两者选哪个，由第 0 期的实验结果决定。

## 2. 配置结构（插件配置 `stage-router`）

> 0.1.7 里插件配置用 `@deepseek-ai/schemastery` 声明 `export const Config`（参考 `todo/tool-todo/src/index.ts:41`），设置界面按 schema 自动生成表单。下面的 YAML 就是本插件那一行 `config` 的内容。
>
> 实际存放位置（第 1 期任务 1 已确认）：
> - `dsh plugin --profile <p> add <包>` 会把本包加进 `$DSH_HOME/profiles/<p>/package.json` 的 `dsh.profile.bundles`，本包的 `cordis.patch.yml` 作为 bundle 层插入 `- id: stage-router` 这一行，里面写默认配置；
> - 用户的覆盖写在 `$DSH_HOME/profiles/<p>/cordis.patch.yml`，形如 `- id: stage-router` 加 `config: {...}`，会**整体替换**这一行的 `config`；
> - `dsh --profile <p> --dump-config` 可以看到合成后的结果。

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
| `plan_approved` | dsh 没有专门的批准事件。`exit_plan_mode` 走 `userQuestions.ask`（`intent:{kind:'plan-review'}`），批准后下一次 pre-step 会追加 `plan/mode {active:false}`。本插件把「计划模式由开变关，且本轮出现过 `exit_plan_mode` 调用」当作批准，在 pre-step 里识别 |
| `todos_done` | 待办全部完成 |

**匹配规则**
- 同一个事件命中多条规则、目标又不同时，这些目标合起来作为判断器的候选阶段。只剩一个候选时，不调用判断器。
- 手动锁定的优先级最高。

**校验**
- 0.1.7 已经没有 `settings.installSection` / `settings.register`，也没有保存前的 `validate` 钩子。
- 字段类型、必填、枚举：交给 schemastery 的 `Config` schema。
- 语义校验放在插件加载时和 `loader/volatile-update` 时，由纯函数 `validateScheme()` 完成：
  - 阶段 ID 要唯一，转换规则引用的阶段要存在，`initialStage` 和 `tiers.default` 要合法；
  - 每个模型都用 `ctx.llm.resolveCallConfig`（`llm/llm/src/index.ts:878`）检查是否真实存在、推理强度是否支持。
- 校验不通过的方案：仍列在模型选择器里但标为不可用，写 error 日志；错误列表通过远程服务提供给 Web 端，由编辑器定位到具体字段。

## 3. 运行流程

1. **用户消息被取出时**（只处理根 agent，且选用了本插件方案的会话），按下面顺序决定阶段：
   - 有手动锁定 → 用锁定的阶段。
   - 计划模式变化或计划已批准 → 按事件转换。
   - 否则应用 `user_message` 规则，必要时调用判断器。
   - 判断失败或置信度不足 → 留在当前阶段；如果是会话第一条消息 → 进入 `initialStage`。
2. **进入新阶段时**：
   - 按 `planMode` 调用根服务 `ctx.planMode.set(agent, bool)`（`plan/plan-mode/src/index.ts:419`）；`ctx.get('planMode')` 取不到时忽略该设置。源码里没看到计划模式按预设挂载，不再走 `agentPresets.serviceFor`。
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
- **识别**：子 agent 的会话头里有 `origin: 'subagent'` 和 `parentSession`，且父会话正在按本插件的方案路由（父 agent 用 `ctx.agents.get(parentSession)` 找回）。0.1.7 里子 agent 继承的是父会话请求头里的**真实模型**，不会经过虚拟模型。
- **尊重显式指定**：子 agent 第一次请求时的模型和父会话当前路由的 provider/model 不同，说明是显式指定的 → 不改写。这个决定在第一次请求时做一次，按 agent 缓存。
- **fork 出来的子 agent**：跟随父会话的当前阶段和档位。识别依据是会话头 `isSeeded`，或子会话里 `subagent/descriptor` 事件的 `provider === 'fork'`。
- **新建的子 agent**：
  - 任务描述以 `[Tn]` 开头 → 用第 n 号任务的档位。先看工具的 `description`（descriptor 的 `label`），再看任务文本，也就是子 agent 第一条用户消息的第一个文字块。
  - 否则当 `classify=true` 时，对任务描述调用判断器定档。
  - `stage` 可以写 `inherit`（跟随父会话），也可以写死某个阶段 ID。

**可观测性**
- 每次路由决策写一条 dsh 日志：阶段、档位、原因、判断器耗时。
- 在内存里保留每个会话最近 50 条决策，通过一个远程服务提供给 Web 端。

## 4. 界面（`src/client/`）

> 0.1.7 的写法：注入插槽用 `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`；`settingsScope.bind` 和 `injectSlot` 在 0.1.7 里都不存在。本章的界面细节在第 4 期开工前按 0.1.7 的设置服务重新核对一遍。

**设置页编辑器**（注册到 `settings.section` 插槽，在设置页左侧是独立的一级菜单「阶段路由」，排在「模型」之后）
- **读写配置**：通过设置服务的 `describe` / `update` 读写本插件那一行的 `config`。
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
- **命令**：`/stage`（状态）、`/stage log`（最近决策）、`/stage <id>`（锁定）、`/stage auto`（恢复自动）、`/stage tier T<n> <档位|auto>`（按任务改档），用 `ctx.commands.register` 注册（`interaction/commands/src/index.ts:285`）。锁定和改档折叠 dsh 自己写的 `command/run` + `command/done` 事件持久化，命令成功即生效。面板上的操作也走这个命令，通过 `ctx.remote.commands.execute` 调用。
- 插槽组件从 props 里拿 `useProjection` 读 `stage-router` 投影（参考 `client/ui-plan/src/client/PlanModeControl.tsx:19`）。

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
  2. 在 `agent/created` 里以 `prepend` 注册的 `pre-step` 钩子，能过滤掉 dsh 的模型切换提示（`source.kind==='model-selection'`）。
  3. 会话投影能读到插件写入的提示消息（自定义 `source.kind`）的来源信息，且会话重新加载后仍能读到、不报错。不行就改用 JSON 文件保存状态。
  4. 在用户消息被取出时调用 `ctx.planMode.set`，当步就能生效；计划批准能在 pre-step 里识别出来。
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

## 9. dsh 0.1.7 接口修订记录

核对依据：deepseek-harness `477b4f4`（rel/dsh-0.1.7-rc.2），路径相对于 `packages/`。

| 原设计 | 0.1.7 实际 | 修订 | 状态 |
|---|---|---|---|
| 按 `source.plugin==='model-selection'` 过滤模型切换提示 | 来源是 `{kind:'model-selection', form:'notice', summary}`（`core/agent/src/model-selection.ts:53,113-126`） | 按 `source.kind` 过滤 | 已改 |
| 插件提示消息来源 `{kind:'plugin',plugin,form:'notice'}` | 0.1.7 没有这种来源；插件通过模块扩充 `MessageSourceMap` 声明自己的 `kind` | 声明 `'stage-router'` 来源（参考 `goal/goal/src/domain.ts:54`） | 第 0 期第 3 项已验证：重新加载后投影能恢复 |
| `systemPrompt.section({name,text})` | `order` 必填（`core/system-prompt/src/index.ts:454`） | 用 `getSectionOrder('PLAN_POLICY') + 1` | 已改 |
| `settings.installSection` + `validate` | 0.1.5-rc.3 才有，0.1.7 已删；配置用 schemastery `Config` 声明，变化时触发 `loader/volatile-update` | schema 做基础校验，语义校验在加载时做 | 已改 |
| `settingsScope.bind`、`injectSlot`、`settings.section` | 不存在 / 由设置页插件区块所有 | `ctx.slots.inject` + `settings.plugins.tab` | 第 4 期前复核 |
| 可导入的 `useProjection` | 作为 props 传给插槽组件 | 从 props 读 | 已改 |
| `plan_approved` 事件 | 没有；批准后追加 `plan/mode {active:false}` | 在 pre-step 里识别 | 第 0 期第 4 项已验证 |
| `agentPresets.serviceFor(agent,'planMode')` | 未见按预设挂载 | 用根服务 `ctx.planMode.set` | 第 0 期第 4 项已验证：返回 `'queued'`，但当步生效 |
| 根作用域 `prepend` 的 `agent/request` 胜过模型选择 | model-selection 的 `agent/request` 按 agent 注册、非 prepend；根作用域与 agent 作用域钩子的先后未确认 | 根作用域 `prepend` | 第 0 期第 1 项已验证 |
| 自定义会话事件 | `Session.append` 不能设 `ignorable`；未知事件类型重新加载时被拒（`storage-contract.ts:75`） | 只用消息作载体，或退回 JSON 文件 | 已改 |

核对无误、照原设计执行的：`registerAdapter` 及句柄 `replace`（`llm/llm/src/index.ts:297,396`）、`ctx.llm.stream` / `resolveCallConfig` / `BlockAssembler`（`llm/llm/src/assembler.ts:38`）、`ctx.commands.register`、`dsh.bundle.patch` / `dsh.client` 字段、`dsh web --patch`、会话头 `parentSession`（`core/session/src/types.ts:107`）、待办投影在 `turn/start` 时清空（`todo/tool-todo/src/index.ts:128-130`）、图片检查逻辑。

第 0 期额外发现（详见第 0 期文档）：
- 0.1.7 的系统提示词在 `messages` 里以 `role:'system'` 出现，`GenerateOptions.system` 为空。
- 请求头是真实模型，model-selection 从第 2 轮起**每一步**都会生成模型切换提示，所以 pre-step 过滤是必需的。
- `/stage` 命令的 `rawInput` 带前导空格，要 `trim()`。

第 1 期实现中的发现与修正：
- **决策时机**：第 0 期的"附"项之所以通过，是因为验证插件在 `agent/inbox/claimed` 里就同步定了阶段。实际要调用判断器，必须等待，所以决策放在 `system-prompt/assemble`，并在需要时重新组装。
- **默认模型会话的路由漂移**：Web 端没有明确选过模型时，session-controller 会把请求头里的模型当作当前选择（`api/session-controller/src/agent.ts:294-310`）。本插件改写后请求头是真实模型，第二次请求起就会脱离路由。修正：投影 `stage-router` 同时折叠 `model/selection` 事件；只要本插件写过提示、且之后用户没有明确换成别的模型，就继续按原方案路由。
- **计划批准信号**：`user-questions/request` 监听要用 `prepend` 注册，否则宿主的应答者不调用 `next()` 时会被跳过。判断计划模式时用"待定值优先"（`pending ?? active`），这样批准在下一步组装时就能识别出来。

第 2 期实现中的发现（详见 `docs/superpowers/plans/2026-09-25-phase2-tiers-subagents.md`）：
- 子 agent 继承父会话**最近一次记录的请求头**（`subagent/subagent/src/child-agent.ts:69-86`），而本插件改写后那里是真实模型，所以子 agent 必须按会话头识别，不能靠虚拟 provider。
- 分档判断在每次组装系统提示词时启动（有缓存，不重复判断），定档在同一次组装里完成，最多等 1.5 秒。

第 3 期实现中的发现（详见 `docs/superpowers/plans/2026-09-25-phase3-conversation-ui.md`）：
- 外部插件不能加入 dsh 的类型化远程接口，所以第 3 期的操作都走 `/stage` 命令，展示数据走投影。第 4 期的「试一试」再用 `TypertRemoteService` 加 `connection.rpc.call`。
- 客户端包的格式：CommonJS 单文件，用 `window.__ModuleLoader__.load` 包装，只能 `require` 平台模块表里的模块；`package.json` 需要 `exports["./client"]` 和 `dsh.client.platform: "web"`。客户端入口激活失败会让整个 Web 端起不来，所以顶层只依赖 `slots` 和 `locale`。
- Web 端用默认模型的会话，本插件会在第一次路由时写一条 `model/selection`（方案），让选择器一直显示虚拟方案。

第 4 期实现中的发现（详见 `docs/superpowers/plans/2026-09-25-phase4-editor.md`）：
- dsh 0.1.7 的设置服务只读写 `.volatile()` 字段，所以插件的 `Config` 把 `defaultJudge` 和 `schemes` 标成 volatile。保存后插件收到 `loader/volatile-update` 并刷新配置快照，不重启，各会话的路由状态保留。
- 编辑器入口最初是 设置 → 内置插件 → 阶段路由（`settings.plugins.tab` 插槽），后来改为设置页的一级菜单 设置 → 阶段路由（`settings.section` 插槽，`order: 12`）。后端服务是 `TypertRemoteService`（命名空间 `stageRouter`），客户端经 `connection.rpc.call('/api', 'stageRouter/<方法>', { args })` 调用。
- 保存走 `ctx.settings.replace`，带修订号，写入 profile 的 `cordis.patch.yml`；结构错误阻止保存，模型不可用只提醒。

界面语言（第 4 期之后）：插件的所有界面文字只有中文，包括阶段标签、面板、每轮摘要、编辑器、`/stage` 命令的说明和回复、校验提示、路由原因和判断失败原因，以及选择器里「<方案名>（阶段路由）」这个名字。客户端的英文字典直接复用中文字典，所以 dsh 界面是英文时，本插件仍然显示中文。只写进日志的文字，以及只发给模型的文字（判断器提示词、阶段提示消息），保持英文。

判断器改用 Jev（2026-09-25，第 4 期之后）：本节以下内容取代正文里关于「判断器模型」的描述。
- **只用 Jev**：去掉「用 dsh 里某个模型当判断器」的做法，包括 `defaultJudge`、方案级 `judge` 覆盖和提示词模板。顶层配置改为 `{ jev, schemes }`，`jev` 是 `{ baseUrl, model, token, timeoutMs, minConfidence, contextTurns }`，同样标成 volatile。`baseUrl` 默认 `https://api.typesafe.ai/v1`，`model` 默认 `jev-latest`。旧配置里的 `defaultJudge` 和 `schemes[].judge` 在解析时丢弃，旧 patch 文件照常加载。事件驱动的转换和规划者标签不变。
- **调用方式**（`src/engine/jev.ts`，对齐 skill-vault 的 `jev.rs`）：`POST <baseUrl>/systemone`，`Authorization: Bearer <token>`，请求体 `{ model, state, questions }`。阶段判断是一道 `choice` 题（键 `stage`），选项是候选阶段、说明取阶段描述；`state` 带用户消息（截到 4000 字）、当前阶段和最近几轮对话。分档是每个任务一道 `choice` 题（键 `t1…tn`），选项是档位及其描述，`state.tasks` 带任务文本（每条截到 500 字，一批最多 30 条）。置信度取 Jev 的 `confidence`，没有时取所选项的概率。未配置、超时、401、其他 HTTP 错误、返回格式不对都返回失败，按原来的失败语义处理（第一条消息进初始阶段，否则留在当前阶段；档位用默认档）。
- **token 保密**：`jev.token` 在 schema 里标成 `role('secret')`。编辑器的 `getConfig` 把 token 置空，另外返回 `jevTokenSet`；`validate`、`saveConfig`、`tryJudge` 收到空 token 时沿用已保存的 token，`saveConfig(…, clearJevToken=true)` 才会清除。Jev 未配置、模型不可用这类问题带 `severity: 'warning'`，不阻止保存。
- **判断日志**：`src/engine/judge-log.ts` 在内存里按会话保存最近 50 条 Jev 调用（最多 200 个会话），阶段判断记录消息摘要、候选、Jev 的选择与各项概率、置信度、耗时、结果和原因，分档记录每个任务的档位。远程方法 `stageRouter/judgeLog(sessionId, limit?)` 供阶段面板读取，面板打开时拉取，也可以手动刷新。重启后清空。
- **界面**：编辑器和阶段面板改用宿主通过模块表提供的 `@deepseek-ai/dsh-client-ui-primitives`（`Button`、`Switch`、`SegmentedTabs`、`Pill`、`Tag`、`StateDot`），配色全部换成宿主真实存在的 `--dsw-alias-*` token（原先用的 `--dsw-color-*` 在宿主里不存在，一直落到兜底色）。`:hover` / `:focus` 等样式写在 `src/client/styles.ts`，以 `sr-` 前缀注入一次。设置页顶部是一条吸顶工具栏：方案下拉、新建 / 复制 / 删除方案、错误和提醒计数、放弃修改和保存，下面是「概览 / 阶段 / 转换 / 子 agent / Jev」五个标签页，工具栏右侧的「Jev 已配置 / 未配置」可以直接跳到 Jev 页。概览页放方案的名称、ID、初始阶段，以及每个阶段（分档的阶段还有每个档位）的模型选择；点阶段名跳到「阶段」页并展开那张卡片。阶段页的卡片可以折叠，收起时显示模型摘要。分档的阶段仍保留阶段自己的模型，在没有进行中的待办时使用。Jev 页是连接设置和「试一试」。设置弹窗只有约 560px 宽，所以不用左右分栏；模型三联下拉和档位字段在更窄时用容器查询换行。单元测试里 primitives 由 `test/client/primitives-stub.tsx` 代替（其依赖只在宿主里有）。
