/**
 * The settings editor's host operations, free of the remote framework (and of
 * decorators, so they unit-test directly). `editor-remote.ts` exposes them.
 */
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RouteConfig, StageRouterConfig } from './config/schema.js'
import type { ConfigIssue } from './config/validate.js'
import { blocking, checkDraft, tryJudge, type TryJudgeInput, type TryJudgeResult } from './editor-service.js'
import type { FetchFn } from './engine/jev.js'
import type { JudgeLogEntry } from './shared/wire.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'stage-router/invalid': { issues: ConfigIssue[] }
    'stage-router/unavailable': Record<string, never>
    'stage-router/rejected': { reason: string }
  }
}

/** Settings namespace of the plugin row (its cordis row id). */
export const SETTINGS_NS = 'stage-router'

export interface EditorConfigView {
  /** The config with `jev.token` blanked: the token never leaves the host. */
  config: StageRouterConfig
  /** Whether a Jev token is saved. */
  jevTokenSet: boolean
  /** Settings revision for optimistic writes; -1 when the settings service is absent. */
  revision: number
  /** Whether saving is possible (the row is managed by the settings service). */
  writable: boolean
}

export interface CatalogModel {
  id: string
  name: string
  efforts: { id: string; name: string }[]
  defaultEffort?: string
}

export interface CatalogProvider {
  id: string
  name: string
  models: CatalogModel[]
  error?: string
}

/** What the handlers need from the host, injectable for tests. */
export interface EditorDeps {
  current(): StageRouterConfig
  settings(): {
    describe(options?: { redactSecrets?: boolean }): { ns: string; value: unknown; revision: number }[]
    replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  } | undefined
  fetch: FetchFn
  /** Recent judge-log entries of one session, newest last. */
  judgeLog(sessionId: string, limit?: number): JudgeLogEntry[]
  usable(route: RouteConfig): Promise<boolean>
  providers(): { id: string; name: string }[]
  listModels(provider: string): Promise<{ id: string; name: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo>
}

/** The editor operations, free of the remote framework. */
export function createEditorHandlers(deps: EditorDeps) {
  const redact = (config: StageRouterConfig): StageRouterConfig => ({ ...config, jev: { ...config.jev, token: '' } })
  const view = (): EditorConfigView => {
    const current = deps.current()
    const jevTokenSet = current.jev.token.trim() !== ''
    const described = deps.settings()?.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NS)
    if (described === undefined) return { config: redact(current), jevTokenSet, revision: -1, writable: false }
    const merged = { ...current, ...described.value as Partial<StageRouterConfig> }
    return { config: redact({ ...merged, jev: { ...current.jev, ...merged.jev } }), jevTokenSet, revision: described.revision, writable: true }
  }

  /**
   * The browser never holds the saved token: a blank `jev.token` in a draft
   * means "keep the saved one", unless `clearJevToken` asks to remove it.
   */
  const withToken = (draft: unknown, clearJevToken = false): unknown => {
    if (typeof draft !== 'object' || draft === null) return draft
    const jev = (draft as { jev?: unknown }).jev
    const given = typeof jev === 'object' && jev !== null ? (jev as { token?: unknown }).token : undefined
    if (typeof given === 'string' && given.trim() !== '') return draft
    const token = clearJevToken ? '' : deps.current().jev.token
    return { ...draft, jev: { ...typeof jev === 'object' && jev !== null ? jev : {}, token } }
  }

  return {
    getConfig: view,

    /** Structure, schema and model availability, with editor field paths. */
    async validate(draft: unknown, clearJevToken?: boolean): Promise<{ issues: ConfigIssue[] }> {
      return { issues: (await checkDraft(withToken(draft, clearJevToken), deps.usable)).issues }
    },

    /**
     * Save a draft into the user's profile layer. Structural problems block
     * the save; unavailable models and a missing Jev setup are returned as warnings.
     */
    async save(draft: unknown, expectedRevision: number | undefined, clearJevToken?: boolean): Promise<EditorConfigView & { warnings: ConfigIssue[] }> {
      const checked = await checkDraft(withToken(draft, clearJevToken))
      const errors = blocking(checked.issues)
      if (checked.config === undefined || errors.length > 0) {
        throw new RemoteError('stage-router/invalid', '配置有错误，修正后才能保存。', { issues: errors })
      }
      const settings = deps.settings()
      const target = settings?.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NS)
      if (settings === undefined || target === undefined) {
        throw new RemoteError('stage-router/unavailable', '当前 profile 不允许设置服务修改 stage-router。', {})
      }
      try {
        await settings.replace(SETTINGS_NS, checked.config, expectedRevision ?? target.revision)
      } catch (error) {
        throw new RemoteError('stage-router/rejected', error instanceof Error ? error.message : String(error), {
          reason: (error as { code?: string }).code ?? 'rejected',
        })
      }
      const warnings = (await checkDraft(checked.config, deps.usable)).issues
      return { ...view(), warnings }
    },

    tryJudge(input: TryJudgeInput): Promise<TryJudgeResult> {
      return tryJudge(deps.fetch, { ...input, draft: withToken(input.draft) })
    },

    /** The session's recent Jev calls for the stage panel (in memory only). */
    judgeLog(sessionId: string, limit?: number): { entries: JudgeLogEntry[] } {
      return { entries: deps.judgeLog(sessionId, limit) }
    },

    /** Providers, models and reasoning efforts for the editor dropdowns (stage-router itself excluded). */
    async catalog(): Promise<CatalogProvider[]> {
      return Promise.all(deps.providers().filter(provider => provider.id !== 'stage-router').map(async provider => {
        try {
          const listed = await deps.listModels(provider.id)
          const models = await Promise.all(listed.map(async model => {
            const info = await deps.resolveModelInfo(provider.id, model.id).catch(() => undefined)
            return {
              id: model.id,
              name: model.name,
              efforts: info?.reasoning?.efforts.map(effort => ({ id: String(effort.id), name: effort.name })) ?? [],
              ...info?.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: String(info.reasoning.defaultEffort) },
            }
          }))
          return { id: provider.id, name: provider.name, models }
        } catch (error) {
          return { id: provider.id, name: provider.name, models: [], error: error instanceof Error ? error.message : String(error) }
        }
      }))
    },
  }
}

export type EditorHandlers = ReturnType<typeof createEditorHandlers>

