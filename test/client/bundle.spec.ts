// Loads the built lib/client.js the way the dsh 0.1.7 Web host does and
// drives its apply() against a fake client context.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../../scripts/platform-modules.mjs'

const nodeRequire = createRequire(import.meta.url)

interface Loaded { id: string; exports: { inject: unknown; apply: (ctx: unknown) => void } }

function loadBundle(): Loaded {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  let captured: Loaded | undefined
  const window = {
    __ModuleLoader__: {
      load: ({ id, factory }: { id: string; factory: (require: (name: string) => unknown) => Loaded['exports'] }) => {
        const require = (name: string) => {
          if (!PLATFORM_MODULES.includes(name)) throw new Error(`module table has no "${name}"`)
          return nodeRequire(name)
        }
        captured = { id, exports: factory(require) }
      },
    },
  }
  new Function('window', source)(window)
  if (captured === undefined) throw new Error('bundle did not register')
  return captured
}

function fakeContext(execute: (sessionId: string, line: string) => Promise<unknown>) {
  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const locales: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    locale: { register: (ns: string) => { locales.push(ns); return () => {} } },
    slots: {
      inject: (_name: string, cb: () => void) => cb(),
      register: (options: Record<string, unknown>, component: unknown) => { registrations.push({ options, component }); return () => {} },
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => cb({
      effect: (fn: () => unknown) => { fn() },
      remote: { commands: { execute: (sessionId: string, line: string) => execute(sessionId, line) } },
    }),
  }
  return { ctx, registrations, locales }
}

describe('lib/client.js', () => {
  it('registers under the package id and requires only platform modules', () => {
    const loaded = loadBundle()
    expect(loaded.id).toBe('dsh-stage-router')
    expect(loaded.exports.inject).toEqual(['slots', 'locale'])
    expect(typeof loaded.exports.apply).toBe('function')
  })

  it('registers the chip and the turn tail, and runs /stage through the commands remote', async () => {
    const lines: string[] = []
    const { ctx, registrations, locales } = fakeContext(async (_sessionId, line) => {
      lines.push(line)
      return line.endsWith('nope')
        ? { ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'Unknown stage "nope".' } } }
        : { ok: true, value: { commandId: 'c', result: { kind: 'success', text: 'ok' } } }
    })
    loadBundle().exports.apply(ctx)
    expect(locales).toEqual(['stage-router'])
    expect(registrations.map(r => [r.options.name, r.options.id])).toEqual([
      ['conversation.input.right', 'dsh-stage-router'],
      ['conversation.chat.turnTail', 'dsh-stage-router'],
    ])
    const face = (registrations[0]!.options.inject as (sessionId: string) => { runStage: (args: string) => Promise<string | null> })('s1')
    expect(await face.runStage('review')).toBeNull()
    expect(await face.runStage('nope')).toBe('Unknown stage "nope".')
    expect(lines).toEqual(['/stage review', '/stage nope'])
  })
})
