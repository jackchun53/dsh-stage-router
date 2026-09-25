// Settings editor e2e (manual; not part of `pnpm test`): `pnpm test:web:editor [screenshot.png]`.
// Settings → Stage router (its own settings section): try Jev on the draft,
// rename the scheme and move the Code stage to another model, save; then
// check the profile file (token kept) and that routing and the picker picked
// it up live. Screenshots: <shot> (overview), <shot>-jev.png, <shot>-stages.png, <shot>-transitions.png.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, onboard, root, send } from './boot.mjs'

const shot = process.argv[2] ?? join(root, 'web-editor.png')
const run = await boot()
const { page } = run
const result = { ok: false }
try {
  await page.goto(run.url)
  await onboard(page)
  await page.getByText('设置').last().click()
  const settings = page.getByRole('dialog')
  await settings.getByRole('button', { name: '阶段路由', exact: true }).click()
  await settings.getByLabel('名称', { exact: true }).waitFor({ timeout: 30_000 })
  await page.screenshot({ path: shot })

  // The saved token never reaches the page.
  await settings.getByRole('tab', { name: 'Jev', exact: true }).click()
  result.tokenField = await settings.getByLabel('Token', { exact: true }).inputValue()
  result.tokenPlaceholder = await settings.getByLabel('Token', { exact: true }).getAttribute('placeholder')

  // Try Jev on the unsaved draft.
  const tryIt = settings.getByRole('region', { name: '试一试' })
  await tryIt.getByLabel('当前阶段').selectOption('code')
  await tryIt.getByLabel('用户消息').fill('JUDGE=plan 这个模块该怎么拆？')
  await tryIt.getByRole('button', { name: '运行 Jev' }).click()
  await tryIt.getByText('进入 规划').waitFor({ timeout: 30_000 })
  result.tryIt = await tryIt.getByRole('status').innerText()
  await page.screenshot({ path: shot.replace(/\.png$/, '-jev.png') })
  await settings.getByRole('tab', { name: '阶段', exact: true }).click()
  await page.screenshot({ path: shot.replace(/\.png$/, '-stages.png') })
  await settings.getByRole('tab', { name: '转换', exact: true }).click()
  await page.screenshot({ path: shot.replace(/\.png$/, '-transitions.png') })

  // Edit and save.
  await settings.getByRole('tab', { name: '概览', exact: true }).click()
  await settings.getByLabel('名称', { exact: true }).fill('测试（改）')
  await settings.getByLabel('编码 · 模型', { exact: true }).selectOption('m-light')
  const save = settings.getByRole('button', { name: '保存', exact: true })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === '保存')
    return button !== undefined && !button.disabled
  }, undefined, { timeout: 15_000 })
  await save.click()
  await settings.getByText('已保存', { exact: true }).waitFor({ timeout: 30_000 })
  const patch = readFileSync(run.patchPath, 'utf8')
  result.persisted = { name: patch.includes('测试（改）'), model: /model: m-light/.test(patch), token: patch.includes('test-token') }

  // Live: the picker lists the new name and the Code stage routes to m-light.
  await settings.getByRole('button', { name: '关闭' }).click()
  await page.getByText(/测试（改）（阶段路由）/).first().waitFor({ timeout: 30_000 })
  await send(page, 'JUDGE=code write it')
  await page.getByRole('button', { name: /编码 · m-light/ }).first().waitFor({ timeout: 60_000 })
  result.main = run.llmCalls().filter(c => c.kind === 'main').map(c => `${c.provider}/${c.model}`)
  result.ok = result.persisted.name && result.persisted.model && result.persisted.token && result.tokenField === ''
    && result.main.at(-1) === 'fake/m-light'
  result.errors = run.errors
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  await page.screenshot({ path: `${shot}.fail.png` }).catch(() => {})
  console.log(JSON.stringify({
    ...result, error: String(error).slice(0, 500), errors: run.errors,
    page: (await page.locator('body').innerText().catch(() => '')).slice(0, 2000),
    server: run.serverOutput().slice(-1500),
  }, null, 2))
  process.exitCode = 1
} finally {
  await run.close()
}
