// Shared boot for the Web e2e scripts (browser locale zh-CN, so dsh and the plugin are both Chinese): an isolated DSH_HOME with this package
// installed into the web profile, the fake provider and the test scheme from
// the integration fixtures, `dsh web` on a free port, and headless Chromium.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)

export async function boot() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
  const dsh = join(root, 'node_modules/.bin/dsh')
  const home = mkdtempSync(join(tmpdir(), 'stage-router-web-'))
  mkdirSync(join(home, 'user'))
  const env = {
    ...process.env, HOME: join(home, 'user'), DSH_HOME: join(home, 'home'), DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', FAKE_LLM_LOG: join(home, 'llm.jsonl'),
  }
  const add = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', root], { env, encoding: 'utf8' })
  if (add.status !== 0) throw new Error(`plugin add failed:\n${add.stderr}`)

  // User layer: fake provider, test scheme as the default model.
  const fixture = readFileSync(join(root, 'test/integration/fixtures/profile.patch.yml'), 'utf8')
  const schemeConfig = fixture.slice(fixture.indexOf('      config:\n        defaultJudge:')).replace(/^ {6}/gm, '  ')
  const patchPath = join(env.DSH_HOME, 'profiles/web/cordis.patch.yml')
  writeFileSync(patchPath, `- id: agent-default-model
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

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })

  return {
    env, home, url, page, errors, patchPath,
    serverOutput: () => output,
    llmCalls: () => {
      try {
        return readFileSync(env.FAKE_LLM_LOG, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      } catch { return [] }
    },
    async close() {
      await browser.close()
      server.kill()
    },
  }
}

/** Dismiss the first-run notice and pick the (isolated) home directory as the workspace. */
export async function onboard(page) {
  const proceed = page.getByRole('button', { name: /^(Continue|继续)$/ })
  await proceed.waitFor({ timeout: 60_000 }).then(() => proceed.click(), () => {})
  const choose = page.getByText(/^(Choose workspace|选择工作区)$/).first()
  if (await choose.isVisible().catch(() => false)) {
    await choose.click()
    await page.getByRole('button', { name: /^(Open|打开)$/ }).click()
  }
}

/** Type a message into the composer and send it. */
export async function send(page, text) {
  const composer = page.locator('[role="textbox"][contenteditable="true"]').last()
  await composer.waitFor({ timeout: 60_000 })
  await composer.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}
