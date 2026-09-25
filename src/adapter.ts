import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RouteConfig, SchemeConfig } from './config/schema.js'
import { schemeRoutes } from './config/validate.js'

/** Provider id under which every scheme is listed as one model. */
export const PROVIDER = 'stage-router'

/** What the adapter needs from the host; `ctx.llm` satisfies the llm part. */
export interface AdapterHost {
  schemes(): readonly SchemeConfig[]
  llm: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
  warn(message: string, ...args: unknown[]): void
}

/** The route of a scheme's initial stage. */
export function initialRoute(scheme: SchemeConfig): RouteConfig | undefined {
  return scheme.stages.find(stage => stage.id === scheme.initialStage)?.route ?? scheme.stages[0]?.route
}

/**
 * Virtual provider: each scheme appears in the model picker as
 * `stage-router/<scheme id>`. Requests are rewritten to real routes in the
 * `agent/request` hook, so {@link stream} only runs when something bypasses
 * that hook; it then forwards to the initial stage's model.
 */
export class StageRouterAdapter extends LlmAdapter {
  constructor(private readonly host: AdapterHost) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: '阶段路由' }
  }

  private scheme(model: string): SchemeConfig {
    const scheme = this.host.schemes().find(s => s.id === model)
    if (scheme === undefined) throw new LlmError(`stage-router：没有方案「${model}」`, 'INVALID_REQUEST')
    return scheme
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    return this.host.schemes().map(scheme => ({
      provider,
      id: scheme.id,
      name: scheme.name === '' ? `阶段路由/${scheme.id}` : `${scheme.name}（阶段路由）`,
      description: scheme.stages.map(stage => stage.name || stage.id).join(' → '),
    }))
  }

  /**
   * Image input is allowed when any stage model accepts it (or does not say),
   * because dsh checks image prompts against the selected virtual model.
   * The context window is the smallest known one, so compaction stays safe.
   */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const scheme = this.scheme(model)
    const infos = await Promise.all(schemeRoutes(scheme).map(({ route }) =>
      this.host.llm.resolveModelInfo(route.provider, route.model, signal).catch(() => undefined)))
    const known = infos.filter((info): info is LlmResolvedModelInfo => info !== undefined)
    const image = known.length === 0 || known.some(info => info.inputModalities === undefined || info.inputModalities.includes('image'))
    const windows = known.flatMap(info => info.context === undefined ? [] : [info.context.contextWindow])
    const [first] = await this.listModels(provider).then(list => list.filter(item => item.id === model))
    return {
      provider,
      id: model,
      name: first?.name ?? model,
      inputModalities: image ? ['text', 'image'] : ['text'],
      ...windows.length === 0 ? {} : { context: { contextWindow: Math.min(...windows) } },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const scheme = this.scheme(options.model)
    const route = initialRoute(scheme)
    if (route === undefined) throw new LlmError(`stage-router：方案「${scheme.id}」没有阶段`, 'INVALID_REQUEST')
    this.host.warn('stage-router: virtual model %s streamed directly; forwarding to %s/%s', options.model, route.provider, route.model)
    const { reasoningEffort: _ignored, ...rest } = options
    yield * this.host.llm.stream({
      ...rest,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as ReasoningEffortId },
    })
  }
}
