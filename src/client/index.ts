/**
 * Web client entry of dsh-stage-router: the composer stage chip and the
 * per-turn routing summary. Kept defensive on purpose: a client entry that
 * fails to activate stops the whole Web UI from booting, so the top-level
 * `inject` names only services every Web profile has and nothing here throws.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { en, zh, type StageRouterKey } from './locales.js'
import { StageChip, type StageChipInjected } from './StageChip.js'
import { TurnTail } from './TurnTail.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'stage-router': StageRouterKey
  }
}

const NS = 'stage-router'
/** Slot entry id; also the package name. */
const ID = 'dsh-stage-router'

export const inject = ['slots', 'locale']

type CommandsRemote = ClientContext['remote']['commands']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'stage-router: dictionaries')

  // Optional: without the commands remote the chip still shows state, and
  // its actions report that they are unavailable.
  let commands: CommandsRemote | undefined
  ctx.inject(['remote', 'remote.commands'], remoteCtx => {
    remoteCtx.effect(() => {
      commands = remoteCtx.remote.commands
      return () => { commands = undefined }
    }, 'stage-router: commands remote')
  })

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: ID,
    locale: NS,
    inject: (sessionId: SessionId): StageChipInjected => ({
      runStage: async args => {
        if (commands === undefined) return 'commands are unavailable'
        const result = await commands.execute(sessionId, `/stage ${args}`, [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /stage'
        const done = result.value.result as { kind?: string; text?: string } | undefined
        return done?.kind === 'error' ? done.text ?? 'failed' : null
      },
    }),
  }, StageChip))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: ID,
    locale: NS,
  }, TurnTail))
}
