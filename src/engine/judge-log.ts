import { JUDGE_LOG_LIMIT, type JudgeLogEntry } from '../shared/wire.js'

export type { JudgeLogEntry, StageJudgeLog, TierJudgeLog } from '../shared/wire.js'

/** Characters of a message or task text kept in a log entry. */
export const LOG_TEXT_LIMIT = 120

export function logText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= LOG_TEXT_LIMIT ? flat : `${flat.slice(0, LOG_TEXT_LIMIT)}…`
}

/**
 * Recent Jev calls per session, newest last. In memory only: it feeds the
 * stage panel's judge log and is gone after a restart.
 */
export class JudgeLog {
  private readonly sessions = new Map<string, JudgeLogEntry[]>()

  constructor(private readonly perSession = JUDGE_LOG_LIMIT, private readonly maxSessions = 200) {}

  record(sessionId: string, entry: JudgeLogEntry): void {
    let list = this.sessions.get(sessionId)
    if (list === undefined) {
      list = []
      this.sessions.set(sessionId, list)
      if (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!)
    }
    list.push(entry)
    if (list.length > this.perSession) list.splice(0, list.length - this.perSession)
  }

  recent(sessionId: string, limit = this.perSession): JudgeLogEntry[] {
    return (this.sessions.get(sessionId) ?? []).slice(-limit)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
