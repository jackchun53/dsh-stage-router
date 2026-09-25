// Web UI smoke test (manual; not part of `pnpm test`):
//   node test/e2e/web-ui.mjs [screenshot.png]
// Boots `dsh web` in an isolated DSH_HOME with this package installed into
// the web profile, the fake provider from the integration fixtures and the
// test scheme, then drives headless Chromium: send one message, expect the
// stage chip and the per-turn summary, and no page errors.
// Needs Playwright (global install or NODE_PATH) and its Chromium.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const shot = process.argv[2] ?? join(root, 'web-ui.png')
const dsh = join(root, 'node_modules/.bin/dsh')
const home = mkdtempSync(join(tmpdir(), 'stage-router-web-'))
mkdirSync(join(home, 'user'))
const env = { ...process.env, HOME: join(home, 'user'), DSH_HOME: join(home, 'home'), DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', FAKE_LLM_LOG: join(home, 'llm.jsonl') }

const add = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', root], { env, encoding: 'utf8' })
if (add.status !== 0) throw new Error(`plugin add failed:\n${add.stderr}`)

// User layer: fake provider, test scheme as the default model.
const fixture = readFileSync(join(root, 'test/integration/fixtures/profile.patch.yml'), 'utf8')
const schemeConfig = fixture.slice(fixture.indexOf('      config:\n        defaultJudge:'))
  .replace(/^ {6}/gm, '  ')
writeFileSync(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml'), `- id: agent-default-model
  config: { provider: stage-router, model: test }
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: session-title-llm
  disabled: true
- insert:
    - id: fake-llm
      name: ${join(root, 'test/integration/fixtures/fake-llm.js')}
- id: stage-router
${schemeConfig}`)

const server = spawn(dsh, ['--profile', 'web', '--no-open', '--port', '0'], { env, cwd: home })
let output = ''
const url = await new Promise((resolveUrl, reject) => {
  const timer = setTimeout(() => reject(new Error(`dsh web did not start:\n${output}`)), 120_000)
  const onData = chunk => {
    output += chunk
    const match = /(http:\/\/\S+token=\S+)/.exec(output)
    if (match) { clearTimeout(timer); resolveUrl(match[1]) }
  }
  server.stdout.on('data', onData)
  server.stderr.on('data', onData)
})

/** Dismiss the first-run notice and pick the test directory as the workspace. */
async function onboard(page) {
  const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ })
  await proceed.waitFor({ timeout: 60_000 }).then(() => proceed.click(), () => {})
  const choose = page.getByText(/^(Choose workspace|选择工作区)$/).first()
  if (await choose.isVisible().catch(() => false)) {
    await choose.click()
    await page.getByRole('button', { name: /^(Open|打开)$/ }).click()
  }
  if (process.env.E2E_STEP === 'workspace') {
    await page.waitForTimeout(2000)
    await page.screenshot({ path: shot })
    console.log((await page.locator('body').innerText()).slice(0, 2000))
    process.exit(0)
  }
}

const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
try {
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
  await page.goto(url)
  await onboard(page)
  await page.locator('[data-composer-placeholder]').first().waitFor({ timeout: 60_000 })
  if (process.env.E2E_STEP === 'dom') {
    console.log(await page.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable], input')]
      .map(el => `${el.tagName} ce=${el.getAttribute('contenteditable')} role=${el.getAttribute('role')} aria=${el.getAttribute('aria-label')} cls=${el.className} visible=${el.getBoundingClientRect().width}x${el.getBoundingClientRect().height}`).join('\n')))
    process.exit(0)
  }
  const composer = page.locator('[role="textbox"][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 60_000 })
  await composer.click()
  await page.keyboard.type('JUDGE=review hello')
  await page.keyboard.press('Enter')
  const chip = page.getByRole('button', { name: /Review · m-review@high|Stage router|阶段路由/ })
  await chip.first().waitFor({ timeout: 60_000 })
  const tail = page.getByText(/(本轮|This turn)：?:? .*Review/)
  await tail.first().waitFor({ timeout: 30_000 })
  // The picker must keep showing the scheme, not the routed real model.
  const picker = page.getByText(/Test \(stage-router\)/)
  await picker.first().waitFor({ timeout: 10_000 })
  await chip.first().click()
  await page.getByRole('dialog').waitFor({ timeout: 10_000 })
  const dialog = (await page.getByRole('dialog').textContent())?.slice(0, 200)

  // Lock to Plan from the panel (runs /stage plan through remote.commands),
  // then the next message must go to the plan model without judging.
  await page.getByRole('dialog').getByRole('button', { name: 'Plan', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 15_000 })
  await composer.click()
  await page.keyboard.type('JUDGE=review second')
  await page.keyboard.press('Enter')
  const lockedChip = page.getByRole('button', { name: /Plan · m-plan@max/ })
  await lockedChip.first().waitFor({ timeout: 60_000 })
  await page.screenshot({ path: shot })
  console.log(JSON.stringify({
    ok: true,
    chip: await chip.first().textContent(),
    tail: await tail.first().textContent(),
    picker: await picker.first().textContent(),
    dialog,
    lockedChip: await lockedChip.first().textContent(),
    llm: readFileSync(env.FAKE_LLM_LOG, 'utf8').split('\n').filter(Boolean)
      .map(line => { const c = JSON.parse(line); return `${c.kind} ${c.provider ?? ''}/${c.model ?? ''}` }),
    errors,
    screenshot: shot,
  }, null, 2))
} catch (error) {
  await page.screenshot({ path: shot }).catch(() => {})
  let llm = ''
  try { llm = readFileSync(env.FAKE_LLM_LOG, 'utf8') } catch {}
  console.log(JSON.stringify({
    ok: false, error: String(error).slice(0, 400), errors, screenshot: shot,
    page: (await page.locator('body').innerText().catch(() => '')).slice(0, 1500),
    llm: llm.split('\n').filter(Boolean).map(line => { const c = JSON.parse(line); return `${c.kind} ${c.provider}/${c.model}` }),
    server: output.slice(-1500),
  }, null, 2))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
