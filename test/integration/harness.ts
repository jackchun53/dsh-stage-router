import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const DSH = join(ROOT, 'node_modules/.bin/dsh')
const PATCH = join(ROOT, 'test/integration/fixtures/profile.patch.yml')

export interface LlmCall {
  kind: 'judge' | 'main'
  provider: string
  model: string
  reasoningEffort: string | null
  lastRole: string
  userSourceKinds: string[]
  notices: string[]
  system?: string
}

export interface TurnResult {
  exitCode: number | null
  final: string | undefined
  calls: LlmCall[]
  stderr: string
  stdout: string
}

/**
 * One headless dsh session on the fake provider. Each {@link send} is a
 * separate `dsh headless` process; every turn after the first resumes the
 * session from storage, so state must survive a reload.
 */
export class HeadlessSession {
  readonly dir = mkdtempSync(join(tmpdir(), 'stage-router-it-'))
  private readonly log = join(this.dir, 'llm.jsonl')
  private seen = 0
  sessionId: string | undefined

  constructor() {
    mkdirSync(join(this.dir, 'cwd'))
  }

  send(prompt: string): TurnResult {
    const args = ['--profile', 'headless', '--patch', PATCH, '--json']
    if (this.sessionId !== undefined) args.push('--session-id', this.sessionId)
    args.push(prompt)
    const run = spawnSync(DSH, args, {
      cwd: join(this.dir, 'cwd'),
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        DSH_HOME: join(this.dir, 'home'),
        DSH_AGENTS_HOME: join(this.dir, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'danger-full-access',
        FAKE_LLM_LOG: this.log,
      },
    })
    const lines = run.stdout.split('\n').flatMap(line => {
      try { return [JSON.parse(line) as { type: string; sessionId?: string; text?: string }] } catch { return [] }
    })
    this.sessionId ??= lines.find(line => line.type === 'session')?.sessionId
    const all = existsSync(this.log)
      ? readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as LlmCall)
      : []
    const calls = all.slice(this.seen)
    this.seen = all.length
    return { exitCode: run.status, final: lines.find(line => line.type === 'final')?.text, calls, stderr: run.stderr, stdout: run.stdout }
  }
}

export const mains = (turn: TurnResult) => turn.calls.filter(call => call.kind === 'main')
export const judges = (turn: TurnResult) => turn.calls.filter(call => call.kind === 'judge')
export const routes = (turn: TurnResult) => mains(turn).map(call => `${call.provider}/${call.model}@${call.reasoningEffort ?? ''}`)
