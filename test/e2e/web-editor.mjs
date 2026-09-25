// Settings editor e2e (manual; not part of `pnpm test`): `pnpm test:web:editor [screenshot.png]`.
// Settings → Built-in plugins → Stage router: try the judge on the draft,
// rename the scheme and move the Code stage to another model, save; then
// check the profile file and that routing and the picker picked it up live.
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
  await page.getByText('Settings').last().click()
  const settings = page.getByRole('dialog')
  await settings.getByText('Built-in plugins').click()
  await settings.getByText('Stage router', { exact: true }).click()
  await settings.getByLabel('Name', { exact: true }).waitFor({ timeout: 30_000 })

  // Try it on the unsaved draft.
  await settings.getByRole('tab', { name: 'Judge & subagents' }).click()
  const tryIt = settings.getByRole('region', { name: 'Try it' })
  await tryIt.getByLabel('Current stage').selectOption('code')
  await tryIt.getByLabel('User message').fill('JUDGE=plan how should we split this?')
  await tryIt.getByRole('button', { name: 'Run the judge' }).click()
  const decision = tryIt.getByText(/^Result: /)
  await decision.waitFor({ timeout: 30_000 })
  result.tryIt = await tryIt.getByRole('status').innerText()
  await page.screenshot({ path: shot })

  // Edit and save.
  await settings.getByRole('tab', { name: 'Basics' }).click()
  await settings.getByLabel('Name', { exact: true }).fill('Test edited')
  await settings.getByRole('tab', { name: 'Stages' }).click()
  await settings.getByLabel('Code · Model', { exact: true }).selectOption('m-light')
  const save = settings.getByRole('button', { name: 'Save', exact: true })
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save')
    return button !== undefined && !button.disabled
  }, undefined, { timeout: 15_000 })
  await save.click()
  await settings.getByText('Saved', { exact: true }).waitFor({ timeout: 30_000 })
  const patch = readFileSync(run.patchPath, 'utf8')
  result.persisted = { name: patch.includes('Test edited'), model: /model: m-light/.test(patch) }

  // Live: the picker lists the new name and the Code stage routes to m-light.
  await settings.getByRole('button', { name: 'Close' }).click()
  await page.getByText(/Test edited \(stage-router\)/).first().waitFor({ timeout: 30_000 })
  await send(page, 'JUDGE=code write it')
  await page.getByRole('button', { name: /Code · m-light/ }).first().waitFor({ timeout: 60_000 })
  result.main = run.llmCalls().filter(c => c.kind === 'main').map(c => `${c.provider}/${c.model}`)
  result.ok = result.persisted.name && result.persisted.model && result.main.at(-1) === 'fake/m-light'
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
