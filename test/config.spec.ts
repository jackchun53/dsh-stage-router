import { describe, expect, it } from 'vitest'
import { DEFAULT_JUDGE, parseConfig, effectiveJudge, type SchemeConfig } from '../src/config/schema.js'
import { EXAMPLE_SCHEME } from '../src/config/defaults.js'
import { checkRoutes, schemeRoutes, validateConfig, validateScheme } from '../src/config/validate.js'

const route = { provider: 'p', model: 'm' }

function scheme(patch: Record<string, unknown> = {}): SchemeConfig {
  return parseConfig({
    schemes: [{
      id: 's',
      initialStage: 'a',
      stages: [{ id: 'a', route }, { id: 'b', route }],
      transitions: [{ to: '*', on: 'user_message' }],
      ...patch,
    }],
  }).schemes[0]!
}

const paths = (s: SchemeConfig) => validateScheme(s).map(issue => issue.path)

describe('parseConfig', () => {
  it('fills defaults for an empty config', () => {
    const config = parseConfig({})
    expect(config.schemes).toEqual([])
    expect(config.defaultJudge).toEqual(DEFAULT_JUDGE)
  })

  it('fills stage and transition defaults', () => {
    const s = scheme()
    expect(s.stages[0]!.planMode).toBe('keep')
    expect(s.transitions[0]!.from).toBe('*')
    expect(s.subagents).toEqual({ enabled: false, stage: 'inherit', classify: true })
  })

  it('rejects a missing initialStage and an unknown event', () => {
    expect(() => parseConfig({ schemes: [{ id: 's', stages: [] }] })).toThrow(/initialStage/)
    expect(() => scheme({ transitions: [{ from: '*', to: 'a', on: 'nope' as never }] })).toThrow()
  })

  it('accepts the example scheme', () => {
    const config = parseConfig({ schemes: [EXAMPLE_SCHEME] })
    expect(validateConfig(config)).toEqual([])
  })
})

describe('validateScheme', () => {
  it('passes a minimal scheme', () => {
    expect(validateScheme(scheme())).toEqual([])
  })

  it('flags duplicate stage ids and the reserved wildcard', () => {
    expect(paths(scheme({ stages: [{ id: 'a', route } as never, { id: 'a', route } as never] })))
      .toContain('scheme.stages[1].id')
    expect(paths(scheme({ initialStage: '*', stages: [{ id: '*', route } as never] })))
      .toContain('scheme.stages[0].id')
  })

  it('flags transitions to unknown stages', () => {
    const s = scheme({ transitions: [{ from: 'x', to: 'y', on: 'user_message' }] })
    expect(paths(s)).toEqual(['scheme.transitions[0].from', 'scheme.transitions[0].to'])
  })

  it('flags an unknown initialStage and subagent stage', () => {
    const s = scheme({ initialStage: 'zzz', subagents: { enabled: true, stage: 'nope', classify: true } })
    expect(paths(s)).toEqual(['scheme.initialStage', 'scheme.subagents.stage'])
  })

  it('checks tier defaults only for stages that have tiers', () => {
    const tiered = (tierDefault: string | undefined) => scheme({
      stages: [{
        id: 'a',
        route,
        tiers: { default: tierDefault, levels: [{ id: 'light', route }, { id: 'heavy', route }] },
      } as never],
    })
    expect(paths(tiered('heavy'))).toEqual([])
    expect(paths(tiered('mega'))).toEqual(['scheme.stages[0].tiers.default'])
    expect(paths(tiered(undefined))).toEqual(['scheme.stages[0].tiers.default'])
  })

  it('flags duplicate scheme ids across the config', () => {
    const config = parseConfig({ schemes: [scheme(), scheme()] })
    expect(validateConfig(config).map(issue => issue.path)).toEqual(['schemes[1].id'])
  })
})

describe('effectiveJudge', () => {
  it('uses the default when a scheme has no override', () => {
    expect(effectiveJudge(DEFAULT_JUDGE, { judge: null })).toBe(DEFAULT_JUDGE)
  })

  it('merges a partial override over the default', () => {
    const s = scheme({ judge: { timeoutMs: 100, minConfidence: 0.9 } })
    const judge = effectiveJudge(DEFAULT_JUDGE, s)
    expect(judge).toMatchObject({ timeoutMs: 100, minConfidence: 0.9, contextTurns: 2 })
    expect(judge.route).toEqual(DEFAULT_JUDGE.route)
  })
})

describe('checkRoutes', () => {
  it('reports each unusable route by path', async () => {
    const s = scheme({ stages: [{ id: 'a', route: { provider: 'p', model: 'gone' } } as never, { id: 'b', route } as never] })
    const issues = await checkRoutes(schemeRoutes(s), async r => {
      if (r.model === 'gone') throw new Error('model not found')
      return undefined
    })
    expect(issues).toEqual([{ path: 'scheme.stages[0].route', message: 'model not found' }])
  })
})

describe('effectiveJudge route override', () => {
  it('replaces the route only when the override names provider and model', () => {
    const s = scheme({ judge: { route: { provider: 'x', model: 'y' } } })
    expect(effectiveJudge(DEFAULT_JUDGE, s).route).toEqual({ provider: 'x', model: 'y' })
  })
})

describe('bundle patch', () => {
  it('ships a config equal to the example scheme that validates cleanly', async () => {
    const { readFileSync } = await import('node:fs')
    const yaml = await import('js-yaml')
    const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { insert: { id: string; name: string; config: unknown }[] }[]
    const row = rows[0]!.insert[0]!
    expect(row).toMatchObject({ id: 'stage-router', name: 'dsh-stage-router' })
    const config = parseConfig(row.config)
    expect(validateConfig(config)).toEqual([])
    expect(config.schemes[0]).toMatchObject(parseConfig({ schemes: [EXAMPLE_SCHEME] }).schemes[0]!)
  })
})
