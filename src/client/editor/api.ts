/**
 * Client side of the `stageRouter/*` host remote (dsh's untyped gateway path:
 * `connection.rpc.call('/api', '<namespace>/<method>', { args })`).
 */
import type { StageRouterConfig } from '../../config/schema.js'
import type { ConfigIssue } from '../../config/validate.js'
import type { CatalogProvider, EditorConfigView } from '../../editor-handlers.js'
import type { TryJudgeInput, TryJudgeResult } from '../../editor-service.js'
import type { JudgeLogEntry } from '../../shared/wire.js'

export type { CatalogProvider, EditorConfigView, TryJudgeInput, TryJudgeResult }

/** The subset of the client `connection` service the editor uses. */
export interface RpcConnection {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
      { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }
    >
  }
}

/** A failed call; `issues` is set when the host rejected an invalid draft. */
export class EditorApiError extends Error {
  constructor(readonly code: string, message: string, readonly issues: ConfigIssue[] = []) {
    super(message)
  }
}

export interface EditorApi {
  getConfig(): Promise<EditorConfigView>
  /** @param clearJevToken - validate as if the saved Jev token were removed. */
  validate(draft: StageRouterConfig, clearJevToken?: boolean): Promise<ConfigIssue[]>
  /** A blank `jev.token` keeps the saved token; `clearJevToken` removes it. */
  save(draft: StageRouterConfig, expectedRevision: number, clearJevToken?: boolean): Promise<EditorConfigView & { warnings: ConfigIssue[] }>
  tryJudge(input: TryJudgeInput): Promise<TryJudgeResult>
  catalog(): Promise<CatalogProvider[]>
  /** Recent Jev calls of one session, newest last (host memory only). */
  judgeLog(sessionId: string): Promise<JudgeLogEntry[]>
}

export function createEditorApi(connection: () => RpcConnection | undefined): EditorApi {
  const call = async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const handle = connection()
    if (handle === undefined) throw new EditorApiError('stage-router/offline', 'Web 连接尚未就绪。')
    let result
    try {
      result = await handle.rpc.call('/api', `stageRouter/${method}`, { args })
    } catch (error) {
      throw new EditorApiError('stage-router/transport', error instanceof Error ? error.message : String(error))
    }
    if (result.ok) return result.value as T
    const issues = (result.error.details as { issues?: ConfigIssue[] } | undefined)?.issues ?? []
    throw new EditorApiError(result.error.code, result.error.message, issues)
  }
  return {
    getConfig: () => call('getConfig', {}),
    validate: async (draft, clearJevToken = false) => (await call<{ issues: ConfigIssue[] }>('validate', { draft, clearJevToken })).issues,
    save: (draft, expectedRevision, clearJevToken = false) => call('saveConfig', { draft, expectedRevision, clearJevToken }),
    tryJudge: input => call('tryJudge', { input }),
    catalog: () => call('catalog', {}),
    judgeLog: async sessionId => (await call<{ entries: JudgeLogEntry[] }>('judgeLog', { sessionId })).entries,
  }
}
