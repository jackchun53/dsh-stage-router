import { describe, expect, it } from 'vitest'
// The built entry: src/index.ts pulls in TC39 decorators, which tsc lowers but vitest does not.
import * as plugin from '../lib/index.js'

describe('plugin module', () => {
  it('exports the cordis plugin surface', () => {
    expect(plugin.name).toBe('stage-router')
    expect(plugin.inject).toContain('llm')
    expect(typeof plugin.apply).toBe('function')
  })

  it('parses an empty config', () => {
    expect(plugin.Config({}).schemes.get()).toEqual([])
  })
})
