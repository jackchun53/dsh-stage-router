// Phase 0 spike plugin for dsh 0.1.7-rc.2. Registers:
// - a keyless `fake` provider that plays scripted replies and logs every request;
// - a virtual `stage-router` provider (model `spike`);
// - the probes for spikes 1–6 (see docs/superpowers/plans/2026-09-25-phase0-spikes.md).
// Every observation goes to the JSONL file named by SPIKE_LOG.
import { appendFileSync } from 'node:fs'
import { z } from 'zod'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'

const LOG = process.env.SPIKE_LOG ?? 'spike.log.jsonl'
// SPIKE_REQUEST_SCOPE: 'root-prepend' (default) | 'root-append' | 'none'
const REQUEST_SCOPE = process.env.SPIKE_REQUEST_SCOPE ?? 'root-prepend'
// SPIKE_FILTER=0 disables the model-selection notice filter (control run).
const FILTER = process.env.SPIKE_FILTER !== '0'

const log = (probe, data) => appendFileSync(LOG, JSON.stringify({ probe, ...data }) + '\n')

const textOf = message => (message?.content ?? [])
  .filter(block => block.type === 'text').map(block => block.text).join('')

function* text(reply) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCall(name, args) {
  const id = ToolCallId(`spike-${name}-${Date.now()}`)
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Keyless provider: scripted by keywords in the latest real user message. */
class FakeAdapter extends LlmAdapter {
  async listModels() {
    return ['real-plan', 'real-code', 'real-review', 'real-default'].map(id => ({ provider: 'fake', id, name: id }))
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const users = messages.filter(m => m.role === 'user')
    const lastUser = [...users].reverse().find(m => m.source?.kind === 'user')
    const last = messages.at(-1)
    log('fake-request', {
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sessionId: options.sessionId,
      lastRole: last?.role,
      userSourceKinds: users.map(m => m.source?.kind),
      modelSelectionNotices: users.filter(m => m.source?.kind === 'model-selection').map(textOf),
      stagePrompt: /STAGE_PROMPT\((\w+)\)/.exec(JSON.stringify([options.system ?? null, messages.filter(m => m.role === 'system')]))?.[1] ?? null,
      systemShape: { systemType: typeof options.system, systemMessages: messages.filter(m => m.role === 'system').length },
    })
    const prompt = textOf(lastUser)
    if (last?.role !== 'tool') {
      if (prompt.includes('TODO')) return yield * toolCall('todo_write', { todos: [{ content: '[T1][light] spike task', status: 'completed' }] })
      if (prompt.includes('EXITPLAN')) return yield * toolCall('exit_plan_mode', { plan: '# Spike plan\n\n1. do it' })
    }
    yield * text(`fake reply from ${options.provider}/${options.model}`)
  }
}

/** Virtual provider: normally never streamed, because agent/request rewrites the route. */
class VirtualAdapter extends LlmAdapter {
  constructor(ctx) { super(); this.ctx = ctx }
  async listModels() { return [{ provider: 'stage-router', id: 'spike', name: 'stage-router/spike' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: `stage-router/${model}`, inputModalities: ['text', 'image'] }
  }

  async * stream(options) {
    log('virtual-stream-called', { model: options.model })
    yield * this.ctx.llm.stream({ ...options, provider: 'fake', model: 'real-default' })
  }
}

const stageSource = (stage, reason) => ({
  kind: 'stage-router',
  form: 'notice',
  summary: `stage → ${stage}`,
  stage,
  reason,
})

// Per-session live state (lost on reload; the projection must rebuild it).
const live = new Map()

export const name = 'stage-router-spike'
export const inject = ['llm', 'sessionProjections']

export function apply(ctx) {
  ctx.llm.registerAdapter(['fake'], new FakeAdapter())
  ctx.llm.registerAdapter(['stage-router'], new VirtualAdapter(ctx))

  // Spike 3: projection folding stage-router notices out of user/message events.
  const stateSchema = z.object({ stage: z.string().nullable(), notices: z.number() })
  ctx.sessionProjections.register({
    key: 'stage-router',
    stateSchema,
    init: () => ({ stage: null, notices: 0 }),
    apply: (state, event) => {
      if (event.type !== 'user/message' || event.data?.source?.kind !== 'stage-router') return state
      return { stage: event.data.source.stage, notices: state.notices + 1 }
    },
    stateVersion: 1,
  })

  // Spike 6: what the virtual model reports for image input.
  ctx.effect(() => {
    // Same check as api/session-controller/src/commands.ts:336-345.
    Promise.resolve(ctx.llm.resolveModelInfo('stage-router', 'spike'))
      .then(info => log('virtual-model-info', {
        inputModalities: info?.inputModalities ?? null,
        imagePromptAdmitted: info?.inputModalities === undefined || info.inputModalities.includes('image'),
      }))
      .catch(error => log('virtual-model-info', { error: String(error) }))
    return () => {}
  })

  // Plan review has no answerer in headless: approve it (spike 4).
  ctx.on('user-questions/request', async (request, next) => {
    const question = request.questions?.[0]
    log('user-question', { id: question?.id, intent: request.intent })
    if (request.intent?.kind === 'plan-review' || question?.id === 'plan-review') {
      const option = question?.options?.[0]
      return { answers: [{ id: question.id, selected: [option?.id ?? option?.label ?? 'Approve'] }] }
    }
    return next()
  })

  // Spike 4/5 + stage decision on inbox claim.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const prompt = textOf(message)
    const session = agent.session
    let restored = null
    try { restored = ctx.sessionProjections.stateOf(session, 'stage-router') } catch (error) { restored = { error: String(error) } }
    let selection = null
    try { selection = ctx.sessionProjections.stateOf(session, 'modelSelection') } catch (error) { selection = { error: String(error) } }
    const stage = /STAGE=(\w+)/.exec(prompt)?.[1] ?? restored?.stage ?? 'default'
    live.set(session.id ?? session, { stage, announced: restored?.stage ?? null })
    const entry = { turn, prompt, restored, modelSelection: selection, stage }
    if (prompt.includes('PLANON')) {
      const planMode = ctx.get('planMode')
      entry.planModeService = planMode !== undefined
      if (planMode !== undefined) {
        entry.planModeSet = planMode.set(agent, true)
        entry.planModeAfterSet = planMode.get(agent)
      }
    }
    log('inbox-claimed', entry)
    if (prompt.includes('CMD')) {
      const commands = ctx.get('commands')
      log('command-service', { present: commands !== undefined })
      if (commands !== undefined) {
        Promise.resolve().then(() => commands.execute(agent, '/stage code', [], new AbortController().signal))
          .then(result => log('command-result', { result }))
          .catch(error => log('command-result', { error: String(error) }))
      }
    }
  })

  // Stage prompt section (design §1): order is required in 0.1.7.
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.systemPrompt.section({
      name: 'stage-router:stage',
      order: promptCtx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => {
        if (context.agent === undefined) return ''
        const state = live.get(context.agent.session.id ?? context.agent.session)
        return state === undefined ? '' : `STAGE_PROMPT(${state.stage})`
      },
    })
    log('prompt-section-registered', { ok: true })
  })

  // Spike 5: register /stage.
  ctx.inject(['commands'], commandCtx => {
    try {
      commandCtx.commands.register({
        name: 'stage',
        description: 'Spike: lock the stage',
        input: { hint: '<id>|auto' },
        handler: async ({ rawInput }) => {
          log('command-handler', { rawInput })
          return { kind: 'success', text: `stage locked: ${rawInput}` }
        },
      })
      log('command-registered', { ok: true })
    } catch (error) {
      log('command-registered', { ok: false, error: String(error) })
    }
  })

  // Spike 1: rewrite the virtual route to the real stage model.
  if (REQUEST_SCOPE !== 'none') {
    ctx.on('agent/request', async ({ agent, step }, next) => {
      const config = await next()
      const state = live.get(agent.session.id ?? agent.session)
      if (config.provider !== 'stage-router') {
        log('request-hook', { step, saw: `${config.provider}/${config.model}`, rewritten: false })
        return config
      }
      const model = `real-${state?.stage ?? 'default'}`
      log('request-hook', { step, saw: `${config.provider}/${config.model}`, rewritten: `fake/${model}` })
      return { ...config, provider: 'fake', model }
    }, { prepend: REQUEST_SCOPE === 'root-prepend' })
  }

  // Spike 2 + 3 + 4: per-agent prepended pre-step.
  ctx.on('agent/created', ({ agent }) => {
    const dispose = ctx.on('agent/pre-step', async ({ agent: a, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const dropped = decision.messages.filter(m => m.source?.kind === 'model-selection')
      let messages = FILTER ? decision.messages.filter(m => m.source?.kind !== 'model-selection') : decision.messages
      const state = live.get(a.session.id ?? a.session)
      if (state !== undefined && state.stage !== state.announced) {
        messages = [...messages, createUserMessage({
          content: [{ type: 'text', text: `[stage-router: now in stage ${state.stage}]` }],
          source: stageSource(state.stage, 'spike'),
        })]
        state.announced = state.stage
      }
      const planMode = ctx.get('planMode')
      log('pre-step', {
        step,
        droppedModelSelectionNotices: dropped.length,
        filter: FILTER,
        planMode: planMode?.get(a),
        sourceKinds: messages.map(m => m.source?.kind),
      })
      return { ...decision, messages }
    }, { prepend: true })
    ctx.on('agent/disposed', ({ agent: gone }) => { if (gone === agent) dispose() })
  })
}
