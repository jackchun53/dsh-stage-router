# 第 0 期：技术验证

> 目标版本：`@deepseek-ai/dsh@0.1.7-rc.2`
> 结论：六项全部通过，其中第 5、6 项需要在本地 Web 端复核。架构维持首选方案：请求头记录的是真实模型，状态保存在提示消息里。

## 测试环境

所有验证代码都在 `spikes/` 目录下：

| 文件 | 作用 |
|---|---|
| `package.json` | 把 dsh 锁在 `0.1.7-rc.2` |
| `spike-plugin.js` | 验证用插件，内容见下方列表 |
| `spike.patch.yml` | 把默认模型设成 `stage-router/spike`；关掉 `llm-deepseek`、`llm-deepseek-account`、`session-title-llm`；按相对路径加载 `./spike-plugin.js` |
| `run.mjs` | 驱动脚本。每轮对话单独起一个 `dsh headless --json` 进程，第 2 轮起带 `--session-id`，所以**每一轮都是从存储重新加载会话**。它会设置隔离的 `DSH_HOME` / `DSH_AGENTS_HOME` 和 `DSH_PERMISSION_MODE=danger-full-access` |

`spike-plugin.js` 做了这些事：
- 注册假服务商 `fake`，按关键词决定返回文字、`todo_write` 调用或 `exit_plan_mode` 调用，并记录收到的每个请求；
- 注册虚拟服务商 `stage-router`；
- 放置各项探针；
- 自动批准 `plan-review` 问题，因为无界面模式下没有人来回答它。

```sh
cd spikes && npm install
node run.mjs main                              # 完整场景，4 轮
node run.mjs short                             # 2 轮
SPIKE_REQUEST_SCOPE=root-append node run.mjs short   # 对照：钩子不 prepend
SPIKE_FILTER=0 node run.mjs short                    # 对照：不过滤模型切换提示
```

探针日志写在 `spikes/.dsh-home/<场景>/probe.jsonl`，会话文件在同目录的 `home/sessions/` 下。

## 结果

| # | 验证什么 | 结果 | 证据（`probe.jsonl`） |
|---|---|---|---|
| 1 | 根作用域 `prepend` 的 `agent/request` 能胜过 model-selection | **通过** | `request-hook` 每一步看到的都是 `stage-router/spike`，改写后假服务商收到的是 `fake/real-<stage>`；工具调用后的第 2 步也一样 |
| 2 | 按 agent 以 `prepend` 注册的 pre-step 能过滤掉模型切换提示 | **通过** | 从第 2 轮起，**每一步**都有 1 条 `source.kind==='model-selection'` 的提示被过滤掉（`droppedModelSelectionNotices:1`），假服务商收到的消息里一条都没有。对照组 `SPIKE_FILTER=0` 里，模型会看到 `[model changed: … fake/real-code; the session continues with stage-router/spike]` |
| 3 | 自定义 `source.kind` 的提示消息能被投影读到，重新加载后仍在 | **通过** | 每一轮都是重新加载，`inbox-claimed.restored` 依次是 `{stage:null}` → `{stage:'code',notices:1}` → `{stage:'review',notices:2}` → `{stage:'plan',notices:3}`，没有加载错误 |
| 4 | 在 `agent/inbox/claimed` 里调用 `planMode.set`，当步生效；能识别计划批准 | **通过** | `set` 返回 `'queued'`，但第 1 步的 pre-step 里 `planMode.active` 已经是 `true`，消息里也出现了 `plan-mode` 的说明消息。`exit_plan_mode` 被批准后，第 2 步的 pre-step 里 `planMode.active` 变回 `false` |
| 5 | 插件能注册 `/stage` 命令 | **通过（需本地复核界面）** | `ctx.commands.register` 成功；`ctx.commands.execute(agent,'/stage code',…)` 调到了处理函数，返回 `{kind:'success'}`。注意 `rawInput` 是 `" code"`，**带前导空格**，要 `trim()`。无界面模式不解析斜杠命令，命令面板里能不能看到要在 Web 端确认 |
| 6 | 虚拟模型声明支持图片后，带图片的消息能通过检查 | **通过（需本地复核界面）** | `ctx.llm.resolveModelInfo('stage-router','spike')` 返回 `inputModalities:['text','image']`，按 `api/session-controller/src/commands.ts:336-345` 的判断逻辑能通过。实际上传图片要在 Web 端确认 |
| 附 | 阶段提示词段落 `systemPrompt.section({name, order, text})` | **通过，但有前提** | 假服务商收到的系统消息里有 `STAGE_PROMPT(code)` / `STAGE_PROMPT(review)`，当步生效。**更正（第 1 期）**：能当步生效，是因为验证插件在 `agent/inbox/claimed` 里就同步定了阶段；dsh 在 `system-prompt/assemble` 钩子之前就求值了各段落。需要等待判断器时，做法见设计 §9 |

## 顺带发现的情况，影响后续设计

1. **系统提示词在消息列表里。** 在 0.1.7 的 `GenerateOptions` 里，系统提示词是 `messages` 里 `role:'system'` 的那条消息，`options.system` 是 `undefined`。判断器自己调用 `ctx.llm.stream` 时，仍然可以传 `system`，这一点在第 1 期的判断器任务里用单元测试确认。
2. **模型切换提示每一步都会出现。** 请求头记录的是真实模型，而 model-selection 拿它和虚拟模型比较，所以从第 2 轮起每一步都会生成一条模型切换提示，包括工具调用之后的那一步。第 2 项的过滤是**必需**的，不是锦上添花。
3. **根作用域钩子不加 `prepend` 也能赢，但仍要加。** 对照组 `root-append` 也改写成功了，原因是插件在启动时注册，早于 agent 创建时注册的 model-selection 钩子。插件热重载后这个先后就不成立了，所以要保留 `prepend`。
4. **无界面模式没有 `modelSelection` 投影。** 这个投影只在 session-controller 里有，`stateOf(session,'modelSelection')` 在无界面模式下拿到的是 `undefined`。判断"当前会话是否选用了本插件的方案"要换一种方式：
   - 在 `agent/request` 里看 `await next()` 之后的 `provider==='stage-router'`；
   - 在用户消息被取出时，改用 agent 服务的 `selectionFor(agent).current`，也就是 `commands.ts:338` 的用法。这一点是第 1 期任务 7 的第一步。
5. **识别计划批准的方式。** 在 pre-step 里记下上一步的 `planMode.active`：从 `true` 变成 `false`，而且本轮出现过 `plan-review` 问题（或者 `exit_plan_mode` 的工具结果里有 `approved:true`），就当作 `plan_approved`。
6. **无界面模式下的必要配置。**
   - 要设 `DSH_PERMISSION_MODE=danger-full-access`，否则工具审批没人回答，会卡住。
   - `plan-review` 问题要由测试插件代为回答。
   - 第 1 期的集成测试沿用这套配置。

## 需要你本地复核的项

用 `dsh plugin --profile web add <本仓库>/spikes` 安装，或者用 `dsh web --patch spikes/spike.patch.yml` 启动，然后确认：
- [x] ~~执行 `/stage` 后有成功提示~~：第 3 期的 `pnpm test:web` 已在真实 Web 端通过面板执行 `/stage plan`，对话里出现了命令卡片。输入 `/` 后命令面板里能否看到 `/stage` 尚未单独确认；
- [x] ~~模型选择器里能选到方案~~：`pnpm test:web` 中选择器显示了测试方案（现在的名称是「测试（阶段路由）」）。发送带图片的消息尚未确认。
