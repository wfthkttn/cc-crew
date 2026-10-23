import { expect, test } from 'claude-code/testing'

import { ClaudeAgents } from '../hooks/agents.ts'
import { wrap } from '../hooks/brief.ts'
import { OVERVIEW_COLUMNS, actionAt, overviewLines } from '../hooks/overview.ts'
import type { OverviewProps } from '../hooks/overview-props.ts'
import { shortCount, tokensOf } from '../hooks/usage.ts'

// Trimmed from live reports, 2026-10-23.
test("each provider's usage reads as tokens in (cache included) and out", () => {
  expect(tokensOf('codex', { input_tokens: 836870, cached_input_tokens: 727680, output_tokens: 4240, reasoning_output_tokens: 676 })).toEqual({
    in: 836870,
    cached: 727680,
    out: 4240,
    reasoning: 676,
  })
  expect(tokensOf('antigravity', { input_tokens: 208783, output_tokens: 31359, thinking_tokens: 28738, cache_read_tokens: 945520, total_tokens: 240142 })).toEqual({
    in: 1154303,
    cached: 945520,
    out: 31359,
    reasoning: 28738,
  })
  expect(tokensOf('claude', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, model: 'x' })).toEqual({
    in: 130,
    cached: 100,
    out: 5,
  })
  expect(tokensOf('codex', undefined)).toBe(undefined)
  expect([shortCount(950), shortCount(8400), shortCount(1_154_303)]).toEqual(['950', '8k', '1.2M'])
})

const PROPS: OverviewProps = {
  runs: [
    {
      id: 'r1',
      description: 'vault windows port review',
      elapsed: '4:12',
      reviewers: [
        { key: 'codex-default', provider: 'codex', pick: 'medium', status: 'running', elapsed: '4:12', isRunning: true, tokens: null },
        { key: 'claude-opus', provider: 'claude', pick: 'opus · medium', status: 'ok', elapsed: '2:31', isRunning: false, tokens: '212k in · 9k out' },
      ],
    },
  ],
  agents: [{ id: 'a1', type: 'Explore', description: 'find the parser', status: 'running', elapsed: '0:42', tokens: null }],
}

const text = (props: OverviewProps) => overviewLines(props).map(line => line.map(s => s.text).join(''))

test('the running list fits the drawer: a run, its reviewers, then Claude agents', () => {
  const lines = text(PROPS)
  expect(lines.map(l => [...l].length)).toEqual(lines.map(() => OVERVIEW_COLUMNS))
  expect(lines[0]).toStartWith('Crew reviews')
  expect(lines[1]).toContain('vault windows port review')
  expect(lines[1]).toContain('▐⧉ Brief▌ ▐■ Stop▌')
  expect(lines[2]).toContain('▐■ Stop▌')
  expect(lines[3]).toContain('212k in · 9k out')
  expect(lines[4]).toStartWith('Claude agents')
  expect(lines[5]).toContain('find the parser')
  expect(text({ runs: [], agents: [] })[0]).toStartWith('Nothing runs now.')
})

test('every cell of a button takes the press; text beside it takes none', () => {
  const lines = text(PROPS)
  const runStop = lines[1]!.indexOf('▐■ Stop▌')
  const brief = lines[1]!.indexOf('▐⧉ Brief▌')
  for (const x of [runStop, runStop + 7]) expect(actionAt(PROPS, x, 1)).toEqual({ stop: { run: 'r1' } })
  expect(actionAt(PROPS, brief + 3, 1)).toEqual({ brief: 'r1' })
  expect(actionAt(PROPS, lines[2]!.indexOf('▐■ Stop▌') + 2, 2)).toEqual({ stop: { run: 'r1', key: 'codex-default' } })
  expect(actionAt(PROPS, 2, 1)).toBe(null)
  expect(actionAt(PROPS, 60, 3)).toBe(null)
})

test("Claude's agents run until their turn ends, then sum what each turn spent; the engine's list wins while it lists them", () => {
  const agents = new ClaudeAgents()
  agents.started({ id: 'a1', type: 'Explore', description: 'look', startedAt: 0 })
  agents.started({ id: 'w1', type: 'general-purpose', description: 'review:bugs', workflow: 'wf_1', startedAt: 0 })
  expect(agents.finished('a1', true, { in: 10, cached: 0, out: 2 })).toBe(true)
  expect(agents.finished('nobody', true, undefined)).toBe(false)
  agents.refresh([{ id: 'a1', description: 'look', type: 'Explore', status: 'running' }])
  expect(agents.finished('a1', false, { in: 5, cached: 1, out: 1 })).toBe(true)
  expect(agents.all().map(a => [a.id, a.status, a.tokens])).toEqual([
    ['a1', 'failed', { in: 15, cached: 1, out: 3 }],
    ['w1', 'running', undefined],
  ])
})

test('a brief wraps at spaces, and a word longer than a line is cut', () => {
  expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b'])
})
