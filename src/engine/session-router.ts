import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { JudgeConfig, RouteConfig, SchemeConfig, StageConfig, TransitionEvent } from '../config/schema.js'
import type { JudgeInput, TimedJudgement } from './judge.js'
import { pickTier, type TierClassifier, type TodoLike } from './tiers.js'
import { stageNotice, type JudgeRecord, type StageRouterState } from './state.js'
import { applyJudgement, decide, type Decision, type MachineState } from './transitions.js'

/** Host services one session's router needs; the plugin wires them to dsh. */
export interface RouterDeps {
  /** Judge one message; the plugin caches by (session, message). */
  judge(input: JudgeInput, config: JudgeConfig, messageId: string): Promise<TimedJudgement>
  judgeConfig(scheme: SchemeConfig): JudgeConfig
  /** Whether a route resolves to a usable model (cached by the plugin). */
  usable(route: RouteConfig): Promise<boolean>
  /** Picker default outside stage-router, used as the last fallback. */
  defaultRoute(): RouteConfig | undefined
  /** Shared tier classifier (judge-backed, cached by todo text). */
  tiers: Pick<TierClassifier, 'classify' | 'lookup'>
  /** Longest wait for pending tier judgements (default 1.5 s). */
  tierWaitMs?: number
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void
}

export interface UserTurn {
  messageId: string
  text: string
  /** Pre-rendered recent conversation for the judge. */
  recent: string
}

/** What the caller must do after a stage change. */
export interface StageEffect {
  /** `true`/`false`: set plan mode; `undefined`: leave it alone. */
  planMode: boolean | undefined
}

const routeKey = (route: RouteConfig | undefined) => route === undefined
  ? '-'
  : `${route.provider}/${route.model}@${route.reasoningEffort ?? ''}`

/**
 * Routing runtime for one session under one scheme. Seeded from the folded
 * projection so a reloaded session resumes its stage; everything it decides
 * becomes durable through the notice it hands back from {@link takeNotice}.
 */
export class SessionRouter {
  stage: string | null
  tier: string | undefined
  lock: string | null
  route: RouteConfig | undefined
  private reason = 'resume'
  private judgement: JudgeRecord | undefined
  private announced: { stage: string | null; tier: string | undefined; lock: string | null; route: string }
  /** Plan-mode state seen at the end of the last pre-step; `undefined` until observed. */
  private planActive: boolean | undefined
  /** Plan-mode value this router asked for, so its own switch is not read back as a trigger. */
  private expectedPlan: boolean | undefined
  /** A `plan-review` question was answered since plan mode was last seen on. */
  private reviewed = false
  private todosFired: string | undefined

  constructor(
    readonly scheme: SchemeConfig,
    persisted: StageRouterState,
    private readonly deps: RouterDeps,
  ) {
    const known = (id: string | null) => id !== null && scheme.stages.some(stage => stage.id === id)
    const sameScheme = persisted.scheme === scheme.id
    this.stage = sameScheme && known(persisted.stage) ? persisted.stage : null
    this.lock = sameScheme && known(persisted.lock) ? persisted.lock : null
    this.route = sameScheme && persisted.route !== null ? persisted.route : undefined
    this.tier = sameScheme && persisted.tier !== null ? persisted.tier : undefined
    this.announced = { stage: this.stage, tier: this.tier, lock: this.lock, route: routeKey(this.route) }
  }

  /** Why the router is in its current stage. */
  get lastReason(): string {
    return this.reason
  }

  /** The judgement behind the latest user-message decision, if the judge ran. */
  get lastJudgement(): JudgeRecord | undefined {
    return this.judgement
  }

  /** One-line status for `/stage` and logs. */
  describe(): string {
    const stage = this.stageConfig
    const parts = [
      `stage ${this.stage ?? '(none yet)'}${stage?.name ? ` (${stage.name})` : ''}`,
      ...this.tier === undefined ? [] : [`tier ${this.tier}`],
      ...this.route === undefined ? [] : [`model ${this.route.provider}/${this.route.model}`],
      this.lock === null ? 'automatic' : `locked to ${this.lock}`,
    ]
    return `${parts.join(' · ')}. Stages: ${this.scheme.stages.map(s => s.id).join(', ')}.`
  }

  get stageConfig(): StageConfig | undefined {
    return this.scheme.stages.find(stage => stage.id === this.stage)
  }

  private get machine(): MachineState {
    return { stage: this.stage, lock: this.lock }
  }

  /** Run the `user_message` rules (and the judge when they leave several candidates). */
  async onUserMessage(turn: UserTurn): Promise<StageEffect | undefined> {
    const decision = decide(this.machine, 'user_message', this.scheme)
    if (decision.kind !== 'judge') {
      this.judgement = undefined
      return this.apply(decision)
    }
    const config = this.deps.judgeConfig(this.scheme)
    const candidates = decision.candidates
    const byId = new Map(this.scheme.stages.map(stage => [stage.id, stage]))
    const result = await this.deps.judge({
      current: this.stage,
      candidates: candidates.map(id => ({ id, description: byId.get(id)?.description ?? '' })),
      recent: turn.recent,
      message: turn.text,
    }, config, turn.messageId)
    this.judgement = result.ok
      ? { ok: true, stage: result.stage, confidence: result.confidence, reason: result.reason, elapsedMs: result.elapsedMs }
      : { ok: false, error: result.error, elapsedMs: result.elapsedMs }
    if (!result.ok) this.deps.log('warn', 'stage-router: judge failed (%s), staying in %s', result.error, this.stage ?? 'initial stage')
    return this.apply(applyJudgement(this.machine, result, candidates, config.minConfidence, this.scheme.initialStage))
  }

  /** Apply a non-message trigger (`plan_mode_on`, `plan_approved`, `todos_done`, …). */
  onTrigger(event: Exclude<TransitionEvent, 'user_message'>): StageEffect | undefined {
    return this.apply(decide(this.machine, event, this.scheme))
  }

  /** Lock to a stage (`null` = automatic routing again). */
  setLock(stage: string | null): StageEffect | undefined {
    if (stage !== null && !this.scheme.stages.some(s => s.id === stage)) throw new Error(`unknown stage "${stage}"`)
    this.lock = stage
    this.reason = stage === null ? 'unlocked' : 'locked'
    return stage === null || stage === this.stage ? undefined : this.enter(stage)
  }

  /** Record that a plan-review question was answered (the approval path of `exit_plan_mode`). */
  markPlanReview(): void {
    this.reviewed = true
  }

  /**
   * Turn an observed plan-mode value into a trigger. Changes this router
   * requested itself are swallowed; off after a plan review is an approval.
   */
  observePlanMode(active: boolean): Exclude<TransitionEvent, 'user_message'> | undefined {
    const previous = this.planActive
    this.planActive = active
    if (previous === undefined || previous === active) return undefined
    if (this.expectedPlan === active) {
      this.expectedPlan = undefined
      return undefined
    }
    this.expectedPlan = undefined
    if (active) {
      this.reviewed = false
      return 'plan_mode_on'
    }
    const approved = this.reviewed
    this.reviewed = false
    return approved ? 'plan_approved' : 'plan_mode_off'
  }

  /**
   * Fire `todos_done` once per completed checklist.
   * @param todos - the session's `todos` projection value.
   */
  observeTodos(todos: readonly { content: string; status: string }[] | null | undefined): boolean {
    if (todos == null || todos.length === 0) return false
    if (!todos.every(todo => todo.status === 'completed')) {
      this.todosFired = undefined
      return false
    }
    const signature = todos.map(todo => todo.content).join('\u0000')
    if (signature === this.todosFired) return false
    this.todosFired = signature
    return true
  }

  private apply(decision: Decision): StageEffect | undefined {
    if (decision.kind === 'judge') return undefined
    this.reason = decision.reason
    if (decision.kind === 'stay') {
      this.deps.log('debug', 'stage-router: stay in %s (%s)', this.stage, decision.reason)
      return undefined
    }
    return this.enter(decision.stage)
  }

  private enter(stage: string): StageEffect {
    const from = this.stage
    this.stage = stage
    const action = this.stageConfig?.planMode ?? 'keep'
    const planMode = action === 'enter' ? true : action === 'exit' ? false : undefined
    if (planMode !== undefined && planMode !== this.planActive) this.expectedPlan = planMode
    this.deps.log('info', 'stage-router: %s → %s (%s)', from ?? '-', stage, this.reason)
    return { planMode }
  }

  /** Start tier judgements for the current stage's todos (cached; returns at once). */
  classifyTodos(todos: readonly TodoLike[] | null | undefined): void {
    const stage = this.stageConfig
    if (stage === undefined || todos == null || todos.length === 0) return
    this.deps.tiers.classify(stage, todos.map(todo => todo.content), this.deps.judgeConfig(this.scheme))
  }

  /**
   * Resolve the model for the current stage with the design's fallback chain:
   * tier route → stage route → initial stage route → picker default.
   * @param todos - the session's todos; the heaviest in-progress one picks the tier.
   */
  async resolveRoute(todos?: readonly TodoLike[] | null): Promise<RouteConfig | undefined> {
    if (this.stage === null) this.stage = this.scheme.initialStage
    const stage = this.stageConfig
    const pick = stage === undefined ? undefined : await pickTier(stage, todos, this.deps.tiers, this.deps.tierWaitMs)
    this.tier = pick?.tier
    const tierRoute = pick === undefined ? undefined : stage?.tiers?.levels.find(level => level.id === pick.tier)?.route
    if (pick !== undefined) this.deps.log('debug', 'stage-router: stage %s tier %s (%s)', this.stage, pick.tier, pick.reason)
    const initial = this.scheme.stages.find(s => s.id === this.scheme.initialStage)?.route
    const chain = [tierRoute, stage?.route, initial, this.deps.defaultRoute()]
      .filter((route): route is RouteConfig => route !== undefined)
    for (const [index, route] of chain.entries()) {
      if (await this.deps.usable(route)) {
        if (index > 0) this.deps.log('error', 'stage-router: stage %s model %s unavailable, falling back to %s', this.stage, routeKey(chain[0]), routeKey(route))
        this.route = route
        return route
      }
    }
    this.deps.log('error', 'stage-router: no usable model for stage %s', this.stage)
    this.route = chain[0]
    return this.route
  }

  /** A notice when stage, lock or model changed since the last one; `undefined` otherwise. */
  takeNotice(): UserMessage | undefined {
    if (this.stage === null || this.route === undefined) return undefined
    const current = { stage: this.stage, tier: this.tier, lock: this.lock, route: routeKey(this.route) }
    const previous = this.announced
    if (previous.stage === current.stage && previous.tier === current.tier
      && previous.lock === current.lock && previous.route === current.route) return undefined
    this.announced = current
    return stageNotice({
      stageName: this.stageConfig?.name || this.stage,
      scheme: this.scheme.id,
      stage: this.stage,
      ...this.tier === undefined ? {} : { tier: this.tier },
      from: previous.stage,
      route: this.route,
      reason: this.reason,
      lock: this.lock,
      ...this.judgement === undefined ? {} : { judge: this.judgement },
    })
  }
}
