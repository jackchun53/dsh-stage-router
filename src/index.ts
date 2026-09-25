import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin id used for the cordis row, the virtual provider and log prefixes. */
export const name = 'stage-router'

export const inject = ['llm']

/** Plugin configuration (the `config` of this plugin's cordis row). */
export interface Config {}

export const Config: z<Config> = z.object({})

export function apply(ctx: Context, _config: Config): void {
  ctx.logger.debug('stage-router: loaded')
}
