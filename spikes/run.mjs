// Phase 0 driver: runs the scripted multi-turn session through `dsh headless`,
// one process per turn (every turn after the first reloads the session from storage),
// then prints the probe log. Usage: node run.mjs [scenario] ; env passes through.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const here = resolve(import.meta.dirname)
const scenario = process.argv[2] ?? 'main'
const work = join(here, '.dsh-home', scenario)
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'cwd'), { recursive: true })
const logFile = join(work, 'probe.jsonl')

const env = {
  ...process.env,
  DSH_HOME: join(work, 'home'),
  DSH_AGENTS_HOME: join(work, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'danger-full-access',
  SPIKE_LOG: logFile,
}

const turns = {
  main: [
    'STAGE=code hello',
    'STAGE=review TODO please write todos',
    'STAGE=plan PLANON EXITPLAN plan something',
    'CMD after plan',
  ],
  short: ['STAGE=code hello', 'STAGE=review again'],
}[scenario] ?? ['STAGE=code hello', 'STAGE=review again']

let sessionId
for (const [i, prompt] of turns.entries()) {
  const args = ['dsh', '--profile', 'headless', '--patch', join(here, 'spike.patch.yml'), '--json']
  if (sessionId) args.push('--session-id', sessionId)
  args.push(prompt)
  const r = spawnSync('npx', args, { cwd: join(work, 'cwd'), env, encoding: 'utf8', timeout: 180000 })
  const lines = r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { raw: l } } })
  sessionId ??= lines.find(l => l.type === 'session')?.sessionId
  const final = lines.find(l => l.type === 'final')
  console.log(`--- turn ${i + 1}: exit=${r.status} session=${sessionId} final=${JSON.stringify(final)?.slice(0, 200)}`)
  if (r.status !== 0) console.log(r.stderr.slice(-3000), lines.slice(-5))
}
console.log('=== probe log')
if (existsSync(logFile)) console.log(readFileSync(logFile, 'utf8'))
