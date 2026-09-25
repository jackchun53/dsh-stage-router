// Web UI smoke test (manual; not part of `pnpm test`): `pnpm test:web [screenshot.png]`.
// One routed turn → stage chip, per-turn summary, picker keeps the scheme;
// lock Plan from the panel → the next turn goes to the plan model, no judge.
import { join } from 'node:path'
import { boot, onboard, root, send } from './boot.mjs'

const shot = process.argv[2] ?? join(root, 'web-ui.png')
const run = await boot()
const { page } = run
try {
  await page.goto(run.url)
  await onboard(page)
  await send(page, 'JUDGE=review hello')
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
  await send(page, 'JUDGE=review second')
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
    llm: run.llmCalls().map(c => `${c.kind} ${c.provider ?? ''}/${c.model ?? ''}`),
    errors: run.errors,
    screenshot: shot,
  }, null, 2))
} catch (error) {
  await page.screenshot({ path: shot }).catch(() => {})
  console.log(JSON.stringify({
    ok: false, error: String(error).slice(0, 400), errors: run.errors, screenshot: shot,
    page: (await page.locator('body').innerText().catch(() => '')).slice(0, 1500),
    llm: run.llmCalls().map(c => `${c.kind} ${c.provider ?? ''}/${c.model ?? ''}`),
    server: run.serverOutput().slice(-1500),
  }, null, 2))
  process.exitCode = 1
} finally {
  await run.close()
}
