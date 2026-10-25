import { expect, test } from 'claude-code/testing'

import { type ClaudeAgent, ClaudeAgents } from '../hooks/agents.ts'
import { pressAt, wrap } from '../hooks/detail.ts'
import { detailProps } from '../hooks/register.ts'
import { type Group, costOf, groupOf, mergeCatalog, modelKey, priceOf, withCodex } from '../hooks/catalog.ts'
import { agentRefusal, followUpRefusal, gatesOf, reviewRefusal, sum } from '../hooks/limits.ts'
import { OVERVIEW_COLUMNS, actionAt, logPageSize, overviewLines } from '../hooks/overview.ts'
import type { OverviewProps, Tab } from '../hooks/overview-props.ts'
import { type SessionRecord, emptyRecord } from '../hooks/record.ts'
import type { Run } from '../hooks/runs.ts'
import { shortCount, tokensOf } from '../hooks/usage.ts'
import { type ViewInput, agentDetail, badgeOf, itemsOf, limitsOf, limitsProps, overviewProps, runDetail, spentOf, usageDetail } from '../hooks/views.ts'

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
    written: 20,
    out: 5,
  })
  expect(tokensOf('codex', undefined)).toBe(undefined)
  expect([shortCount(950), shortCount(8400), shortCount(1_154_303)]).toEqual(['950', '8k', '1.2M'])
})

const cents = (usd: number) => Math.round(usd * 100)

/** Round prices, so the $ below are worked out by hand. */
const CATALOG = mergeCatalog(
  {
    groups: {
      claude: { name: 'Claude', provider: 'claude', models: ['opus', 'sonnet'], limitUsd: 1 },
      codex: { name: 'Codex', provider: 'codex', models: ['gpt-6.1-sol'] },
      'agy-gemini': { name: 'Gemini', provider: 'antigravity', models: ['gemini-3.8-flash'] },
    },
    aliases: { 'codex/default': 'codex/gpt-6.1-sol' },
    prices: {
      'claude/opus': { in: 10, cached: 1, written: 12.5, out: 50 },
      'claude/sonnet': { in: 1, cached: 0.1, written: 1.25, out: 5 },
      'codex/gpt-6.1-sol': { in: 1, cached: 0.1, written: 0, out: 10 },
      'antigravity/gemini-3.8-flash': { in: 1, cached: 0.1, written: 0, out: 4 },
    },
  },
  null,
)

test('a run costs each kind of token at its own price; counts add up, cache writes where reported', () => {
  expect(cents(costOf({ in: 900_000, cached: 600_000, out: 40_000 }, CATALOG.prices['codex/gpt-6.1-sol']!))).toBe(30 + 6 + 40)
  expect(cents(costOf({ in: 130_000, cached: 100_000, written: 20_000, out: 5_000 }, CATALOG.prices['claude/opus']!))).toBe(10 + 10 + 25 + 25)
  expect(costOf(undefined, CATALOG.prices['claude/opus']!)).toBe(0)
  expect(sum([{ in: 1, cached: 0, out: 1 }, { in: 2, cached: 1, written: 1, out: 0 }])).toEqual({ in: 3, cached: 1, written: 1, out: 1 })
})

test('models are keyed by vendor and model: Claude ids fold to their family, an Antigravity id drops its effort, an alias is followed', () => {
  expect(modelKey(CATALOG, 'claude', 'claude-opus-5-5[1m]')).toBe('claude/opus')
  expect(modelKey(CATALOG, 'claude', undefined)).toBe('claude/opus')
  expect(modelKey(CATALOG, 'antigravity', 'gemini-3.8-flash-high')).toBe('antigravity/gemini-3.8-flash')
  expect(modelKey(CATALOG, 'codex', undefined)).toBe('codex/gpt-6.1-sol')
  expect(groupOf(CATALOG, 'claude/sonnet')).toEqual({ group: CATALOG.groups[0], isPlaced: true })
  expect(groupOf(CATALOG, 'codex/gpt-7')).toEqual({ group: CATALOG.groups[1], isPlaced: false })
  expect(priceOf(CATALOG, 'claude/haiku')).toEqual({ price: { in: 10, cached: 1, written: 12.5, out: 50 }, isPriced: false })
  expect(() => groupOf(CATALOG, 'other/x')).toThrow('no group for other')
})

test("Codex's own answer adds its models to its group, gives a model with its own limit a group, and names its default", () => {
  const withIt = withCodex(CATALOG, {
    models: [
      { id: 'gpt-6.1-sol', isDefault: false },
      { id: 'gpt-7-sol', isDefault: true },
      { id: 'gpt-7-nova', isDefault: false },
    ],
    limits: [
      { id: 'codex', name: null, model: null },
      { id: 'nova', name: 'GPT-7 Nova', model: 'gpt-7-nova' },
    ],
  })
  expect(withIt.groups.find(g => g.id === 'codex')!.models).toEqual(['gpt-6.1-sol', 'gpt-7-sol'])
  expect(withIt.groups.find(g => g.id === 'codex-nova')).toEqual({ id: 'codex-nova', name: 'GPT-7 Nova', provider: 'codex', models: ['gpt-7-nova'] })
  expect(modelKey(withIt, 'codex', undefined)).toBe('codex/gpt-7-sol')
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
      ...(status === 'running' ? {} : { endedAt: AT + 78_000, tokens: { in: 900_000, cached: 600_000, out: 40_000 }, findings: 1 }),
      ...(i === 0 ? { effort: 'medium' } : { model: 'opus', effort: 'medium' }),
    })),
    ...over,
  }
}

const AGENTS: ClaudeAgent[] = [
  { id: 'a1', type: 'Explore', description: 'find the parser', model: 'claude-sonnet-5-5', startedAt: AT + 60_000, status: 'running' },
  { id: 'a2', type: 'general-purpose', description: 'review:bugs', workflow: 'wf_1', model: 'claude-opus-5-5', startedAt: AT + 30_000, endedAt: AT + 90_000, status: 'completed', tokens: { in: 50_000, cached: 40_000, out: 2_000 } },
]

function props(tab: Tab, rows = 40, page = 0, opened: OverviewProps['opened'] = null): OverviewProps {
  return overviewProps(viewOf(tab, rows, page, opened))
}

function viewOf(tab: Tab, rows = 40, page = 0, opened: OverviewProps['opened'] = null): ViewInput {
  return {
    tab,
    page,
    rows,
    now: AT + 252_000,
    opened,
    catalog: CATALOG,
    catalogNote: null,
    sessionRuns: RUNS,
    agents: AGENTS,
    record: { ...emptyRecord(), turns: 7, main: CHAT, chat: { 'claude/opus': CHAT } },
    fallbackUsd: 10,
    gates: GATES,
  }
}

const GATES = gatesOf([])

const RUNS = [run('r1', ['running', 'ok']), run('r0', ['ok', 'stopped'])]
const CHAT = { in: 1_200_000, cached: 1_000_000, out: 30_000 }

const text = (p: OverviewProps) => overviewLines(p).map(line => line.map(s => s.text).join(''))

test('every view fits the drawer, under a tab row that counts what runs and what is logged, Log last', () => {
  for (const tab of ['running', 'usage', 'log', 'limits'] as const) {
    const lines = text(props(tab))
    expect(lines.map(l => [...l].length)).toEqual(lines.map(() => OVERVIEW_COLUMNS))
    expect(lines[0]).toStartWith(' Running 2 │ Usage │ Limits │ Log 2 ')
  }
})

test('Running: reviews and agents running now in one list, newest first, a review with its buttons and reviewers', () => {
  const p = props('running')
  const lines = text(p)
  expect(lines[2]).toMatch(/^ Explore: find the parser +3:12 running/)
  expect(lines[3]).toContain('review: review r1')
  expect(lines[3]).toContain('▐⧉ Details▌ ▐■ Stop▌')
  expect(lines[4]).toContain('▐■ Stop▌')
  expect(lines[5]).toContain('300k new · 40k out')
  expect(lines).toHaveLength(6)
  expect(actionAt(p, 5, 2)).toEqual({ open: { agent: 'a1' } })
  expect(actionAt(p, lines[3]!.indexOf('Details'), 3)).toEqual({ open: { run: 'r1' } })
})

test("Usage: this chat, then each quota group with its models under it, in $ at API prices; a group's or model's row opens it", () => {
  const p = props('usage')
  const lines = text(p)
  expect(lines[2]).toMatch(/runs +new +cached +out +\$ API/)
  expect(lines[4]).toMatch(/^this chat +7 turns +200k +1\.0M +30k +\$4\.50/)
  expect(lines[5]).toMatch(/^Claude +4 +610k +1\.2M +82k +\$11\.44/)
  expect(lines[6]).toMatch(/^ {2}opus +3 +610k +1\.2M +82k +\$11\.44/)
  expect(lines[7]).toMatch(/^ {2}sonnet +1 +0 +0 +0 +\$0\.00/)
  expect(lines[8]).toMatch(/^Codex +2 +300k +600k +40k +\$0\.76/)
  expect(lines[9]).toMatch(/^ {2}gpt-6\.1-sol +2/)
  expect(actionAt(p, 0, 4)).toBe(null)
  expect(actionAt(p, 0, 5)).toEqual({ open: { group: 'claude' } })
  expect(actionAt(p, 0, 6)).toEqual({ open: { model: 'claude/opus' } })
  const items = itemsOf(CATALOG, RUNS, AGENTS)
  const detail = usageDetail(CATALOG, items, limitsOf(CATALOG, 10, emptyRecord()), { model: 'claude/opus' }, AT + 252_000)
  expect(detail).toStartWith('3 runs · $11.44 at API prices\nClaude group: $11.44 of $1.00 this session\nTokens: 610k new · 1.2M cached · 82k out\n')
  expect(detail).toContain('20:07 workflow: review:bugs\n└ completed, 1:00 · 10k new · 40k cached · 2k out · $0.24')
  expect(detail).toContain('20:07 review: review r0 (claude-opus)\n└ stopped, 1:18')
  expect(usageDetail(CATALOG, items, limitsOf(CATALOG, 10, emptyRecord()), { group: 'claude' }, AT)).toContain('20:07 review: review r1 (claude-opus) · opus')
})

test('Usage marks a model models.json neither places nor prices, and says why the catalog stands alone', () => {
  const p = overviewProps({ ...viewOf('usage'), agents: [{ ...AGENTS[1]!, model: 'claude-haiku-5-5' }], catalogNote: "Codex's models not read (timed out); models.json stands for them." })
  const lines = text(p)
  expect(lines.some(l => /^ {2}haiku \? +1/.test(l))).toBe(true)
  expect(lines.some(l => l.startsWith("Codex's models not read (timed out)"))).toBe(true)
  expect(lines.some(l => l.startsWith('? not in models.json'))).toBe(true)
})

test('Log: one row per finished run or agent, newest first; a press on a row opens it', () => {
  const p = props('log')
  const lines = text(p)
  expect(lines[2]).toMatch(/^time +what +status +took +new +out/)
  expect(lines[4]).toMatch(/^20:07 workflow: review:bugs +completed +1:00 +10k +2k/)
  expect(lines[5]).toMatch(/^20:07 review: review r0 +1 ok · 1 stop +1:18 +600k +80k/)
  expect(lines).toHaveLength(6)
  expect(actionAt(p, 0, 4)).toEqual({ open: { agent: 'a2' } })
  expect(actionAt(p, 40, 5)).toEqual({ open: { run: 'r0' } })
  expect(overviewLines(props('log', 40, 0, { run: 'r0' }))[5]![0]!.bold).toBe(true)
})

test('Log pages when it runs past the drawer, its header on every page', () => {
  const rows = 6
  const first = props('log', rows)
  const lines = text(first)
  expect(logPageSize(rows)).toBe(1)
  expect(lines).toHaveLength(2 + 2 + 1 + 1)
  expect(lines.at(-1)).toContain('▐▼ Older▌')
  expect(lines.at(-1)).toContain('page 1 of 2')
  expect(actionAt(first, lines.at(-1)!.indexOf('▼'), lines.length - 1)).toEqual({ page: 1 })
  const last = text(props('log', rows, 9))
  expect(last[2]).toMatch(/^time/)
  expect(last.at(-1)).toContain('page 2 of 2')
})

test('Limits: an on switch, every quota group against its limit in $, and a switch per gate', () => {
  const p = props('limits')
  const lines = text(p)
  expect(lines[2]).toContain('▐● on▌')
  expect(actionAt(p, lines[2]!.indexOf('on'), 2)).toEqual({ switchLimits: true })
  expect(lines[4]).toStartWith('Quota groups, $ at API prices this session')
  expect(lines[5]).toMatch(/^Claude +\$11\.44 \/ \$1\.00 +▐\+\$1▌ ▐\+\$10▌/)
  expect(lines[6]).toMatch(/^Codex +\$0\.76 \/ \$10\.00/)
  expect(lines[7]).toMatch(/^Gemini +\$0\.00 \/ \$10\.00/)
  expect(lines[9]).toContain('▐● codex▌ ▐● antigravity▌ ▐● claude▌ ▐● agents▌')
  expect(actionAt(p, lines[5]!.indexOf('+$1▌'), 5)).toEqual({ raise: { group: 'claude', usd: 1 } })
  expect(actionAt(p, lines[5]!.indexOf('+$10'), 5)).toEqual({ raise: { group: 'claude', usd: 10 } })
  expect(actionAt(p, lines[9]!.indexOf('agents'), 9)).toEqual({ toggle: 'agents' })
  expect(actionAt(p, 1, 0)).toEqual({ tab: 'running' })
  expect(actionAt(p, lines[0]!.indexOf('Usage'), 0)).toEqual({ tab: 'usage' })
  expect(actionAt(p, lines[0]!.indexOf('Log'), 0)).toEqual({ tab: 'log' })
})

test("Limits: a reviewer from reviewers.json gets a switch; switches that don't fit run on below", () => {
  const custom = [{ name: 'glm', kind: 'claude-p' as const, command: ['glm-claude'] }]
  const p = overviewProps({ ...viewOf('limits'), gates: gatesOf(custom) })
  const lines = text(p)
  expect(lines.map(l => [...l].length)).toEqual(lines.map(() => OVERVIEW_COLUMNS))
  expect(lines[9]).toContain('▐● codex▌ ▐● antigravity▌ ▐● claude▌ ▐● glm▌')
  expect(lines[10]).toMatch(/^ {15}▐● agents▌/)
  expect(actionAt(p, lines[9]!.indexOf('glm'), 9)).toEqual({ toggle: 'glm' })
  expect(actionAt(p, lines[10]!.indexOf('agents'), 10)).toEqual({ toggle: 'agents' })
})

test("a run's and an agent's details: when, how it went, what it spent, then the brief or the prompt", () => {
  const r = run('r0', ['ok', 'stopped'])
  const text = runDetail(r, 'Review the parser.')
  expect(text).toContain('Started 20:07 · took 1:18 · 1 ok · 1 stop')
  expect(text).toContain('codex (medium): ok, 1:18 · 300k new · 600k cached · 40k out · 1 finding')
  expect(text).toMatch(/── Brief ──\nReview the parser\.$/)
  const agent = agentDetail({ ...AGENTS[1]!, model: 'claude-opus-5-5' }, 'Find bugs.', AT)
  expect(agent).toContain('general-purpose on claude-opus-5-5 · completed')
  expect(agent).toContain('Tokens: 10k new · 40k cached · 2k out')
  expect(agent).toContain('Workflow run wf_1')
  expect(agent).toMatch(/── Prompt ──\nFind bugs\.$/)
})

test("work in a quota group is refused once the group's $ reach its limit, reviewers and agents together; raises and the switch lift it", () => {
  const runs = [run('r1', ['ok', 'ok']), run('r2', ['ok', 'ok'])]
  const spent = spentOf(itemsOf(CATALOG, runs, AGENTS))
  expect(cents(spent['codex']!)).toBe(2 * 76)
  expect(cents(spent['claude']!)).toBe(2 * 560 + 24)
  const [claude, codex] = CATALOG.groups as [Group, Group]
  const limits = (record: SessionRecord) => limitsOf(CATALOG, 10, record)
  const none = emptyRecord()
  expect(reviewRefusal(limits(none), spent, ['codex'], [codex])).toBe(undefined)
  expect(reviewRefusal(limits(none), spent, ['codex', 'claude'], [codex, claude])).toBe('the Claude group spent $11.44 at API prices in this session, its limit is $1.00: raise it in the crew tab (Limits) for this session, or in models.json for every session')
  expect(reviewRefusal(limits({ ...none, closed: ['antigravity'] }), spent, ['codex', 'antigravity'], [])).toContain('antigravity reviewers are switched off')
  expect(followUpRefusal(limits(none), spent, 'codex', codex)).toBe(undefined)
  expect(followUpRefusal(limits(none), spent, 'claude', claude)).toContain('the Claude group spent $11.44')
  expect(agentRefusal(limits(none), spent, claude)).toContain('the Claude group spent $11.44')
  expect(agentRefusal(limits({ ...none, raises: { groups: { claude: 20 } } }), spent, claude)).toBe(undefined)
  expect(agentRefusal(limits({ ...none, isLimitsOff: true }), spent, claude)).toBe(undefined)
  expect(agentRefusal(limits({ ...none, closed: ['agents'] }), spent, codex)).toContain('switched off')
})

test('the tab badge counts reviewers and agents running plus limits reached, amber once one is', () => {
  const spent = spentOf(itemsOf(CATALOG, RUNS, AGENTS))
  const roomy = limitsProps(CATALOG, limitsOf(CATALOG, 10, { ...emptyRecord(), raises: { groups: { claude: 100 } } }), spent, GATES)
  expect(badgeOf(RUNS, AGENTS, roomy)).toEqual({ count: 2, level: 'info' })
  expect(badgeOf(RUNS, AGENTS, limitsProps(CATALOG, limitsOf(CATALOG, 10, emptyRecord()), spent, GATES))).toEqual({ count: 3, level: 'attention' })
  expect(badgeOf(RUNS, AGENTS, limitsProps(CATALOG, limitsOf(CATALOG, 10, { ...emptyRecord(), isLimitsOff: true }), spent, GATES))).toEqual({ count: 2, level: 'info' })
  expect(badgeOf([], [], roomy)).toEqual({ count: 0, level: 'info' })
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

test("the details fill the modal's width and page when they run past its rows; Close, Up and Down take a press", () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n')
  const room = { rows: 5, columns: 20 }
  expect(detailProps('t', 'a\nb\nc', room, 0)).toEqual({ title: 't', lines: ['a', 'b', 'c'], columns: 20, page: 0, pages: 1, first: 1, last: 3, total: 3 })
  const first = detailProps('t', text, room, 0)
  expect(first).toEqual({ title: 't', lines: ['l1', 'l2', 'l3'], columns: 20, page: 0, pages: 4, first: 1, last: 3, total: 10 })
  expect(detailProps('t', text, room, 9)).toMatchObject({ lines: ['l10'], page: 3, first: 10, last: 10 })
  const second = detailProps('t', text, room, 1)
  expect(pressAt(second, 11, 0)).toEqual({ close: true })
  expect(pressAt(second, 10, 0)).toBe(null)
  expect(pressAt(second, 0, 4)).toEqual({ page: -1 })
  expect(pressAt(second, 7, 4)).toEqual({ page: 1 })
  expect(pressAt(second, 0, 3)).toBe(null)
  expect(pressAt(first, 0, 4)).toBe(null)
})
