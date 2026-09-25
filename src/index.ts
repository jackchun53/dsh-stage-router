import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, Message, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import type z from '@deepseek-ai/schemastery'
import { PROVIDER, StageRouterAdapter, initialRoute } from './adapter.js'
import { ConfigSchema, effectiveJudge, type RouteConfig, type SchemeConfig, type StageRouterConfig } from './config/schema.js'
import { checkRoutes, schemeRoutes, validateConfig } from './config/validate.js'
import { JudgeCache, runJudge, summarizeRecent } from './engine/judge.js'
import { SessionRouter, type StageEffect } from './engine/session-router.js'
import { INITIAL_STATE, PROJECTION_KEY, persistedScheme, stageProjection, type StageRouterState } from './engine/state.js'

export { PROVIDER } from './adapter.js'
export type { StageRouterMessageSource, StageRouterState } from './engine/state.js'

/** Plugin id used for the cordis row and log prefixes. */
export const name = 'stage-router'

export const inject = ['llm', 'sessionProjections']

/** Plugin configuration (the `config` of this plugin's cordis row). */
export type Config = StageRouterConfig

export const Config: z<Config> = ConfigSchema

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

export function apply(ctx: Context, config: Config): void {
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => {
    ctx.logger[level](message, ...args)
  }
  for (const issue of validateConfig(config)) log('error', 'stage-router: config %s: %s', issue.path, issue.message)
  const schemes = new Map(config.schemes.map(scheme => [scheme.id, scheme]))

  // ---- virtual provider ----
  ctx.llm.registerAdapter([PROVIDER], new StageRouterAdapter({
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

  // Report unusable models once at startup; routing still falls back per request.
  ctx.effect(() => {
    for (const scheme of config.schemes) {
      void checkRoutes(schemeRoutes(scheme, `schemes[${scheme.id}]`), async route => (await usable(route)) ? undefined : 'model unavailable')
        .then(issues => issues.forEach(issue => log('error', 'stage-router: config %s: %s', issue.path, issue.message)))
    }
    return () => {}
  }, 'stage-router: startup model check')

  const routers = new Map<Session, SessionRouter>()
  /** Agents whose current step was routed by the pre-step hook, keyed to that step. */
  const routedStep = new Map<Agent, { turn: number; step: number }>()
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

  const routerFor = (agent: Agent, scheme: SchemeConfig): SessionRouter => {
    const existing = routers.get(agent.session)
    if (existing !== undefined && existing.scheme === scheme) return existing
    const router = new SessionRouter(scheme, persisted(agent.session), {
      judge: (input, judgeConfig, messageId) => judgeCache.run(
        agent.session.id,
        messageId,
        () => runJudge(options => ctx.llm.stream(options), judgeConfig, input),
      ),
      judgeConfig: s => effectiveJudge(config.defaultJudge, s),
      usable,
      defaultRoute: () => {
        const fallback = defaultSelection()
        return fallback === undefined || fallback.provider === PROVIDER ? undefined : fallback
      },
      log,
    })
    routers.set(agent.session, router)
    return router
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

  // ---- stage prompt ----
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.section({
      name: 'stage-router:stage',
      order: promptCtx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => {
        const agent = context.agent
        if (agent === undefined || !routedStep.has(agent)) return ''
        const prompt = routers.get(agent.session)?.stageConfig?.prompt
        return prompt === undefined || prompt === '' ? '' : prompt
      },
    })
  })

  // ---- plan approval signal ----
  ctx.on('user-questions/request', async (request, next) => {
    const answer = await next()
    const agent = (request as { agent?: Agent }).agent
    const reviewed = request.questions.some(question => question.id === 'plan-review')
    if (agent !== undefined && reviewed) routers.get(agent.session)?.markPlanReview()
    return answer
  })

  // ---- per-agent pre-step: decide stage, filter dsh's model notice, announce ----
  ctx.on('agent/created', ({ agent }) => {
    if (!isRoot(agent)) return
    const dispose = ctx.on('agent/pre-step', async ({ agent: current, messages, step, turn }, next): Promise<PreStepDecision> => {
      if (current !== agent) return next()
      const scheme = schemeFor(agent)
      if (scheme === undefined) {
        routedStep.delete(agent)
        return next()
      }
      const router = routerFor(agent, scheme)
      const planMode = ctx.get('planMode')
      const observePlan = () => {
        if (planMode === undefined) return
        const trigger = router.observePlanMode(planMode.get(agent).active)
        if (trigger !== undefined) applyEffect(agent, router.onTrigger(trigger))
      }
      observePlan()
      const userMessage = messages.find(message => message.source.kind === 'user')
      if (userMessage !== undefined) {
        const judgeConfig = effectiveJudge(config.defaultJudge, scheme)
        applyEffect(agent, await router.onUserMessage({
          messageId: userMessage.id,
          text: textOf(userMessage),
          recent: summarizeRecent(agent.session.deriveMessages(), judgeConfig.contextTurns),
        }))
      }

      const decision = await next()
      if (decision.kind === 'reject') return decision

      observePlan()
      if (router.observeTodos(projection(agent.session, 'todos'))) applyEffect(agent, router.onTrigger('todos_done'))
      await router.resolveRoute()
      routedStep.set(agent, { turn, step })

      const kept = decision.messages.filter(message => message.source.kind !== 'model-selection')
      // Mirror model-selection: never turn an empty first step (or an emptied continuation) into a request.
      if (kept.length === 0 && (step === 1 || messages.length > 0)) return { ...decision, messages: kept }
      const notice = router.takeNotice()
      return { ...decision, messages: notice === undefined ? kept : [...kept, notice] }
    }, { prepend: true })
    ctx.on('agent/disposed', ({ agent: gone }) => {
      if (gone !== agent) return
      dispose()
      routedStep.delete(agent)
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
      const marked = routedStep.get(agent)
      if (marked !== undefined && marked.turn === turn && marked.step === step) {
        route = routers.get(agent.session)?.route
      } else if (config.provider === PROVIDER) {
        // Not routed by a stage (subagent, unknown scheme): follow the parent's
        // current route, else the scheme's initial stage.
        const parent = agent.session.header.parentSession
        const parentRouter = parent === undefined ? undefined : [...routers.entries()].find(([session]) => session.id === parent)?.[1]
        const scheme = schemes.get(config.model)
        route = parentRouter?.route ?? (scheme === undefined ? undefined : initialRoute(scheme))
      }
      if (route !== undefined) stepRoutes.set(agent, { key, route })
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
