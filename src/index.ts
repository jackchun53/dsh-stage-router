import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, Message, ReasoningEffortId, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { PROVIDER, StageRouterAdapter, initialRoute } from './adapter.js'
import { DEFAULT_JEV, JevSchema, SchemeSchema, type RouteConfig, type SchemeConfig, type StageRouterConfig } from './config/schema.js'
import { checkRoutes, schemeRoutes, validateConfig } from './config/validate.js'
import { JudgeCache, runJudge, summarizeRecent } from './engine/judge.js'
import { globalFetch } from './engine/jev.js'
import { JudgeLog } from './engine/judge-log.js'
import { SessionRouter, type StageEffect } from './engine/session-router.js'
import { routeChild } from './engine/subagents.js'
import { TierClassifier, type TodoLike } from './engine/tiers.js'
import { DecisionLog } from './engine/decisions.js'
import { StageRouterEditorRemote, createEditorHandlers } from './editor-remote.js'
import { INITIAL_STATE, PROJECTION_KEY, STAGE_COMMAND, parseStageCommand, persistedScheme, stageProjection, type StageRouterState } from './engine/state.js'

export { PROVIDER } from './adapter.js'
export type { StageRouterMessageSource, StageRouterState } from './engine/state.js'

/** Plugin id used for the cordis row and log prefixes. */
export const name = 'stage-router'

export const inject = ['llm', 'sessionProjections']

/**
 * Plugin configuration (the `config` of this plugin's cordis row). Both fields
 * are volatile: the dsh settings service can only read and write volatile
 * fields, and a volatile change applies live (`loader/volatile-update`)
 * instead of restarting the plugin and dropping per-session routers.
 */
export interface Config {
  jev: Volatile<StageRouterConfig['jev']>
  schemes: Volatile<StageRouterConfig['schemes']>
}

export const Config: z<Partial<StageRouterConfig>, Config> = z.object({
  jev: JevSchema.default(DEFAULT_JEV).volatile(),
  schemes: z.array(SchemeSchema).default([]).volatile(),
}) as unknown as z<Partial<StageRouterConfig>, Config>

/** How long a route availability check is trusted. */
const ROUTE_CHECK_TTL_MS = 60_000

interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

const sameRoute = (a: RouteConfig, b: RouteConfig) =>
  a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

function textOf(message: Pick<Message, 'content'>): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

export function apply(ctx: Context, live: Config): void {
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => {
    ctx.logger[level](message, ...args)
  }
  // Current snapshot of the volatile config; every closure below reads these
  // at call time, so a live settings change reaches them after refresh().
  const snapshot = (): StageRouterConfig => ({
    jev: live.jev.get() as StageRouterConfig['jev'],
    schemes: live.schemes.get() as StageRouterConfig['schemes'],
  })
  let config = snapshot()
  let schemes = new Map(config.schemes.map(scheme => [scheme.id, scheme]))
  for (const issue of validateConfig(config)) log('error', 'stage-router: config %s: %s', issue.path, issue.message)

  // ---- virtual provider ----
  const registration = ctx.llm.registerAdapter([PROVIDER], new StageRouterAdapter({
    schemes: () => config.schemes,
    llm: ctx.llm,
    warn: (message, ...args) => log('warn', message, ...args),
  }))

  // ---- durable state ----
  ctx.sessionProjections.register(stageProjection)
  const projection = <T>(session: Session, key: string): T | undefined => {
    try {
      return (ctx.sessionProjections.stateOf as (session: Session, key: string) => T | undefined)(session, key)
    } catch {
      return undefined
    }
  }
  const persisted = (session: Session) => projection<StageRouterState>(session, PROJECTION_KEY) ?? INITIAL_STATE

  // ---- shared services for every session router ----
  const judgeCache = new JudgeCache()
  const decisions = new DecisionLog()
  const judgeLog = new JudgeLog()
  const tierClassifier = new TierClassifier(globalFetch, (message, ...args) => log('debug', message, ...args))
  const routeChecks = new Map<string, { ok: boolean; at: number }>()
  const usable = async (route: RouteConfig): Promise<boolean> => {
    const key = `${route.provider}/${route.model}@${route.reasoningEffort ?? ''}`
    const hit = routeChecks.get(key)
    if (hit !== undefined && Date.now() - hit.at < ROUTE_CHECK_TTL_MS) return hit.ok
    let ok = true
    try {
      await ctx.llm.resolveCallConfig({
        provider: route.provider,
        model: route.model,
        ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as ReasoningEffortId },
      })
    } catch (error) {
      ok = false
      log('error', 'stage-router: model %s unavailable: %s', key, error instanceof Error ? error.message : String(error))
    }
    routeChecks.set(key, { ok, at: Date.now() })
    return ok
  }
  const defaultSelection = (): Selection | undefined => {
    const service = ctx.get('agentDefaultModel' as never) as { currentSelection(): Selection } | undefined
    try {
      return service?.currentSelection()
    } catch {
      return undefined
    }
  }

  // Report unusable models at startup and after each change; routing still falls back per request.
  const checkModels = () => {
    for (const scheme of config.schemes) {
      void checkRoutes(schemeRoutes(scheme, `schemes[${scheme.id}]`), async route => (await usable(route)) ? undefined : 'model unavailable')
        .then(issues => issues.forEach(issue => log('error', 'stage-router: config %s: %s', issue.path, issue.message)))
    }
  }
  ctx.effect(() => {
    checkModels()
    return () => {}
  }, 'stage-router: startup model check')

  // A live settings change: refresh the snapshot, re-list the virtual models
  // and re-check routes. Session routers rebuild lazily from their projection
  // when their scheme object changes.
  // Declared by @deepseek-ai/cordis-plugin-loader, which this package does not import.
  const onLoaderEvent = ctx.on.bind(ctx) as unknown as (name: string, listener: () => void) => () => void
  onLoaderEvent('loader/volatile-update', () => {
    config = snapshot()
    schemes = new Map(config.schemes.map(scheme => [scheme.id, scheme]))
    for (const issue of validateConfig(config)) log('error', 'stage-router: config %s: %s', issue.path, issue.message)
    routeChecks.clear()
    registration.replace([PROVIDER])
    checkModels()
    log('info', 'stage-router: configuration updated (%d scheme(s))', config.schemes.length)
  })

  const routers = new Map<Session, SessionRouter>()
  /** Root agents routed in their current step (set at prompt assembly). */
  const active = new Map<Agent, SessionRouter>()
  /** The latest user message claimed per agent, judged at the next assembly. */
  const claimed = new Map<Agent, UserMessage>()
  /** Route used per (agent, turn, step), so a retried request keeps its model. */
  const stepRoutes = new Map<Agent, { key: string; route: RouteConfig }>()

  const isRoot = (agent: Agent) => agent.session.header.parentSession === undefined

  /**
   * The scheme a root session is routed by, or `undefined`.
   * 1. An explicit pick in the Web picker (`modelSelection.pending`).
   * 2. The plugin's own log facts (a notice, or a stage-router pick).
   * 3. Before the first request: the picker default.
   */
  const schemeFor = (agent: Agent): SchemeConfig | undefined => {
    const pending = projection<{ pending: Selection | null }>(agent.session, 'modelSelection')?.pending ?? null
    let id: string | null = null
    if (pending !== null) id = pending.provider === PROVIDER ? pending.model : null
    else {
      id = persistedScheme(persisted(agent.session))
      if (id === null && agent.session.requestHeader() === undefined) {
        const fallback = defaultSelection()
        if (fallback?.provider === PROVIDER) id = fallback.model
      }
    }
    return id === null ? undefined : schemes.get(id)
  }

  /**
   * Web sessions that run on the picker default have no explicit pick, and the
   * session controller then shows (and selects) the last logged model, which
   * is the real routed one. Record the scheme as the session's explicit pick,
   * the same durable `model/selection` event the picker writes, so the picker
   * keeps showing `stage-router/<scheme>`. Only where that projection exists.
   */
  const pinSelection = (agent: Agent, scheme: SchemeConfig) => {
    const selection = projection<{ pending: Selection | null }>(agent.session, 'modelSelection')
    if (selection === undefined || selection.pending !== null) return
    try {
      const append = agent.session.append.bind(agent.session) as (type: string, data: Selection) => unknown
      append('model/selection', { provider: PROVIDER, model: scheme.id })
    } catch (error) {
      log('warn', 'stage-router: could not record the scheme as the session model: %o', error)
    }
  }

  const routerFor = (agent: Agent, scheme: SchemeConfig): SessionRouter => {
    const existing = routers.get(agent.session)
    if (existing !== undefined && existing.scheme === scheme) return existing
    const router = new SessionRouter(scheme, persisted(agent.session), {
      judge: (input, jev, messageId) => judgeCache.run(
        agent.session.id,
        messageId,
        () => runJudge(globalFetch, jev, input),
      ),
      jev: () => config.jev,
      record: entry => judgeLog.record(agent.session.id, entry),
      usable,
      defaultRoute: () => {
        const fallback = defaultSelection()
        return fallback === undefined || fallback.provider === PROVIDER ? undefined : fallback
      },
      log,
      tiers: tierClassifier,
    })
    routers.set(agent.session, router)
    return router
  }

  /** Plan mode as the next request will see it: a pending selection wins over the logged state. */
  const effectivePlanMode = (agent: Agent): boolean | undefined => {
    const state = ctx.get('planMode')?.get(agent)
    return state === undefined ? undefined : state.pending ?? state.active
  }

  const applyEffect = (agent: Agent, effect: StageEffect | undefined) => {
    if (effect?.planMode === undefined) return
    const planMode = ctx.get('planMode')
    if (planMode === undefined) {
      log('warn', 'stage-router: plan mode service unavailable; ignoring the stage planMode setting')
      return
    }
    planMode.set(agent, effect.planMode)
  }

  // ---- settings editor remote (stageRouter/*) ----
  ctx.plugin(StageRouterEditorRemote, createEditorHandlers({
    current: () => config,
    settings: () => ctx.get('settings'),
    fetch: globalFetch,
    judgeLog: (sessionId, limit) => judgeLog.recent(sessionId, limit),
    usable,
    providers: () => ctx.llm.listProviders(),
    listModels: provider => ctx.llm.listModels(provider),
    resolveModelInfo: (provider, model) => ctx.llm.resolveModelInfo(provider, model),
  }))

  // ---- /stage command: status, log, lock, unlock, per-task tier ----
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: STAGE_COMMAND,
      description: '阶段路由：查看当前阶段（/stage）、最近的路由决策（/stage log），锁定阶段（/stage <阶段 ID>）、'
        + '恢复自动（/stage auto），或指定任务档位（/stage tier T<n> <档位|auto>）',
      input: { hint: '[<阶段 ID> | auto | log | tier T<n> <档位>]' },
      handler: ({ agent, rawInput }) => {
        const scheme = schemeFor(agent)
        if (scheme === undefined) return { kind: 'error', text: '当前会话没有使用阶段路由方案。' }
        const router = routerFor(agent, scheme)
        const command = parseStageCommand(rawInput)
        switch (command.kind) {
          case 'invalid':
            return { kind: 'error', text: command.message }
          case 'status':
            return { kind: 'success', text: router.describe() }
          case 'log': {
            const recent = decisions.recent(agent.session.id, 10)
            if (recent.length === 0) return { kind: 'success', text: '当前进程里还没有路由决策记录。' }
            return {
              kind: 'success',
              text: recent.map(d => `第 ${d.turn} 轮第 ${d.step} 步：${d.stage}${d.tier === null ? '' : ` · ${d.tier}`} → `
                + `${d.route.provider}/${d.route.model}（${d.reason}）`).join('\n'),
            }
          }
          case 'lock': {
            if (command.stage !== null && !scheme.stages.some(stage => stage.id === command.stage)) {
              return { kind: 'error', text: `没有阶段「${command.stage}」。可用阶段：${scheme.stages.map(stage => stage.id).join('、')}。` }
            }
            applyEffect(agent, router.setLock(command.stage))
            log('info', 'stage-router: %s %s', agent.session.id, command.stage === null ? 'unlocked' : `locked to ${command.stage}`)
            return { kind: 'success', text: command.stage === null ? '已恢复自动路由。' : `已锁定到阶段「${scheme.stages.find(stage => stage.id === command.stage)?.name || command.stage}」。` }
          }
          case 'tier': {
            const known = new Set(scheme.stages.flatMap(stage => stage.tiers?.levels.map(level => level.id) ?? []))
            if (command.tier !== null && !known.has(command.tier)) {
              return { kind: 'error', text: `没有档位「${command.tier}」。可用档位：${[...known].join('、') || '（未配置）'}。` }
            }
            router.setTierOverride(command.task, command.tier)
            return { kind: 'success', text: command.tier === null ? `任务 T${command.task} 已恢复自动定档。` : `任务 T${command.task} 已指定为 ${command.tier} 档。` }
          }
        }
      },
    })
  })

  // ---- stage prompt ----
  let systemPrompt: SystemPrompt | undefined
  const STAGE_SECTION = 'stage-router:stage'
  const stagePrompt = (agent: Agent) => active.get(agent)?.stageConfig?.prompt ?? ''
  ctx.inject(['systemPrompt'], promptCtx => {
    systemPrompt = promptCtx.systemPrompt
    promptCtx.effect(() => () => { systemPrompt = undefined }, 'stage-router: forget system prompt service')
    promptCtx.systemPrompt.section({
      name: STAGE_SECTION,
      order: promptCtx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => context.agent === undefined ? '' : stagePrompt(context.agent),
    })
  })

  // ---- plan approval signal (prepended so a host answerer cannot hide it) ----
  ctx.on('user-questions/request', async (request, next) => {
    const answer = await next()
    const agent = (request as { agent?: Agent }).agent
    if (agent !== undefined && request.questions.some(question => question.id === 'plan-review')) {
      routers.get(agent.session)?.markPlanReview()
    }
    return answer
  }, { prepend: true })

  // `agent/inbox/claimed` is not awaited, so only remember the message here.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    if (isRoot(agent)) claimed.set(agent, message)
    // A subagent's first user message is its task (first text block: the
    // continuable driver appends its own guidance as a second block).
    else if (!childTasks.has(agent)) {
      const first = message.content.find(block => block.type === 'text')
      childTasks.set(agent, first?.type === 'text' ? first.text : '')
    }
  })

  // ---- subagents (design §3; only when the scheme enables them) ----
  const childTasks = new Map<Agent, string>()
  /** Route decided at a child's first request; `null` = leave it alone. */
  const childRoutes = new Map<Agent, RouteConfig | null>()
  ctx.on('agent/disposed', ({ agent }) => {
    childTasks.delete(agent)
    childRoutes.delete(agent)
  })

  const decideChild = async (agent: Agent, call: LlmCallConfig): Promise<RouteConfig | undefined> => {
    const header = agent.session.header
    if (header.origin !== 'subagent' || header.parentSession === undefined) return undefined
    const parentAgent = ctx.get('agents')?.get(header.parentSession)
    const parentRouter = parentAgent === undefined ? undefined : active.get(parentAgent)
    if (parentAgent === undefined || parentRouter === undefined) return undefined
    const descriptor = agent.session.ownEvents().find(event => event.type === ('subagent/descriptor' as never))
      ?.data as { provider?: string; label?: string } | undefined
    const decided = await routeChild({
      fork: header.isSeeded || descriptor?.provider === 'fork',
      config: {
        provider: call.provider,
        model: call.model,
        ...call.reasoningEffort === undefined ? {} : { reasoningEffort: String(call.reasoningEffort) },
      },
      task: childTasks.get(agent) ?? '',
      ...descriptor?.label === undefined ? {} : { label: descriptor.label },
    }, {
      scheme: parentRouter.scheme,
      stage: parentRouter.stage,
      route: parentRouter.route,
      todos: projection<TodoLike[] | null>(parentAgent.session, 'todos'),
    }, {
      tiers: tierClassifier,
      jev: config.jev,
      record: entry => judgeLog.record(parentAgent.session.id, entry),
      usable,
    })
    if (decided !== undefined) {
      log('info', 'stage-router: subagent %s → %s/%s (stage %s%s, %s)', agent.session.id, decided.route.provider,
        decided.route.model, decided.stage, decided.tier === undefined ? '' : ` · ${decided.tier}`, decided.reason)
    }
    return decided?.route
  }

  ctx.on('agent/created', ({ agent }) => {
    if (!isRoot(agent)) return

    // Decide the stage in the first awaited hook of a step. dsh resolves
    // section texts before this waterfall runs, so when the decision changes
    // what the prompt should say (stage prompt, plan mode) the listener
    // assembles once more, with itself stepping aside.
    let reassembling = false
    const disposeAssemble = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      if (context.agent !== agent || reassembling) return next()
      const scheme = schemeFor(agent)
      if (scheme === undefined) {
        active.delete(agent)
        claimed.delete(agent)
        return next()
      }
      const router = routerFor(agent, scheme)
      active.set(agent, router)
      pinSelection(agent, scheme)
      const planBefore = effectivePlanMode(agent)
      const observePlan = () => {
        const planActive = effectivePlanMode(agent)
        if (planActive === undefined) return
        const trigger = router.observePlanMode(planActive)
        if (trigger !== undefined) applyEffect(agent, router.onTrigger(trigger))
      }
      observePlan()
      const todos = projection<TodoLike[] | null>(agent.session, 'todos')
      if (router.observeTodos(todos)) applyEffect(agent, router.onTrigger('todos_done'))
      const message = claimed.get(agent)
      if (message !== undefined) {
        claimed.delete(agent)
        applyEffect(agent, await router.onUserMessage({
          messageId: message.id,
          text: textOf(message),
          recent: summarizeRecent(agent.session.deriveMessages(), config.jev.contextTurns),
        }))
      }
      // Swallow the plan-mode switch this router just asked for.
      observePlan()
      router.classifyTodos(todos)
      await router.resolveRoute(todos)
      const resolvedPrompt = assembly.sections.find(section => section.name === STAGE_SECTION)?.text ?? ''
      const stale = resolvedPrompt !== stagePrompt(agent) || effectivePlanMode(agent) !== planBefore
      if (!stale || systemPrompt === undefined) return next()
      reassembling = true
      try {
        return await systemPrompt.assemble(context)
      } finally {
        reassembling = false
      }
    }, { prepend: true })

    // Filter dsh's model-change notice and announce stage changes.
    const disposePreStep = ctx.on('agent/pre-step', async ({ agent: current, messages, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const router = current === agent ? active.get(agent) : undefined
      if (router === undefined || decision.kind === 'reject') return decision
      const kept = decision.messages.filter(message => message.source.kind !== 'model-selection')
      // Mirror model-selection: never turn an empty first step (or an emptied continuation) into a request.
      if (kept.length === 0 && (step === 1 || messages.length > 0)) return { ...decision, messages: kept }
      const notice = router.takeNotice()
      return { ...decision, messages: notice === undefined ? kept : [...kept, notice] }
    }, { prepend: true })

    ctx.on('agent/disposed', ({ agent: gone }) => {
      if (gone !== agent) return
      disposeAssemble()
      disposePreStep()
      active.delete(agent)
      claimed.delete(agent)
      stepRoutes.delete(agent)
      routers.delete(agent.session)
    })
  })

  // ---- request rewrite: the logged header records the real model ----
  ctx.on('agent/request', async ({ agent, turn, step }, next): Promise<LlmCallConfig> => {
    const config = await next()
    const key = `${turn}:${step}`
    const cached = stepRoutes.get(agent)
    let route: RouteConfig | undefined
    if (cached?.key === key) route = cached.route
    else {
      const router = active.get(agent)
      let child = childRoutes.get(agent)
      if (router === undefined && child === undefined && agent.session.header.origin === 'subagent') {
        child = (await decideChild(agent, config)) ?? null
        childRoutes.set(agent, child)
      }
      if (router !== undefined) {
        route = router.route
      } else if (child != null) {
        route = child
      } else if (config.provider === PROVIDER) {
        // Not routed by a stage (subagent, unknown scheme): follow the parent's
        // current route, else the scheme's initial stage.
        const parent = agent.session.header.parentSession
        const parentRouter = parent === undefined ? undefined : [...routers.entries()].find(([session]) => session.id === parent)?.[1]
        const scheme = schemes.get(config.model)
        route = parentRouter?.route ?? (scheme === undefined ? undefined : initialRoute(scheme))
      }
      if (route !== undefined) {
        stepRoutes.set(agent, { key, route })
        const source = router ?? undefined
        decisions.record(agent.session.id, {
          at: Date.now(),
          turn,
          step,
          stage: source?.stage ?? '(subagent)',
          tier: source?.tier ?? null,
          route,
          reason: source?.lastReason ?? (child != null ? '子 agent' : '虚拟模型兜底'),
          lock: source?.lock ?? null,
          judge: source?.lastJudgement ?? null,
        })
      }
    }
    if (route === undefined) return config
    if (config.provider !== PROVIDER && sameRoute(config as RouteConfig, route)) return config
    const { reasoningEffort: _virtualEffort, ...rest } = config
    log('debug', 'stage-router: turn %d step %d → %s/%s', turn, step, route.provider, route.model)
    return {
      ...rest,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as ReasoningEffortId },
    }
  }, { prepend: true })
}
