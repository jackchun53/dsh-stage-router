// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXAMPLE_SCHEME } from '../../src/config/defaults.js'
import { DEFAULT_JEV, type StageRouterConfig } from '../../src/config/schema.js'
import { zh } from '../../src/client/locales.js'
import { EditorApiError, type EditorApi } from '../../src/client/editor/api.js'
import { StageRouterEditor } from '../../src/client/editor/Editor.js'

afterEach(cleanup)

const t = (key: string, params: Record<string, unknown> = {}) =>
  (zh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))

const config = (): StageRouterConfig => ({ jev: { ...DEFAULT_JEV }, schemes: [structuredClone(EXAMPLE_SCHEME)] })

function fakeApi(patch: Partial<EditorApi> = {}) {
  const api: EditorApi = {
    getConfig: vi.fn(async () => ({ config: config(), revision: 7, writable: true, jevTokenSet: true })),
    validate: vi.fn(async () => []),
    save: vi.fn(async draft => ({ config: draft, revision: 8, writable: true, jevTokenSet: true, warnings: [] })),
    tryJudge: vi.fn(async () => ({
      candidates: ['plan', 'code', 'review'],
      judgement: { ok: true as const, stage: 'plan', confidence: 0.8, reason: '', elapsedMs: 42, probabilities: { plan: 0.8, code: 0.15, review: 0.05 } },
      decision: { kind: 'goto' as const, stage: 'plan', reason: 'Jev 判断（置信度 80%）' },
      issues: [],
    })),
    catalog: vi.fn(async () => [{
      id: 'deepseek-official', name: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'Flash', efforts: [{ id: 'off', name: 'Off' }] },
        { id: 'deepseek-v4-pro', name: 'V4 Pro', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
      ],
    }]),
    judgeLog: vi.fn(async () => []),
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
    await screen.findByText('1 个错误')
    expect(screen.getByText('unknown stage "x"')).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('treats unavailable models as warnings that do not block saving', async () => {
    const api = fakeApi({ validate: vi.fn(async () => [{ path: 'schemes[0].stages[0].route', message: '模型 deepseek-official/deepseek-v4-pro 当前不可用', severity: 'warning' as const }]) })
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
    expect(screen.queryByLabelText('编码 · ID')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开 编码' }))
    const id = screen.getByLabelText('编码 · ID')
    fireEvent.blur(id, { target: { value: 'build' } })
    fireEvent.click(screen.getByRole('tab', { name: '概览' }))
    expect((screen.getByLabelText('初始阶段') as HTMLSelectElement).value).toBe('build')
  })

  it('picks every stage and tier model on the overview', async () => {
    const api = fakeApi()
    renderEditor(api)
    const effort = await screen.findByLabelText('规划 · 推理强度') as HTMLSelectElement
    await waitFor(() => expect([...effort.options].map(o => o.value)).toEqual(['', 'high', 'max']))
    expect(effort.value).toBe('max')
    // A stage with tiers keeps its own picker (no todo in progress) plus one per tier.
    expect(screen.getByLabelText('编码 · 模型')).toBeTruthy()
    const light = screen.getByLabelText('编码 · light · 模型') as HTMLSelectElement
    expect(screen.getByLabelText('编码 · heavy · 模型')).toBeTruthy()
    fireEvent.change(light, { target: { value: 'deepseek-v4-pro' } })
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    const code = vi.mocked(api.save).mock.calls[0]![0].schemes[0]!.stages.find(stage => stage.id === 'code')!
    expect(code.tiers!.levels.find(level => level.id === 'light')!.route.model).toBe('deepseek-v4-pro')
  })

  it('jumps from the overview to a stage card, opened', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('button', { name: '审查' }))
    expect(screen.getByRole('tab', { name: '阶段' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('审查 · 阶段提示词')).toBeTruthy()
    expect(screen.queryByLabelText('规划 · 阶段提示词')).toBeNull()
  })

  it('adds and duplicates schemes from the toolbar', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    const picker = screen.getByRole('combobox', { name: '方案' }) as HTMLSelectElement
    fireEvent.click(screen.getByRole('button', { name: '复制方案' }))
    expect([...picker.options].map(o => o.text)).toEqual(['研发默认', '研发默认 (copy)'])
    expect(picker.value).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: '新建方案' }))
    expect(picker.options).toHaveLength(3)
    expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('scheme')
    fireEvent.change(picker, { target: { value: '0' } })
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('研发默认')
  })

  it('draws the transition graph and edits rules', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '转换' }))
    expect(screen.getByRole('img', { name: '阶段转换图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(screen.getAllByLabelText(/^事件 \d+$/)).toHaveLength(5)
  })

  it('tries Jev on the unsaved draft and shows its probabilities', async () => {
    const api = fakeApi()
    renderEditor(api)
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: 'Jev' }))
    const panel = screen.getByRole('region', { name: '试一试' })
    fireEvent.change(within(panel).getByLabelText('用户消息'), { target: { value: '这个模块怎么拆？' } })
    fireEvent.change(within(panel).getByLabelText('当前阶段'), { target: { value: 'code' } })
    fireEvent.click(within(panel).getByRole('button', { name: '运行 Jev' }))
    await within(panel).findByText('进入 规划')
    expect(within(panel).getByText('Jev 判断（置信度 80%）')).toBeTruthy()
    expect(within(panel).getByText('42 ms')).toBeTruthy()
    const meters = within(panel).getAllByRole('meter')
    expect(meters.map(m => [m.getAttribute('aria-label'), m.getAttribute('aria-valuenow')])).toEqual([['规划', '0.8'], ['编码', '0.15'], ['审查', '0.05']])
    expect(vi.mocked(api.tryJudge).mock.calls[0]![0]).toMatchObject({ scheme: 'dev-default', current: 'code', message: '这个模块怎么拆？' })
  })

  it('never shows the saved Jev token and clears it on request', async () => {
    const api = fakeApi()
    renderEditor(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Jev：已配置，点击查看' }))
    const token = screen.getByLabelText('Token') as HTMLInputElement
    expect(token.value).toBe('')
    expect(token.type).toBe('password')
    expect(token.placeholder).toBe('已保存，留空不修改')
    expect(screen.getByText('已配置')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    expect(screen.getByText('未配置 token，判断不会生效')).toBeTruthy()
    expect(screen.getByText('有未保存的修改')).toBeTruthy()
    await waitFor(() => expect(api.validate).toHaveBeenCalledWith(expect.anything(), true))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(vi.mocked(api.save).mock.calls[0]![2]).toBe(true)
  })

  it('sends a newly typed token with the draft', async () => {
    const api = fakeApi({ getConfig: vi.fn(async () => ({ config: config(), revision: 7, writable: true, jevTokenSet: false })) })
    renderEditor(api)
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: 'Jev' }))
    await screen.findByText('未配置 token，判断不会生效')
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'tok-123' } })
    expect(screen.getByText('已配置')).toBeTruthy()
    await waitFor(() => expect(api.validate).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(vi.mocked(api.save).mock.calls[0]![0].jev.token).toBe('tok-123')
  })

  it('routes subagents with switches', async () => {
    renderEditor(fakeApi())
    await screen.findByLabelText('名称')
    fireEvent.click(screen.getByRole('tab', { name: '子 agent' }))
    const enabled = screen.getByRole('switch', { name: '为子 agent 选模型' })
    expect(enabled.getAttribute('aria-checked')).toBe('false')
    expect((screen.getByLabelText('子 agent 阶段') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(enabled)
    expect((screen.getByLabelText('子 agent 阶段') as HTMLSelectElement).disabled).toBe(false)
  })

  it('is read-only when the settings service cannot edit the row', async () => {
    renderEditor(fakeApi({ getConfig: vi.fn(async () => ({ config: config(), revision: -1, writable: false, jevTokenSet: false })) }))
    await screen.findByText('当前 profile 不允许设置服务修改阶段路由，编辑器为只读。')
    expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(true)
  })
})
