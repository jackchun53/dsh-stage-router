import { describe, expect, it } from 'vitest'
import { DEFAULT_JEV, jevConfigured, parseConfig, type SchemeConfig } from '../src/config/schema.js'
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
    expect(config.jev).toEqual(DEFAULT_JEV)
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

describe('Jev config', () => {
  it('defaults to the TypeSafe endpoint with no token', () => {
    expect(parseConfig({}).jev).toEqual(DEFAULT_JEV)
    expect(DEFAULT_JEV.baseUrl).toBe('https://api.typesafe.ai/v1')
    expect(jevConfigured(DEFAULT_JEV)).toBe(false)
    expect(jevConfigured({ ...DEFAULT_JEV, token: 't' })).toBe(true)
  })

  it('loads configs written for the old model judge, dropping its fields', () => {
    const legacy = {
      defaultJudge: { route: { provider: 'p', model: 'm' }, timeoutMs: 1, minConfidence: 0.5, contextTurns: 1, promptTemplate: null },
      schemes: [{ ...scheme(), judge: { timeoutMs: 5 } }],
    }
    const config = parseConfig(legacy)
    expect(config).not.toHaveProperty('defaultJudge')
    expect(config.schemes[0]).not.toHaveProperty('judge')
    expect(config.jev).toEqual(DEFAULT_JEV)
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
