import { beforeAll, describe, expect, it } from 'vitest'
import { HeadlessSession, judges, mains, routes, type TurnResult } from './harness.js'

// One session, one scripted conversation; every turn reloads it from storage.
// See fixtures/fake-llm.js for the JUDGE=/TODO/EXITPLAN keywords.
// The code stage sets no reasoning effort, so dsh materializes the fake
// model's default (`high`).
describe('stage routing in a headless session', () => {
  const session = new HeadlessSession()
  const turns: TurnResult[] = []

  beforeAll(() => {
    for (const prompt of [
      'JUDGE=review hello',              // 0: judge picks review
      'JUDGE=review@0.3 still there?',  // 1: low confidence → stay (review survives reload)
      'JUDGE=garbage anything',          // 2: unparsable judge reply → stay
      'JUDGE=code TODO finish it',       // 3: code, then todos_done → review mid-turn
      'JUDGE=plan EXITPLAN plan it',     // 4: plan (+ plan mode), approval → code
      'JUDGE=slow hello',                // 5: judge timeout → stay
      'JUDGE=broken use the broken one', // 6: stage model missing → initial stage model
      'JUDGE=code TIERS1 start',         // 7: tagged light todo in progress → light tier
      'JUDGE=code TIERS2 continue',      // 8: untagged "big" todo judged heavy → heavy wins
    ]) {
      turns.push(session.send(prompt))
    }
  })

  it('completes every turn', () => {
    for (const turn of turns) expect(turn.exitCode, turn.stderr.slice(-2000)).toBe(0)
    expect(session.sessionId).toBeDefined()
  })

  it('routes the first message by the judge, without a session id on the judge call', () => {
    const [first] = turns
    expect(judges(first!)).toHaveLength(1)
    expect(judges(first!)[0]).toMatchObject({ provider: 'fake', model: 'm-judge', reasoningEffort: 'off' })
    expect(routes(first!)).toEqual(['fake/m-review@high'])
    expect(first!.final).toBe('reply from fake/m-review')
  })

  it('injects the stage prompt and one stage notice', () => {
    const [main] = mains(turns[0]!)
    expect(main!.system).toContain('STAGE_PROMPT_REVIEW')
    expect(main!.notices).toHaveLength(1)
    expect(main!.notices[0]).toContain('stage "review"')
  })

  it('restores the stage after reload and stays on low confidence or a bad judge reply', () => {
    expect(routes(turns[1]!)).toEqual(['fake/m-review@high'])
    expect(routes(turns[2]!)).toEqual(['fake/m-review@high'])
    // no new notice when nothing changed
    expect(mains(turns[1]!)[0]!.notices).toHaveLength(1)
    expect(mains(turns[2]!)[0]!.notices).toHaveLength(1)
  })

  it('moves to review when every todo is done, within the same turn', () => {
    expect(routes(turns[3]!)).toEqual(['fake/m-code@high', 'fake/m-review@high'])
    const [, review] = mains(turns[3]!)
    expect(review!.system).toContain('STAGE_PROMPT_REVIEW')
    expect(review!.notices.at(-1)).toContain('stage "review"')
  })

  it('enters plan mode with the plan stage and follows plan approval to code', () => {
    const plan = mains(turns[4]!)
    expect(routes(turns[4]!)).toEqual(['fake/m-plan@max', 'fake/m-code@high'])
    expect(plan[0]!.system).toContain('STAGE_PROMPT_PLAN')
    // plan mode entered in the same step: its policy section and narration are there
    expect(plan[0]!.system).toMatch(/plan mode/i)
    expect(plan[0]!.userSourceKinds).toContain('plan-mode')
    expect(plan[1]!.system).not.toContain('STAGE_PROMPT_PLAN')
    expect(plan[1]!.system).not.toMatch(/plan mode/i)
  })

  it('stays in the current stage when the judge times out', () => {
    expect(judges(turns[5]!)).toHaveLength(1)
    expect(routes(turns[5]!)).toEqual(['fake/m-code@high'])
  })

  it('falls back to the initial stage model when a stage model is missing', () => {
    expect(routes(turns[6]!)).toEqual(['fake/m-code@high'])
    expect(mains(turns[6]!)[0]!.notices.at(-1)).toContain('stage "broken" (Broken), model fake/m-code')
  })

  it('never lets dsh model-change notices reach the model', () => {
    for (const turn of turns) {
      for (const call of mains(turn)) expect(call.userSourceKinds).not.toContain('model-selection')
    }
  })

  it('routes by the planner-tagged tier of the in-progress todo', () => {
    expect(routes(turns[7]!)).toEqual(['fake/m-code@high', 'fake/m-light@off'])
    expect(mains(turns[7]!)[1]!.notices.at(-1)).toContain('tier light')
  })

  it('judges untagged todos and lets the heaviest in-progress tier win', () => {
    expect(routes(turns[8]!)).toEqual(['fake/m-code@high', 'fake/m-heavy@max'])
    expect(judges(turns[8]!).length).toBeGreaterThanOrEqual(2)
  })
})
