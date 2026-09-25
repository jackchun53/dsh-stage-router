import type { RouteConfig } from '../config/schema.js'
import type { JudgeRecord } from './state.js'

/** One routing decision, as shown in the Web panel and written to the log. */
export interface Decision {
  at: number
  turn: number
  step: number
  stage: string
  tier: string | null
  route: RouteConfig
  reason: string
  lock: string | null
  judge: JudgeRecord | null
}

/** Most recent routing decisions per session, newest last, bounded. */
export class DecisionLog {
  private readonly sessions = new Map<string, Decision[]>()

  constructor(private readonly perSession = 50, private readonly maxSessions = 200) {}

  record(sessionId: string, decision: Decision): void {
    let list = this.sessions.get(sessionId)
    if (list === undefined) {
      list = []
      this.sessions.set(sessionId, list)
      if (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!)
    }
    list.push(decision)
    if (list.length > this.perSession) list.splice(0, list.length - this.perSession)
  }

  recent(sessionId: string, limit = this.perSession): Decision[] {
    return (this.sessions.get(sessionId) ?? []).slice(-limit)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
