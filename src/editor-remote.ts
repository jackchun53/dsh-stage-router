/**
 * Host remote for the settings editor, reachable from the Web client as
 * `connection.rpc.call('/api', 'stageRouter/<method>', { args })` (dsh's
 * untyped gateway path: argument names on the wire are the parameter names,
 * so parameters stay plain identifiers).
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ConfigIssue } from './config/validate.js'
import type { TryJudgeInput, TryJudgeResult } from './editor-service.js'
import type { CatalogProvider, EditorConfigView, EditorHandlers } from './editor-handlers.js'

export { createEditorHandlers } from './editor-handlers.js'

/** The remote service; each method is `stageRouter/<name>` on the gateway. */
export class StageRouterEditorRemote extends TypertRemoteService {
  private readonly handlers: EditorHandlers

  constructor(ctx: Context, handlers: EditorHandlers) {
    super(ctx, 'stageRouterEditor', { namespace: 'stageRouter' })
    this.handlers = handlers
  }

  @Remote
  getConfig(): EditorConfigView {
    return this.handlers.getConfig()
  }

  @Remote
  validate(draft: unknown): Promise<{ issues: ConfigIssue[] }> {
    return this.handlers.validate(draft)
  }

  @Remote
  saveConfig(draft: unknown, expectedRevision?: number): Promise<EditorConfigView & { warnings: ConfigIssue[] }> {
    return this.handlers.save(draft, expectedRevision)
  }

  @Remote
  tryJudge(input: TryJudgeInput): Promise<TryJudgeResult> {
    return this.handlers.tryJudge(input)
  }

  @Remote
  catalog(): Promise<CatalogProvider[]> {
    return this.handlers.catalog()
  }
}
