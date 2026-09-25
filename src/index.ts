import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { ConfigSchema, type StageRouterConfig } from './config/schema.js'
import { validateConfig } from './config/validate.js'

/** Plugin id used for the cordis row, the virtual provider and log prefixes. */
export const name = 'stage-router'

export const inject = ['llm']

/** Plugin configuration (the `config` of this plugin's cordis row). */
export type Config = StageRouterConfig

export const Config: z<Config> = ConfigSchema

export function apply(ctx: Context, config: Config): void {
  for (const issue of validateConfig(config)) {
    ctx.logger.error('stage-router: config %s: %s', issue.path, issue.message)
  }
}
