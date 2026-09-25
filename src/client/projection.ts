/** Client-side typing of the host's `stage-router` projection (type-only merge). */
import type { StageRouterState } from '../shared/wire.js'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'stage-router': StageRouterState
  }
}
