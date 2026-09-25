import { ANY_STAGE, type RouteConfig, type SchemeConfig, type StageRouterConfig } from './schema.js'

export interface ConfigIssue {
  /** Dotted path of the offending field, e.g. `schemes[0].stages[1].id`. */
  path: string
  message: string
}

/** True when the stage actually splits into tiers. */
export function hasTiers(stage: SchemeConfig['stages'][number]): boolean {
  return (stage.tiers?.levels.length ?? 0) > 0
}

/** Structural checks that the schema cannot express. Pure; no model lookups. */
export function validateScheme(scheme: SchemeConfig, base = 'scheme'): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const issue = (path: string, message: string) => issues.push({ path: `${base}.${path}`, message })
  const ids = new Set<string>()
  if (scheme.stages.length === 0) issue('stages', 'a scheme needs at least one stage')
  scheme.stages.forEach((stage, i) => {
    if (stage.id === ANY_STAGE) issue(`stages[${i}].id`, `"${ANY_STAGE}" is reserved`)
    else if (ids.has(stage.id)) issue(`stages[${i}].id`, `duplicate stage id "${stage.id}"`)
    ids.add(stage.id)
    if (!hasTiers(stage)) return
    const tiers = stage.tiers!
    const levelIds = new Set<string>()
    tiers.levels.forEach((level, j) => {
      if (levelIds.has(level.id)) issue(`stages[${i}].tiers.levels[${j}].id`, `duplicate tier id "${level.id}"`)
      levelIds.add(level.id)
    })
    if (tiers.default === undefined || tiers.default === '') issue(`stages[${i}].tiers.default`, 'tiers need a default level')
    else if (!levelIds.has(tiers.default)) issue(`stages[${i}].tiers.default`, `unknown tier "${tiers.default}"`)
  })
  if (!ids.has(scheme.initialStage)) issue('initialStage', `unknown stage "${scheme.initialStage}"`)
  scheme.transitions.forEach((rule, i) => {
    if (rule.from !== ANY_STAGE && !ids.has(rule.from)) issue(`transitions[${i}].from`, `unknown stage "${rule.from}"`)
    if (rule.to !== ANY_STAGE && !ids.has(rule.to)) issue(`transitions[${i}].to`, `unknown stage "${rule.to}"`)
  })
  const sub = scheme.subagents.stage
  if (sub !== 'inherit' && !ids.has(sub)) issue('subagents.stage', `unknown stage "${sub}"`)
  return issues
}

/** Validate every scheme plus cross-scheme rules (unique ids). */
export function validateConfig(config: StageRouterConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const seen = new Set<string>()
  config.schemes.forEach((scheme, i) => {
    if (seen.has(scheme.id)) issues.push({ path: `schemes[${i}].id`, message: `duplicate scheme id "${scheme.id}"` })
    seen.add(scheme.id)
    issues.push(...validateScheme(scheme, `schemes[${i}]`))
  })
  return issues
}

/** Every concrete route a scheme references, with its config path. */
export function schemeRoutes(scheme: SchemeConfig, base = 'scheme'): { path: string; route: RouteConfig }[] {
  const routes: { path: string; route: RouteConfig }[] = []
  scheme.stages.forEach((stage, i) => {
    routes.push({ path: `${base}.stages[${i}].route`, route: stage.route })
    if (hasTiers(stage)) {
      stage.tiers!.levels.forEach((level, j) => routes.push({ path: `${base}.stages[${i}].tiers.levels[${j}].route`, route: level.route }))
    }
  })
  return routes
}

/**
 * Check that each route resolves to a real model with a supported effort.
 * @param check - resolves one route; throws or returns an error message when unusable.
 */
export async function checkRoutes(
  routes: { path: string; route: RouteConfig }[],
  check: (route: RouteConfig) => Promise<string | undefined>,
): Promise<ConfigIssue[]> {
  const results = await Promise.all(routes.map(async ({ path, route }) => {
    try {
      const message = await check(route)
      return message === undefined ? undefined : { path, message }
    } catch (error) {
      return { path, message: error instanceof Error ? error.message : String(error) }
    }
  }))
  return results.filter((issue): issue is ConfigIssue => issue !== undefined)
}
