// Integration fixture: a keyless `fake` provider, a fake Jev behind
// http://fake-jev.invalid (a `fetch` interceptor in this process) and a
// plan-review answerer. Every model request and Jev call is appended to
// FAKE_LLM_LOG as one JSON line (Jev calls as kind "judge").
//
// Scripting (keywords in the latest real user message):
//   JUDGE=<stage>[@<confidence>]  Jev picks that stage (default confidence 0.9)
//   JUDGE=garbage                 Jev answers a body without answers
//   JUDGE=slow                    Jev never answers (hits the timeout)
//   TODO                          assistant calls todo_write with one completed item
//   EXITPLAN                      assistant calls exit_plan_mode
//   TIERS1                        todo_write: "[T1][light] small fix" in progress, "big refactor" pending
//   TIERS2                        todo_write: both of the above in progress
//   SPAWN                         spawn a foreground subagent with the task "CHILD big job"
//   FORK                          fork a subagent with the task "CHILD review it"
// Subagent requests (task starts with CHILD) just answer with text.
//   CMD=<args>                    the fixture runs `/stage <args>` when the message is claimed
//                                 (underscores become spaces: CMD=tier_T1_heavy)
//                                 (headless never parses slash commands itself)
// Jev tier questions (state.tasks) answer heavy for tasks containing "big",
// light otherwise.
import { appendFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

const LOG = process.env.FAKE_LLM_LOG

const textOf = message => (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')

function* text(reply) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: reply }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCall(name, args) {
  const id = ToolCallId(`fake-${name}-${Date.now()}`)
  const json = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class FakeAdapter extends LlmAdapter {
  async listModels(provider) {
    return ['m-plan', 'm-code', 'm-review', 'm-judge', 'm-light', 'm-heavy'].map(id => ({ provider, id, name: id }))
  }

  async resolveModel(provider, model) {
    if (model === 'm-missing') throw new Error(`fake: unknown model ${model}`)
    return {
      provider, id: model, name: model, inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
    }
  }

  async * stream(options) {
    const messages = options.messages ?? []
    const lastUser = [...messages].reverse().find(m => m.role === 'user' && m.source?.kind === 'user')
    const system = messages.filter(m => m.role === 'system').map(textOf).join('\n') + (options.system ?? '')
    const entry = {
      kind: 'main',
      sessionId: options.sessionId ?? null,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      lastRole: messages.at(-1)?.role,
      userSourceKinds: messages.filter(m => m.role === 'user').map(m => m.source?.kind),
      notices: messages.filter(m => m.source?.kind === 'stage-router').map(textOf),
      system,
    }
    if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n')
    const prompt = textOf(lastUser)
    // A stage notice may follow a tool result, so "continuation" means any
    // tool message after the last real user message.
    const continuation = messages.slice(messages.lastIndexOf(lastUser) + 1).some(m => m.role === 'tool')
    if (!continuation) {
      if (prompt.includes('TODO')) return yield * toolCall('todo_write', { todos: [{ content: 'finish it', status: 'completed' }] })
      if (prompt.includes('TIERS1')) return yield * toolCall('todo_write', { todos: [{ content: '[T1][light] small fix', status: 'in_progress' }, { content: 'big refactor', status: 'pending' }] })
      if (prompt.includes('TIERS2')) return yield * toolCall('todo_write', { todos: [{ content: '[T1][light] small fix', status: 'in_progress' }, { content: 'big refactor', status: 'in_progress' }] })
      if (prompt.startsWith('CHILD')) return yield * text(`child reply from ${options.provider}/${options.model}`)
      if (prompt.includes('SPAWN')) return yield * toolCall('subagent', { description: 'helper', prompt: 'CHILD big job', run_in_background: false })
      if (prompt.includes('FORK')) return yield * toolCall('subagent_fork', { description: 'second look', prompt: 'CHILD review it' })
      if (prompt.includes('EXITPLAN')) return yield * toolCall('exit_plan_mode', { plan: '# Plan\n\n1. do it' })
    }
    yield * text(`reply from ${options.provider}/${options.model}`)
  }
}

export const name = 'fake-llm'
export const inject = ['llm']

const FAKE_JEV = 'http://fake-jev.invalid/v1/systemone'

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function fakeJev(init) {
  const body = JSON.parse(init.body)
  const keys = Object.keys(body.questions ?? {})
  if (LOG) {
    appendFileSync(LOG, JSON.stringify({
      kind: 'judge', provider: 'jev', model: body.model, reasoningEffort: null, sessionId: null,
      auth: init.headers?.authorization ?? null, questions: keys, userSourceKinds: [], notices: [],
    }) + '\n')
  }
  if (Array.isArray(body.state?.tasks)) {
    return json({ answers: Object.fromEntries(body.state.tasks.map(task => {
      const tier = task.text.includes('big') ? 'heavy' : 'light'
      return [task.key, { type: 'choice', choice: tier, probabilities: { [tier]: 0.9 } }]
    })) })
  }
  const marker = /JUDGE=(\w+)(?:@([\d.]+))?/.exec(String(body.state?.prompt ?? ''))
  if (marker?.[1] === 'slow') {
    await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  }
  if (marker?.[1] === 'garbage') return json({ nonsense: true })
  const stage = marker?.[1] ?? 'none'
  const confidence = marker === null ? 0 : Number(marker[2] ?? 0.9)
  return json({ answers: { stage: { type: 'choice', choice: stage, probabilities: { [stage]: confidence } } } })
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['fake'], new FakeAdapter())
  ctx.effect(() => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (url, init) => String(url) === FAKE_JEV ? fakeJev(init) : realFetch(url, init)
    return () => { globalThis.fetch = realFetch }
  }, 'fake-llm: fake Jev')
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const arg = /CMD=(\S+)/.exec(textOf(message))?.[1]
    const commands = ctx.get('commands')
    if (arg === undefined || commands === undefined || agent.session.header.parentSession !== undefined) return
    void Promise.resolve()
      .then(() => commands.execute(agent, `/stage ${arg.replaceAll('_', ' ')}`, [], new AbortController().signal))
      .then(result => LOG && appendFileSync(LOG, JSON.stringify({ kind: 'command', args: arg, result: result?.result ?? null }) + '\n'))
  })
  // Headless has no human to answer exit_plan_mode's review: approve it.
  ctx.on('user-questions/request', async (request, next) => {
    const question = request.questions?.find(q => q.id === 'plan-review')
    if (question === undefined) return next()
    const option = question.options?.[0]
    return { answers: [{ id: question.id, selected: [option?.id ?? option?.label ?? 'Approve'] }] }
  }, { prepend: true })
}
