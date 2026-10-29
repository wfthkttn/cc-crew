import { expect, test } from 'claude-code/testing'
import type { AgentsRun } from 'cc-agents'
import type { ProvidersGroup, ProvidersInfo, ProvidersLimits, ProvidersPoolLimit, ProvidersQuotaSlot } from 'cc-providers'

import { type ClaudeAgent, ClaudeAgents } from '../hooks/agents.ts'
import { pressAt, wrap } from '../hooks/detail.ts'
import { detailProps } from '../hooks/register.ts'
import { OVERVIEW_COLUMNS, actionAt, logPageSize, overviewLines } from '../hooks/overview.ts'
import type { OverviewProps, Tab } from '../hooks/overview-props.ts'
import { gaugeColumns, type QuotaView } from '../hooks/quota.ts'
import { emptyRecord } from '../hooks/record.ts'
import type { ReviewView } from '../hooks/reviews.ts'
import { claudeTokens, shortCount } from '../hooks/usage.ts'
import { type ViewInput, agentDetail, badgeOf, itemsOf, overviewProps, runDetail, usageDetail } from '../hooks/views.ts'

const AT = new Date(2026, 9, 23, 20, 7).getTime()
const TOKENS = { in: 900_000, cached: 600_000, out: 40_000 }

function runOf(id: string, provider: string, key: string, status: AgentsRun['status'], costUsd: number): AgentsRun {
  return {
    id,
    session: 's1',
    provider,
    key: key as AgentsRun['key'],
    job: { dir: '/c', read: 'project', project: '/p', system: '', task: '', web: false, helpers: false, timeoutMs: 1 },
    status,
    costUsd,
    isCostEstimate: false,
    followUps: 0,
    startedAt: AT,
    ...(status === 'running' ? {} : { endedAt: AT + 78_000, tokens: TOKENS, usedModel: key.slice(key.indexOf('/') + 1) }),
  }
}

function review(id: string, statuses: [AgentsRun['status'], AgentsRun['status']]): ReviewView {
  const codex = runOf(`${id}-a`, 'codex', 'codex/gpt-6.1-sol', statuses[0], statuses[0] === 'running' ? 0 : 0.38)
  const claude = runOf(`${id}-b`, 'claude', 'claude/opus', statuses[1], statuses[1] === 'running' ? 0 : 5.6)
  return {
    review: { id, description: `review ${id}`, createdAt: AT, session: 's1', reportDir: `/p/.claude/work/reviews/${id}`, roots: ['/p'], web: false, helpers: false, reviewers: [] },
    reviewers: [
      { entry: { key: 'codex-default', provider: 'codex', effort: 'medium', agent: codex.id, findings: 1 }, run: codex, status: codex.status },
      { entry: { key: 'claude-opus', provider: 'claude', model: 'opus', effort: 'medium', agent: claude.id, findings: 1 }, run: claude, status: claude.status },
    ],
  }
}

const AGENTS: ClaudeAgent[] = [
  { id: 'a1', type: 'Explore', description: 'find the parser', model: 'claude-sonnet-5-5', key: 'claude/sonnet', startedAt: AT + 60_000, status: 'running', usd: 0, isEstimate: false },
  {
    id: 'a2',
    type: 'general-purpose',
    description: 'review:bugs',
    workflow: 'wf_1',
    model: 'claude-opus-5-5',
    key: 'claude/opus',
    startedAt: AT + 30_000,
    endedAt: AT + 90_000,
    status: 'completed',
    tokens: { in: 50_000, cached: 40_000, out: 2_000 },
    usd: 0.24,
    isEstimate: false,
  },
]

const GROUPS: ProvidersGroup[] = [
  { id: 'claude', name: 'Claude', provider: 'claude', models: ['opus', 'sonnet', 'haiku'] },
  { id: 'codex', name: 'Codex', provider: 'codex', models: ['gpt-6.1-sol'] },
  { id: 'agy-gemini', name: 'Gemini', provider: 'antigravity', models: ['gemini-3.8-flash'] },
]

const role = (limitUsd: number | null, spentUsd: number) => ({ limitUsd, spentUsd, raisedUsd: 0, isOver: limitUsd !== null && spentUsd >= limitUsd })

function pool(id: string, name: string, provider: string, main: ReturnType<typeof role>, helpers: ReturnType<typeof role>, pausedAt: number | null = null): ProvidersPoolLimit {
  return { pool: id, name, provider, isClosed: false, pausedAt, main, helpers }
}

const LIMITS: ProvidersLimits = {
  isOn: true,
  closed: [],
  pools: [
    pool('claude', 'Claude', 'claude', role(20, 4.5), role(1, 11.44)),
    pool('codex', 'Codex', 'codex', role(null, 0), role(10, 0.76)),
    pool('agy-gemini', 'Gemini', 'antigravity', role(null, 0), role(10, 0)),
  ],
}

const GATES = ['claude', 'codex', 'antigravity', 'agents']

function info(id: string, name: string, pools: [string, string][], source: ProvidersInfo['pools'][number]['source']): ProvidersInfo {
  return { id, name, styles: [], pools: pools.map(([pid, pname]) => ({ id: pid, name: pname, source })), vendors: [], units: [] }
}

const window = (id: string, name: string, used: number, resetsAt: number) => ({ id, name, unit: 'percent' as const, used, limit: 100, percentUsed: used, resetsAt })

function slot(source: ProvidersQuotaSlot['source'], pools: { pool: string; windows: ReturnType<typeof window>[] }[], error: string | null = null): ProvidersQuotaSlot {
  return { pools: pools.map(p => p.pool), source, reading: { pools, plan: null, readAt: AT, isEstimate: false, expiresAt: null }, error, triedAt: AT }
}

const QUOTA: QuotaView[] = [
  { info: info('claude', 'Claude', [['claude', 'Claude']], { kind: 'session' }), slots: [slot('session', [{ pool: 'claude', windows: [window('5h', '5h', 30, AT + 7_200_000), window('week', 'Week', 60, AT + 3 * 86_400_000)] }])] },
  { info: info('codex', 'Codex', [['codex', 'Codex']], { kind: 'reader', reader: 'codex-app-server' }), slots: [slot('reader', [{ pool: 'codex', windows: [window('5h', '5h', 95, AT + 3_600_000)] }])] },
  {
    info: info('antigravity', 'Antigravity', [['agy-gemini', 'Gemini'], ['agy-argon', 'Argon']], { kind: 'reader', reader: 'agy-quota' }),
    slots: [slot('reader', [{ pool: 'agy-argon', windows: [window('week', 'Week', 50, AT + 86_400_000)] }, { pool: 'agy-gemini', windows: [window('5h', '5h', 10, AT), window('week', 'Week', 20, AT)] }], 'agy: timed out')],
  },
  { info: info('zai', 'Z.ai', [['zai', 'Z.ai GLM']], { kind: 'none' }), slots: [{ pools: ['zai'], source: 'none', reading: null, error: 'Z.ai has no quota reader for Z.ai GLM', triedAt: null }] },
]

const REVIEWS = [review('r1', ['running', 'ok']), review('r0', ['ok', 'stopped'])]
const CHAT = { in: 1_200_000, cached: 1_000_000, out: 30_000 }

function viewOf(tab: Tab, rows = 40, page = 0, opened: OverviewProps['opened'] = null): ViewInput {
  return {
    tab,
    page,
    rows,
    now: AT + 252_000,
    opened,
    groups: GROUPS,
    reviews: REVIEWS,
    agents: AGENTS,
    record: { ...emptyRecord(), turns: 7, main: CHAT },
    limits: LIMITS,
    gates: GATES,
    quota: QUOTA,
  }
}

const props = (tab: Tab, rows = 40, page = 0, opened: OverviewProps['opened'] = null) => overviewProps(viewOf(tab, rows, page, opened))

const text = (p: OverviewProps) => overviewLines(p).map(line => line.map(s => s.text).join(''))

test("a Claude turn's usage reads as tokens in, cache reads and writes included, and out", () => {
  expect(claudeTokens({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 }, output_tokens: 5 })).toEqual({ in: 160, cached: 100, written: 50, written1h: 50, out: 5 })
  expect(shortCount(950)).toBe('950')
  expect(shortCount(837_400)).toBe('837k')
  expect(shortCount(1_240_000)).toBe('1.2M')
})

test('every view fits the drawer, under a tab row that counts what runs and what is logged, Log last', () => {
  for (const tab of ['running', 'usage', 'log', 'limits', 'quota'] as const) {
    const lines = text(props(tab))
    expect(lines.map(l => [...l].length)).toEqual(lines.map(() => OVERVIEW_COLUMNS))
    expect(lines[0]).toStartWith(' Running 2 │ Usage │ Limits │ Quota │ Log 2 ')
  }
})

test('Running: reviews and agents running now in one list, newest first, a review with its buttons and reviewers', () => {
  const p = props('running')
  const lines = text(p)
  expect(lines[2]).toMatch(/^ Explore: find the parser +3:12 running/)
  expect(lines[3]).toContain('review: review r1')
  expect(lines[3]).toContain('▐⧉ Details▌ ▐■ Stop▌')
  expect(lines[4]).toMatch(/codex +medium +running +4:12 ▐■ Stop▌/)
  expect(lines[5]).toContain('300k new · 40k out')
  expect(lines).toHaveLength(6)
  expect(actionAt(p, 5, 2)).toEqual({ open: { agent: 'a1' } })
  expect(actionAt(p, lines[3]!.indexOf('Details'), 3)).toEqual({ open: { run: 'r1' } })
  expect(actionAt(p, lines[4]!.indexOf('Stop'), 4)).toEqual({ stop: { run: 'r1', key: 'codex-default' } })
})

test("Usage: this chat as providers metered it, then each pool with its models under it, in $ at API prices; a pool's or model's row opens it", () => {
  const p = props('usage')
  const lines = text(p)
  expect(lines[2]).toMatch(/runs +new +cached +out +\$ API/)
  expect(lines[4]).toMatch(/^this chat +7 turns +200k +1\.0M +30k +\$4\.50/)
  expect(lines[5]).toMatch(/^Claude +4 +610k +1\.2M +82k +\$11\.44/)
  expect(lines[6]).toMatch(/^ {2}opus +3 +610k +1\.2M +82k +\$11\.44/)
  expect(lines[7]).toMatch(/^ {2}sonnet +1 +0 +0 +0 +\$0\.00/)
  expect(lines[8]).toMatch(/^Codex +2 +300k +600k +40k +\$0\.38/)
  expect(lines[9]).toMatch(/^ {2}gpt-6\.1-sol +2/)
  expect(actionAt(p, 0, 4)).toBe(null)
  expect(actionAt(p, 0, 5)).toEqual({ open: { group: 'claude' } })
  expect(actionAt(p, 0, 6)).toEqual({ open: { model: 'claude/opus' } })
  const items = itemsOf(GROUPS, REVIEWS, AGENTS)
  const detail = usageDetail(GROUPS, items, LIMITS, { model: 'claude/opus' }, AT + 252_000)
  expect(detail).toStartWith('3 runs · $11.44 at API prices\nClaude pool this session: helpers $11.44 of $1.00; chat $4.50 of $20.00\nTokens: 610k new · 1.2M cached · 82k out\n')
  expect(detail).toContain('20:07 workflow: review:bugs\n└ completed, 1:00 · 10k new · 40k cached · 2k out · $0.24')
  expect(detail).toContain('20:07 review: review r0 (claude-opus)\n└ stopped, 1:18')
  expect(usageDetail(GROUPS, items, LIMITS, { group: 'claude' }, AT)).toContain('20:07 review: review r1 (claude-opus) · opus')
})

test('Usage marks a model priced at its dearest, or that no pool places, as an upper bound', () => {
  const lines = text(overviewProps({ ...viewOf('usage'), agents: [{ ...AGENTS[1]!, key: 'claude/fable' }, { ...AGENTS[1]!, id: 'a3', isEstimate: true }] }))
  expect(lines.some(l => /^ {2}fable \? +1/.test(l))).toBe(true)
  expect(lines.some(l => /^ {2}opus \? +3/.test(l))).toBe(true)
  expect(lines.some(l => l.startsWith('? priced at the dearest it could be'))).toBe(true)
})

test('Log: one row per finished review or agent, newest first; a press on a row opens it', () => {
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

test("Limits: an on switch, each pool's helpers and its chat where it has a limit, raises, a pause shown, and a switch per gate", () => {
  const paused = { ...LIMITS, pools: [{ ...LIMITS.pools[0]!, pausedAt: AT }, ...LIMITS.pools.slice(1)] }
  const p = overviewProps({ ...viewOf('limits'), limits: paused })
  const lines = text(p)
  expect(lines[2]).toContain('▐● on▌')
  expect(actionAt(p, lines[2]!.indexOf('on'), 2)).toEqual({ switchLimits: true })
  expect(lines[4]).toStartWith('Pools, $ at API prices this session')
  expect(lines[5]).toMatch(/^Claude +helpers +\$11\.44 \/ \$1\.00 +▐\+\$1▌ ▐\+\$10▌/)
  expect(lines[6]).toMatch(/^ +chat +\$4\.50 \/ \$20\.00 +▐\+\$1▌ ▐\+\$10▌ paused/)
  expect(lines[7]).toMatch(/^Codex +helpers +\$0\.76 \/ \$10\.00/)
  expect(lines[8]).toMatch(/^Gemini +helpers +\$0\.00 \/ \$10\.00/)
  expect(lines[10]).toContain('▐● claude▌ ▐● codex▌ ▐● antigravity▌ ▐● agents▌')
  expect(actionAt(p, lines[5]!.indexOf('+$1▌'), 5)).toEqual({ raise: { pool: 'claude', role: 'helpers', usd: 1 } })
  expect(actionAt(p, lines[6]!.indexOf('+$10'), 6)).toEqual({ raise: { pool: 'claude', role: 'main', usd: 10 } })
  expect(actionAt(p, lines[10]!.indexOf('agents'), 10)).toEqual({ toggle: 'agents' })
  expect(actionAt(p, lines[0]!.indexOf('Quota'), 0)).toEqual({ tab: 'quota' })
  const closed = text(overviewProps({ ...viewOf('limits'), limits: { ...LIMITS, isOn: false, closed: ['codex'] } }))
  expect(closed[2]).toContain('▐○ off▌  nothing below is enforced')
  expect(closed[10]).toContain('▐○ codex▌')
})

test("Quota: each provider's pools and windows with what is left and when it resets; the gauge takes the first three that read one", () => {
  const lines = text(props('quota'))
  expect(lines[2]).toStartWith('Claude')
  expect(lines[3]).toMatch(/^ {2}Claude +5h +70% left +resets 22:07/)
  expect(lines[4]).toMatch(/^ {18}Week +40% left +resets [A-Z][a-z]{2}/)
  expect(lines.some(l => /^ {2}Codex +5h +5% left/.test(l))).toBe(true)
  expect(lines.some(l => l.startsWith('  agy: timed out'))).toBe(true)
  expect(lines.some(l => l.startsWith('Z.ai'))).toBe(false)
  const columns = gaugeColumns(QUOTA, AT)
  expect(columns.map(c => c.letter)).toEqual(['C', 'O', 'G'])
  expect(columns[0]).toMatchObject({ values: [70, 40], isDim: false })
  expect(columns[1]).toMatchObject({ values: [5, null] })
  expect(columns[2]).toMatchObject({ values: [[90, 80], [50, null]], isDim: true })
  expect(gaugeColumns(QUOTA, AT + 16 * 60_000)[0]!.isDim).toBe(true)
})

test("a review's and an agent's details: when, how it went, what it spent, then the brief or the prompt", () => {
  const r = review('r0', ['ok', 'stopped'])
  r.reviewers[0]!.run = { ...r.reviewers[0]!.run!, cacheUntil: new Date(2026, 9, 23, 21, 8).getTime() }
  const shown = runDetail(r, 'Review the parser.')
  expect(shown).toContain('Started 20:07 · took 1:18 · 1 ok · 1 stop')
  expect(shown).toContain('codex (gpt-6.1-sol · medium): ok, 1:18 · 300k new · 600k cached · 40k out · $0.38 · 1 finding · cache warm until 21:08')
  expect(shown).toMatch(/── Brief ──\nReview the parser\.$/)
  const agent = agentDetail(AGENTS[1]!, 'Find bugs.', AT)
  expect(agent).toContain('general-purpose on claude-opus-5-5 · completed')
  expect(agent).toContain('Tokens: 10k new · 40k cached · 2k out · $0.24')
  expect(agent).toContain('Workflow run wf_1')
  expect(agent).toMatch(/── Prompt ──\nFind bugs\.$/)
})

test('the tab badge counts reviewers and agents running plus pools at a limit: red while the chat is paused in one, amber at a helpers limit', () => {
  const roomy = { ...LIMITS, pools: LIMITS.pools.map(p => ({ ...p, helpers: role(100, 0) })) }
  expect(badgeOf(REVIEWS, AGENTS, roomy)).toEqual({ count: 2, level: 'info' })
  expect(badgeOf(REVIEWS, AGENTS, LIMITS)).toEqual({ count: 3, level: 'attention' })
  expect(badgeOf(REVIEWS, AGENTS, { ...LIMITS, pools: [{ ...LIMITS.pools[0]!, pausedAt: AT }] })).toEqual({ count: 3, level: 'urgent' })
  expect(badgeOf(REVIEWS, AGENTS, { ...LIMITS, isOn: false })).toEqual({ count: 2, level: 'info' })
  expect(badgeOf([], [], roomy)).toEqual({ count: 0, level: 'info' })
})

test("Claude's agents run until their turn ends and sum what each turn spent and cost; a kept one the engine no longer lists has ended", () => {
  const agents = new ClaudeAgents()
  agents.started({ id: 'a1', type: 'Explore', description: 'look', key: 'claude/sonnet', startedAt: 0 })
  agents.started({ id: 'w1', type: 'general-purpose', description: 'review:bugs', workflow: 'wf_1', key: 'claude/opus', startedAt: 0 })
  expect(agents.keyOf('a1')).toBe('claude/sonnet')
  expect(agents.finished('a1', { isAnswer: true, tokens: { in: 10, cached: 0, out: 2 }, usd: 0.1, isEstimate: false, at: 5 })).toBe(true)
  expect(agents.finished('nobody', { isAnswer: true, usd: 0, isEstimate: false, at: 5 })).toBe(false)
  agents.refresh([{ id: 'a1', description: 'look', type: 'Explore', status: 'running' }])
  expect(agents.finished('a1', { isAnswer: false, tokens: { in: 5, cached: 1, out: 1 }, usd: 0.05, isEstimate: true, at: 9 })).toBe(true)
  expect(agents.all().map(a => [a.id, a.status, a.tokens, a.endedAt, a.usd.toFixed(2), a.isEstimate])).toEqual([
    ['a1', 'failed', { in: 15, cached: 1, out: 3 }, 9, '0.15', true],
    ['w1', 'running', undefined, undefined, '0.00', false],
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
