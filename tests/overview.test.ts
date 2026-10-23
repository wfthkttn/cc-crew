import { expect, test } from 'claude-code/testing'

import { type ClaudeAgent, ClaudeAgents } from '../hooks/agents.ts'
import { wrap } from '../hooks/brief.ts'
import { agentRefusal, followUpRefusal, fresh, reviewRefusal } from '../hooks/limits.ts'
import { OVERVIEW_COLUMNS, actionAt, logPageSize, overviewLines } from '../hooks/overview.ts'
import type { OverviewProps, Tab } from '../hooks/overview-props.ts'
import { emptyRecord } from '../hooks/record.ts'
import type { Run } from '../hooks/runs.ts'
import { shortCount, tokensOf } from '../hooks/usage.ts'
import { limitsOf, overviewProps, spentOf } from '../hooks/views.ts'

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
  expect(fresh({ in: 900, cached: 600, out: 40 })).toBe(340)
})

const AT = new Date(2026, 9, 23, 20, 7).getTime()

function run(id: string, statuses: ('running' | 'ok' | 'stopped')[], over: Partial<Run> = {}): Run {
  return {
    id,
    description: `review ${id}`,
    createdAt: AT,
    reportDir: `/p/.claude/work/reviews/${id}`,
    runDir: `/c/runs/${id}`,
    roots: ['/p'],
    secrets: [],
    web: false,
    helpers: false,
    sessionId: 's1',
    reviewers: statuses.map((status, i) => ({
      provider: i === 0 ? 'codex' : 'claude',
      key: i === 0 ? 'codex-default' : 'claude-opus',
      status,
      dir: `/c/runs/${id}/${i}`,
      startedAt: AT,
      ...(status === 'running' ? {} : { endedAt: AT + 78_000, tokens: { in: 900, cached: 600, out: 40 }, findings: 1 }),
      ...(i === 0 ? { effort: 'medium' } : { model: 'opus', effort: 'medium' }),
    })),
    ...over,
  }
}

const AGENTS: ClaudeAgent[] = [
  { id: 'a1', type: 'Explore', description: 'find the parser', startedAt: AT + 60_000, status: 'running' },
  { id: 'a2', type: 'general-purpose', description: 'review:bugs', workflow: 'wf_1', startedAt: AT + 30_000, endedAt: AT + 90_000, status: 'completed', tokens: { in: 50_000, cached: 40_000, out: 2_000 } },
]

function props(tab: Tab, rows = 40, page = 0): OverviewProps {
  return overviewProps({
    tab,
    page,
    rows,
    now: AT + 252_000,
    usd: 12.4,
    sessionRuns: [run('r1', ['running', 'ok']), run('r0', ['ok', 'stopped'])],
    agents: AGENTS,
    record: { ...emptyRecord(), turns: 7, main: { in: 1_200_000, cached: 1_000_000, out: 30_000 } },
    limits: { reviewRuns: 20, reviewTokens: 10_000_000, agentTokens: 20_000_000 },
  })
}

const text = (p: OverviewProps) => overviewLines(p).map(line => line.map(s => s.text).join(''))

test('every view fits the drawer, under a tab row that counts what runs and what is logged', () => {
  for (const tab of ['running', 'log', 'limits'] as const) {
    const lines = text(props(tab))
    expect(lines.map(l => [...l].length)).toEqual(lines.map(() => OVERVIEW_COLUMNS))
    expect(lines[0]).toStartWith(' Running 2 │ Log 2 │ Limits ')
  }
})

test('Running: the live run with its reviewers and buttons, then the live Claude agent', () => {
  const lines = text(props('running'))
  expect(lines[2]).toStartWith('Crew reviews')
  expect(lines[3]).toContain('review r1')
  expect(lines[3]).toContain('▐⧉ Brief▌ ▐■ Stop▌')
  expect(lines[4]).toContain('medium')
  expect(lines[4]).toContain('▐■ Stop▌')
  expect(lines[5]).toContain('opus · medium')
  expect(lines[5]).toContain('900 in · 40 out')
  expect(lines[6]).toStartWith('Claude agents')
  expect(lines[7]).toContain('find the parser')
  expect(lines.some(l => l.includes('review r0'))).toBe(false)
})

test('Log: the session totals, then finished runs and agents newest first', () => {
  const lines = text(props('log'))
  expect(lines[2]).toStartWith('This session · Claude $12.40 so far')
  expect(lines[3]).toContain('7 turns · 1.2M in · 30k out')
  expect(lines[4]).toContain('2 runs')
  expect(lines[5]).toContain('codex 900 · claude 2k in')
  expect(lines[7]).toContain('20:07 workflow')
  expect(lines[8]).toContain('20:07 review r0')
  expect(lines[8]).toContain('1 ok · 1 stopped')
  expect(lines[9]).toContain('900 in · 40 out · 1 finding')
})

test('Log pages when it runs past the drawer, with buttons to page', () => {
  const rows = 6
  const first = props('log', rows)
  const lines = text(first)
  expect(lines.length).toBe(2 + logPageSize(rows) + 1)
  expect(lines.at(-1)).toContain('▐▼ Older▌')
  expect(lines.at(-1)).toContain('page 1 of 3')
  expect(actionAt(first, lines.at(-1)!.indexOf('▼') , lines.length - 1)).toEqual({ page: 1 })
  expect(text(props('log', rows, 9)).at(-1)).toContain('page 3 of 3')
})

test('Limits: spend against each limit with a raise button, and a switch per gate', () => {
  const p = props('limits')
  const lines = text(p)
  expect(lines[2]).toContain('2 / 20 runs')
  expect(lines[2]).toContain('▐+10 runs▌')
  expect(lines[4]).toContain('12k / 20M fresh tokens')
  expect(lines[6]).toContain('▐● codex▌ ▐● antigravity▌ ▐● claude▌ ▐● agents▌')
  expect(actionAt(p, lines[2]!.indexOf('+10'), 2)).toEqual({ raise: 'reviewRuns' })
  expect(actionAt(p, lines[6]!.indexOf('agents'), 6)).toEqual({ toggle: 'agents' })
  expect(actionAt(p, 1, 0)).toEqual({ tab: 'running' })
  expect(actionAt(p, lines[0]!.indexOf('Log'), 0)).toEqual({ tab: 'log' })
})

test('a review is refused when its provider is off or the session is past a limit; raises lift it', () => {
  const runs = [run('r1', ['ok', 'ok']), run('r2', ['ok', 'ok'])]
  const spent = spentOf(runs, AGENTS)
  expect(spent).toEqual({ reviewRuns: 2, reviewTokens: 4 * 340, agentTokens: 12_000 })
  const base = { reviewRuns: 2, reviewTokens: 10_000_000, agentTokens: 10_000 }
  expect(reviewRefusal(limitsOf(base, emptyRecord()), spent, ['codex'])).toContain('this session ran 2 reviews, its limit is 2')
  const raised = { ...emptyRecord(), raises: { reviewRuns: 10, reviewTokens: 0, agentTokens: 10_000 } }
  expect(reviewRefusal(limitsOf(base, raised), spent, ['codex'])).toBe(undefined)
  expect(reviewRefusal(limitsOf(base, { ...raised, closed: ['antigravity'] }), spent, ['codex', 'antigravity'])).toContain('antigravity reviewers are switched off')
  expect(followUpRefusal(limitsOf(base, emptyRecord()), spent, 'codex')).toBe(undefined)
  expect(agentRefusal(limitsOf(base, emptyRecord()), spent)).toContain("this session's agents spent 12000 fresh tokens, the limit is 10000")
  expect(agentRefusal(limitsOf(base, raised), spent)).toBe(undefined)
  expect(agentRefusal(limitsOf(base, { ...raised, closed: ['agents'] }), spent)).toContain('switched off')
})

test("Claude's agents run until their turn ends and sum what each turn spent; a kept one the engine no longer lists has ended", () => {
  const agents = new ClaudeAgents()
  agents.started({ id: 'a1', type: 'Explore', description: 'look', startedAt: 0 })
  agents.started({ id: 'w1', type: 'general-purpose', description: 'review:bugs', workflow: 'wf_1', startedAt: 0 })
  expect(agents.finished('a1', true, { in: 10, cached: 0, out: 2 }, 5)).toBe(true)
  expect(agents.finished('nobody', true, undefined, 5)).toBe(false)
  agents.refresh([{ id: 'a1', description: 'look', type: 'Explore', status: 'running' }])
  expect(agents.finished('a1', false, { in: 5, cached: 1, out: 1 }, 9)).toBe(true)
  expect(agents.all().map(a => [a.id, a.status, a.tokens, a.endedAt])).toEqual([
    ['a1', 'failed', { in: 15, cached: 1, out: 3 }, 9],
    ['w1', 'running', undefined, undefined],
  ])
  const again = new ClaudeAgents()
  again.restore(agents.all(), [])
  expect(again.all().map(a => a.status)).toEqual(['failed', 'killed'])
  again.restore(agents.all(), [{ id: 'w1', description: 'review:bugs', type: 'general-purpose', status: 'running' }])
  expect(again.all().map(a => a.status)).toEqual(['failed', 'running'])
})

test('a brief wraps at spaces, and a word longer than a line is cut', () => {
  expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b'])
})
