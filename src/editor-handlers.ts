/**
 * The settings editor's host operations, free of the remote framework (and of
 * decorators, so they unit-test directly). `editor-remote.ts` exposes them.
 */
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RouteConfig, StageRouterConfig } from './config/schema.js'
import type { ConfigIssue } from './config/validate.js'
import { checkDraft, tryJudge, type TryJudgeInput, type TryJudgeResult } from './editor-service.js'
import type { StreamFn } from './engine/judge.js'

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
  config: StageRouterConfig
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
  stream: StreamFn
  usable(route: RouteConfig): Promise<boolean>
  providers(): { id: string; name: string }[]
  listModels(provider: string): Promise<{ id: string; name: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo>
}

/** The editor operations, free of the remote framework. */
export function createEditorHandlers(deps: EditorDeps) {
  const view = (): EditorConfigView => {
    const described = deps.settings()?.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NS)
    if (described === undefined) return { config: deps.current(), revision: -1, writable: false }
    return { config: { ...deps.current(), ...described.value as Partial<StageRouterConfig> }, revision: described.revision, writable: true }
  }

  return {
    getConfig: view,

    /** Structure, schema and model availability, with editor field paths. */
    async validate(draft: unknown): Promise<{ issues: ConfigIssue[] }> {
      return { issues: (await checkDraft(draft, deps.usable)).issues }
    },

    /**
     * Save a draft into the user's profile layer. Structural problems block
     * the save; unavailable models are returned as warnings.
     */
    async save(draft: unknown, expectedRevision: number | undefined): Promise<EditorConfigView & { warnings: ConfigIssue[] }> {
      const blocking = await checkDraft(draft)
      if (blocking.config === undefined || blocking.issues.length > 0) {
        throw new RemoteError('stage-router/invalid', '配置有错误，修正后才能保存。', { issues: blocking.issues })
      }
      const settings = deps.settings()
      const target = settings?.describe({ redactSecrets: true }).find(entry => entry.ns === SETTINGS_NS)
      if (settings === undefined || target === undefined) {
        throw new RemoteError('stage-router/unavailable', '当前 profile 不允许设置服务修改 stage-router。', {})
      }
      try {
        await settings.replace(SETTINGS_NS, blocking.config, expectedRevision ?? target.revision)
      } catch (error) {
        throw new RemoteError('stage-router/rejected', error instanceof Error ? error.message : String(error), {
          reason: (error as { code?: string }).code ?? 'rejected',
        })
      }
      const warnings = (await checkDraft(blocking.config, deps.usable)).issues
      return { ...view(), warnings }
    },

    tryJudge(input: TryJudgeInput): Promise<TryJudgeResult> {
      return tryJudge(deps.stream, input)
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

