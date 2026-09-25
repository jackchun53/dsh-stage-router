import { describe, expect, it } from 'vitest'
import { parseConfig, type StageRouterConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { createEditorHandlers, type EditorDeps } from '../src/editor-handlers.js'
import { jev, stageJev } from './helpers/fake-jev.js'

const current = parseConfig({ jev: { ...jev, token: 'saved-token' }, schemes: [EXAMPLE_SCHEME] })
const draft = { jev: { ...jev, token: '' }, schemes: [EXAMPLE_SCHEME] }

function deps(patch: Partial<EditorDeps> = {}) {
  const writes: { ns: string; section: object; revision?: number }[] = []
  let revision = 3
  const judge = stageJev('review')
  let stored: unknown = { schemes: current.schemes, jev: { ...current.jev, token: undefined } }
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
    fetch: judge.fetch,
    judgeLog: (sessionId, limit) => sessionId === 's1'
      ? [{ kind: 'tier' as const, at: 1, elapsedMs: 2, stage: 'code', ok: true, tasks: [] }].slice(0, limit)
      : [],
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
  return { handlers: createEditorHandlers(d), writes, jevCalls: judge.calls }
}

describe('editor handlers', () => {
  it('reads the config and revision from the settings service', () => {
    const view = deps().handlers.getConfig()
    expect(view).toMatchObject({ revision: 3, writable: true })
    expect(view.config.schemes[0]!.id).toBe('dev-default')
  })

  it('never returns the Jev token, only whether one is saved', () => {
    const view = deps().handlers.getConfig()
    expect(view.jevTokenSet).toBe(true)
    expect(view.config.jev.token).toBe('')
    expect(view.config.jev.baseUrl).toBe(jev.baseUrl)
    expect(JSON.stringify(view)).not.toContain('saved-token')
    expect(JSON.stringify(deps({ settings: () => undefined }).handlers.getConfig())).not.toContain('saved-token')
  })

  it('keeps the saved token for a blank draft token, replaces or clears it on request', async () => {
    const keep = deps()
    await keep.handlers.save(draft, 3)
    expect((keep.writes[0]!.section as StageRouterConfig).jev.token).toBe('saved-token')
    const replace = deps()
    await replace.handlers.save({ ...draft, jev: { ...jev, token: 'new-token' } }, 3)
    expect((replace.writes[0]!.section as StageRouterConfig).jev.token).toBe('new-token')
    const clear = deps()
    const saved = await clear.handlers.save(draft, 3, true)
    expect((clear.writes[0]!.section as StageRouterConfig).jev.token).toBe('')
    expect(saved.warnings.map(w => w.path)).toContain('jev')
  })

  it('falls back to the running config when settings cannot edit the row', () => {
    expect(deps({ settings: () => undefined }).handlers.getConfig()).toMatchObject({ revision: -1, writable: false })
  })

  it('validates with model availability', async () => {
    const { issues } = await deps().handlers.validate(draft)
    expect(issues.map(i => i.path)).toContain('schemes[0].stages[0].route')
    expect(issues.map(i => i.path)).not.toContain('jev')
    expect((await deps().handlers.validate(draft, true)).issues.map(i => i.path)).toContain('jev')
  })

  it('saves a valid draft, returning model warnings and the new revision', async () => {
    const { handlers, writes } = deps()
    const saved = await handlers.save(draft, 3)
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
    await expect(deps().handlers.save(draft, 1)).rejects.toMatchObject({
      code: 'stage-router/rejected', details: { reason: 'SETTINGS_CONFLICT' },
    })
    await expect(deps({ settings: () => undefined }).handlers.save(draft, 1)).rejects.toMatchObject({
      code: 'stage-router/unavailable',
    })
  })

  it('tries Jev on a draft with the saved token', async () => {
    const { handlers, jevCalls } = deps()
    const result = await handlers.tryJudge({ draft, scheme: 'dev-default', current: 'code', message: 'review it' })
    expect(result.decision).toMatchObject({ kind: 'goto', stage: 'review' })
    expect(jevCalls[0]!.headers.authorization).toBe('Bearer saved-token')
  })

  it('returns one session judge log', () => {
    const { handlers } = deps()
    expect(handlers.judgeLog('s1').entries).toHaveLength(1)
    expect(handlers.judgeLog('s2').entries).toEqual([])
  })

  it('builds a model catalog without itself and survives a failing provider', async () => {
    const catalog = await deps().handlers.catalog()
    expect(catalog.map(p => p.id)).toEqual(['deepseek-official', 'broken'])
    expect(catalog[0]!.models[0]).toEqual({ id: 'deepseek-flash', name: 'Flash', efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' })
    expect(catalog[1]).toMatchObject({ models: [], error: 'no credentials' })
  })
})
