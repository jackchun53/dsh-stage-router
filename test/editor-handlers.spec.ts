import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { createEditorHandlers, type EditorDeps } from '../src/editor-handlers.js'

const current = parseConfig({ schemes: [EXAMPLE_SCHEME] })

function deps(patch: Partial<EditorDeps> = {}) {
  const writes: { ns: string; section: object; revision?: number }[] = []
  let revision = 3
  let stored: unknown = { schemes: current.schemes, defaultJudge: current.defaultJudge }
  const d: EditorDeps = {
    current: () => current,
    settings: () => ({
      describe: () => [{ ns: 'other', value: {}, revision: 1 }, { ns: 'stage-router', value: stored, revision }],
      replace: async (ns, section, expected) => {
        if (expected !== revision) throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
        writes.push({ ns, section, ...expected === undefined ? {} : { revision: expected } })
        stored = section
        revision++
      },
    }),
    stream: async function* (): AsyncIterable<StreamChunk> {
      const text = '{"stage":"review","confidence":0.9}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    usable: async route => route.model !== 'deepseek-v4-pro',
    providers: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'stage-router', name: 'Stage Router' }, { id: 'broken', name: 'Broken' }],
    listModels: async provider => {
      if (provider === 'broken') throw new Error('no credentials')
      return [{ id: 'deepseek-flash', name: 'Flash' }]
    },
    resolveModelInfo: async (provider, model) => ({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'off' as never, name: 'Off' }, { id: 'high' as never, name: 'High' }], defaultEffort: 'high' as never },
    }),
    ...patch,
  }
  return { handlers: createEditorHandlers(d), writes }
}

describe('editor handlers', () => {
  it('reads the config and revision from the settings service', () => {
    const view = deps().handlers.getConfig()
    expect(view).toMatchObject({ revision: 3, writable: true })
    expect(view.config.schemes[0]!.id).toBe('dev-default')
  })

  it('falls back to the running config when settings cannot edit the row', () => {
    expect(deps({ settings: () => undefined }).handlers.getConfig()).toMatchObject({ revision: -1, writable: false })
  })

  it('validates with model availability', async () => {
    const { issues } = await deps().handlers.validate({ schemes: [EXAMPLE_SCHEME] })
    expect(issues.map(i => i.path)).toContain('schemes[0].stages[0].route')
  })

  it('saves a valid draft, returning model warnings and the new revision', async () => {
    const { handlers, writes } = deps()
    const saved = await handlers.save({ schemes: [EXAMPLE_SCHEME] }, 3)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.ns).toBe('stage-router')
    expect(saved.revision).toBe(4)
    expect(saved.warnings.length).toBeGreaterThan(0)
  })

  it('refuses a draft with structural errors', async () => {
    const broken = { ...EXAMPLE_SCHEME, initialStage: 'nope' }
    await expect(deps().handlers.save({ schemes: [broken] }, 3)).rejects.toMatchObject({
      code: 'stage-router/invalid',
      details: { issues: [{ path: 'schemes[0].initialStage' }] },
    })
  })

  it('reports a stale revision and a missing settings service', async () => {
    await expect(deps().handlers.save({ schemes: [EXAMPLE_SCHEME] }, 1)).rejects.toMatchObject({
      code: 'stage-router/rejected', details: { reason: 'SETTINGS_CONFLICT' },
    })
    await expect(deps({ settings: () => undefined }).handlers.save({ schemes: [EXAMPLE_SCHEME] }, 1)).rejects.toMatchObject({
      code: 'stage-router/unavailable',
    })
  })

  it('tries the judge on a draft', async () => {
    const result = await deps().handlers.tryJudge({ draft: { schemes: [EXAMPLE_SCHEME] }, scheme: 'dev-default', current: 'code', message: 'review it' })
    expect(result.decision).toMatchObject({ kind: 'goto', stage: 'review' })
  })

  it('builds a model catalog without itself and survives a failing provider', async () => {
    const catalog = await deps().handlers.catalog()
    expect(catalog.map(p => p.id)).toEqual(['deepseek-official', 'broken'])
    expect(catalog[0]!.models[0]).toEqual({ id: 'deepseek-flash', name: 'Flash', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' })
    expect(catalog[1]).toMatchObject({ models: [], error: 'no credentials' })
  })
})
