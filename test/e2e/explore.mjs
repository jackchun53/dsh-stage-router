// Scratch helper: boot, onboard, run steps from argv as JS, dump body text + screenshot.
import { boot, onboard } from './boot.mjs'
const run = await boot()
const { page } = run
try {
  await page.goto(run.url)
  await onboard(page)
  for (const step of process.argv.slice(3)) await eval(`(async () => { ${step} })()`)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: process.argv[2] })
  console.log((await page.locator('body').innerText()).slice(0, 3000))
  console.log('ERRORS', run.errors)
} finally { await run.close() }
