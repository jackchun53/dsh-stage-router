import { describe, expect, it } from 'vitest'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseConfig, type SchemeConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { StageRouterAdapter, type AdapterHost } from '../src/adapter.js'

const example = parseConfig({ schemes: [EXAMPLE_SCHEME] }).schemes[0]!

function host(schemes: SchemeConfig[], models: Record<string, Partial<LlmResolvedModelInfo> | Error> = {}) {
  const streamed: GenerateOptions[] = []
  const warnings: string[] = []
  const h: AdapterHost = {
    schemes: () => schemes,
    llm: {
      async resolveModelInfo(provider, model) {
        const info = models[`${provider}/${model}`]
        if (info instanceof Error) throw info
        return { provider, id: model, name: model, ...info }
      },
      async * stream(options): AsyncIterable<StreamChunk> {
        streamed.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    warn: message => { warnings.push(message) },
  }
  return { h, streamed, warnings }
}

describe('StageRouterAdapter', () => {
  it('lists one model per scheme', async () => {
    const { h } = host([example])
    expect(await new StageRouterAdapter(h).listModels('stage-router')).toEqual([{
      provider: 'stage-router', id: 'dev-default', name: '研发默认 (stage-router)', description: '规划 → 编码 → 审查',
    }])
  })

  it('rejects an unknown scheme', async () => {
    const { h } = host([example])
    await expect(new StageRouterAdapter(h).resolveModel('stage-router', 'nope')).rejects.toThrow(/no scheme "nope"/)
  })

  it('accepts images when any stage model does', async () => {
    const { h } = host([example], {
      'deepseek-official/deepseek-flash': { inputModalities: ['text'], context: { contextWindow: 64_000 } },
      'deepseek-official/deepseek-v4-pro': { inputModalities: ['text', 'image'], context: { contextWindow: 128_000 } },
    })
    const info = await new StageRouterAdapter(h).resolveModel('stage-router', 'dev-default')
    expect(info.inputModalities).toEqual(['text', 'image'])
    expect(info.context).toEqual({ contextWindow: 64_000 })
  })

  it('refuses images only when every stage model is text-only', async () => {
    const { h } = host([example], {
      'deepseek-official/deepseek-flash': { inputModalities: ['text'] },
      'deepseek-official/deepseek-v4-pro': { inputModalities: ['text'] },
    })
    expect((await new StageRouterAdapter(h).resolveModel('stage-router', 'dev-default')).inputModalities).toEqual(['text'])
  })

  it('treats an unresolvable stage model as unknown, not text-only', async () => {
    const { h } = host([example], {
      'deepseek-official/deepseek-flash': new Error('gone'),
      'deepseek-official/deepseek-v4-pro': new Error('gone'),
    })
    expect((await new StageRouterAdapter(h).resolveModel('stage-router', 'dev-default')).inputModalities).toEqual(['text', 'image'])
  })

  it('forwards a direct stream to the initial stage route and warns', async () => {
    const { h, streamed, warnings } = host([example])
    const chunks: StreamChunk[] = []
    for await (const chunk of new StageRouterAdapter(h).stream({ provider: 'stage-router', model: 'dev-default', messages: [], reasoningEffort: 'max' as never })) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)
    expect(streamed[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(streamed[0]).not.toHaveProperty('reasoningEffort')
    expect(warnings).toHaveLength(1)
  })
})
