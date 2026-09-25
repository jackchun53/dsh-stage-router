// Integration fixture: a keyless `fake` provider plus a plan-review answerer.
// Main-loop requests carry a sessionId; judge requests do not. Every request is
// appended to FAKE_LLM_LOG as one JSON line.
//
// Scripting (keywords in the latest real user message):
//   JUDGE=<stage>[@<confidence>]  judge answers that stage (default confidence 0.9)
//   JUDGE=garbage                 judge answers non-JSON
//   JUDGE=slow                    judge never answers (hits the timeout)
//   TODO                          assistant calls todo_write with one completed item
//   EXITPLAN                      assistant calls exit_plan_mode
//   TIERS1                        todo_write: "[T1][light] small fix" in progress, "big refactor" pending
//   TIERS2                        todo_write: both of the above in progress
//   SPAWN                         spawn a foreground subagent with the task "CHILD big job"
//   FORK                          fork a subagent with the task "CHILD review it"
// Subagent requests (task starts with CHILD) just answer with text.
// Tier-judge requests (prompt lists "Tiers, lightest first") answer heavy for
// tasks containing "big", light otherwise.
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
    const judge = options.sessionId === undefined
    const lastUser = [...messages].reverse().find(m => m.role === 'user' && m.source?.kind === 'user')
    const system = messages.filter(m => m.role === 'system').map(textOf).join('\n') + (options.system ?? '')
    const entry = {
      kind: judge ? 'judge' : 'main',
      sessionId: options.sessionId ?? null,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      lastRole: messages.at(-1)?.role,
      userSourceKinds: messages.filter(m => m.role === 'user').map(m => m.source?.kind),
      notices: messages.filter(m => m.source?.kind === 'stage-router').map(textOf),
      system: judge ? undefined : system,
    }
    if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n')
    if (judge) {
      const prompt = textOf(messages.at(-1))
      if (prompt.includes('Tiers, lightest first')) {
        const tasks = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map(match => match[1])
        return yield * text(JSON.stringify({ tiers: tasks.map(task => task.includes('big') ? 'heavy' : 'light') }))
      }
      const marker = /JUDGE=(\w+)(?:@([\d.]+))?/.exec(prompt.split('New user message:').at(-1) ?? '')
      if (marker?.[1] === 'slow') {
        await new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      if (marker?.[1] === 'garbage') return yield * text('I am not sure, maybe planning?')
      if (marker === null) return yield * text('{"stage":"none","confidence":0}')
      return yield * text(JSON.stringify({ stage: marker[1], confidence: Number(marker[2] ?? 0.9), reason: 'scripted' }))
    }
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

export function apply(ctx) {
  ctx.llm.registerAdapter(['fake'], new FakeAdapter())
  // Headless has no human to answer exit_plan_mode's review: approve it.
  ctx.on('user-questions/request', async (request, next) => {
    const question = request.questions?.find(q => q.id === 'plan-review')
    if (question === undefined) return next()
    const option = question.options?.[0]
    return { answers: [{ id: question.id, selected: [option?.id ?? option?.label ?? 'Approve'] }] }
  }, { prepend: true })
}
