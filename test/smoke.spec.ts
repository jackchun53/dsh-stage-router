import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('plugin module', () => {
  it('exports the cordis plugin surface', () => {
    expect(plugin.name).toBe('stage-router')
    expect(plugin.inject).toContain('llm')
    expect(typeof plugin.apply).toBe('function')
  })

  it('parses an empty config', () => {
    expect(() => plugin.Config({})).not.toThrow()
  })
})
