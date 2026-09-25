// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXAMPLE_SCHEME } from '../../src/config/defaults.js'
import { DEFAULT_JUDGE, type StageRouterConfig } from '../../src/config/schema.js'
import { zh } from '../../src/client/locales.js'
import { EditorApiError, type EditorApi } from '../../src/client/editor/api.js'
import { StageRouterEditor } from '../../src/client/editor/Editor.js'

afterEach(cleanup)

const t = (key: string, params: Record<string, unknown> = {}) =>
  (zh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

const config = (): StageRouterConfig => ({ defaultJudge: DEFAULT_JUDGE, schemes: [structuredClone(EXAMPLE_SCHEME)] })

function fakeApi(patch: Partial<EditorApi> = {}) {
  const api: EditorApi = {
    getConfig: vi.fn(async () => ({ config: config(), revision: 7, writable: true })),
    validate: vi.fn(async () => []),
    save: vi.fn(async draft => ({ config: draft, revision: 8, writable: true, warnings: [] })),
    tryJudge: vi.fn(async () => ({
      candidates: ['plan', 'code', 'review'],
      judgement: { ok: true as const, stage: 'plan', confidence: 0.8, reason: 'design talk', elapsedMs: 42 },
      decision: { kind: 'goto' as const, stage: 'plan', reason: 'judge: design talk' },
      issues: [],
    })),
    catalog: vi.fn(async () => [{
      id: 'deepseek-official', name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'Flash', efforts: [{ id: 'off', name: 'Off' }] },
        { id: 'deepseek-v4-pro', name: 'V4 Pro', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
      ],
    }]),
    ...patch,
  }
  return api
}

const renderEditor = (api: EditorApi) => render(<StageRouterEditor {...({ api, t } as unknown as Parameters<typeof StageRouterEditor>[0])} />)

describe('StageRouterEditor', () => {
  it('loads the config and saves an edited scheme name with the revision', async () => {
    const api = fakeApi()
    renderEditor(api)
    const name = await screen.findByLabelText('名称')
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(name, { target: { value: '研发（新）' } })
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    fireEvent.click(save)
    await screen.findByText('已保存')
    const [draft, revision] = vi.mocked(api.save).mock.calls[0]!
    expect(draft.schemes[0]!.name).toBe('研发（新）')
    expect(revision).toBe(7)
  })

  it('blocks saving while the host reports errors, and shows them on the field', async () => {
    const api = fakeApi({ validate: vi.fn(async () => [{ path: 'schemes[0].initialStage', message: 'unknown stage "x"' }]) })
    renderEditor(api)
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'X' } })
    await screen.findByText('1 个错误，修正后才能保存')
    expect(screen.getByText('unknown stage "x"')).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('treats unavailable models as warnings that do not block saving', async () => {
    const api = fakeApi({ validate: vi.fn(async () => [{ path: 'schemes[0].stages[0].route', message: 'model deepseek-official/deepseek-v4-pro is unavailable' }]) })
    renderEditor(api)
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'X' } })
    await screen.findByText('1 个提醒')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a host rejection with its field issues', async () => {
    const api = fakeApi({ save: vi.fn(async () => { throw new EditorApiError('stage-router/invalid', 'The configuration has errors.', [{ path: 'schemes[0].id', message: 'duplicate scheme id' }]) }) })
    renderEditor(api)
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'X' } })
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存失败：The configuration has errors.')
    expect(screen.getByText('duplicate scheme id')).toBeTruthy()
  })

  it('renames a stage and keeps the initial stage pointing at it', async () => {
    const api = fakeApi()
    renderEditor(api)
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '阶段' }))
    const id = screen.getByLabelText('编码 · ID')
    fireEvent.blur(id, { target: { value: 'build' } })
    fireEvent.click(screen.getByRole('tab', { name: '基本' }))
    expect((screen.getByLabelText('初始阶段') as HTMLSelectElement).value).toBe('build')
  })

  it('offers catalog models and efforts for a stage', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '阶段' }))
    const effort = await screen.findByLabelText('规划 · 推理强度') as HTMLSelectElement
    await waitFor(() => expect([...effort.options].map(o => o.value)).toEqual(['', 'high', 'max']))
    expect(effort.value).toBe('max')
  })

  it('draws the transition graph and edits rules', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '转换' }))
    expect(screen.getByRole('img', { name: '阶段转换图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(screen.getAllByLabelText(/^事件 \d+$/)).toHaveLength(5)
  })

  it('tries the judge on the unsaved draft', async () => {
    const api = fakeApi()
    renderEditor(api)
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '判断器 & 子 agent' }))
    const panel = screen.getByRole('region', { name: '试一试' })
    fireEvent.change(within(panel).getByLabelText('用户消息'), { target: { value: '这个模块怎么拆？' } })
    fireEvent.change(within(panel).getByLabelText('当前阶段'), { target: { value: 'code' } })
    fireEvent.click(within(panel).getByRole('button', { name: '运行判断器' }))
    await within(panel).findByText('结果：进入 规划（judge: design talk）')
    expect(within(panel).getByText('判断：规划，置信度 0.80，42 ms — design talk')).toBeTruthy()
    expect(vi.mocked(api.tryJudge).mock.calls[0]![0]).toMatchObject({ scheme: 'dev-default', current: 'code', message: '这个模块怎么拆？' })
  })

  it('is read-only when the settings service cannot edit the row', async () => {
    renderEditor(fakeApi({ getConfig: vi.fn(async () => ({ config: config(), revision: -1, writable: false })) }))
    await screen.findByText('当前 profile 不允许设置服务修改 stage-router，编辑器为只读。')
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true)
  })
})
