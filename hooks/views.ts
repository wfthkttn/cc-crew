import type { SidebarBadgeLevel } from 'sidebar'

import { type ClaudeAgent, LIVE } from './agents.ts'
import { type Catalog, costOf, groupOf, modelKey, priceOf } from './catalog.ts'
import { wrap } from './detail.ts'
import { OVERVIEW_COLUMNS } from './overview.ts'
import { type Limits, type Spent, GATES, groupLimit, sum, usd } from './limits.ts'
import type { LimitsProps, LogProps, LogRow, OverviewProps, ReviewerRow, RunningProps, Tab, Target, TokenCells, UsageProps, UsageRow } from './overview-props.ts'
import type { SessionRecord } from './record.ts'
import type { ReviewerState, Run } from './runs.ts'
import { type Tokens, shortCount } from './usage.ts'

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function timeOfDay(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A row's tokens: input not read from a cache, and output; cache reads re-send the same context every request. */
const tokensText = (t: Tokens | undefined) => (t === undefined ? null : `${shortCount(t.in - t.cached)} new · ${shortCount(t.out)} out`)

/** A log row's token columns; blank where nothing was reported. */
function cells(t: Tokens | undefined): TokenCells {
  if (t === undefined) return { new: '', cached: '', out: '' }
  return { new: shortCount(t.in - t.cached), cached: shortCount(t.cached), out: shortCount(t.out) }
}

function pickText(r: ReviewerState): string {
  const model = r.usedModel ?? r.model
  return [model === 'default' ? undefined : model, r.effort].filter(x => x !== undefined).join(' · ')
}

function reviewerRow(r: ReviewerState, now: number): ReviewerRow {
  return {
    key: r.key,
    provider: r.provider,
    pick: pickText(r),
    status: r.status,
    elapsed: clock((r.endedAt ?? now) - r.startedAt),
    isRunning: r.status === 'running',
    tokens: tokensText(r.tokens),
  }
}

const isRunning = (run: Run) => run.reviewers.some(r => r.status === 'running')
const agentType = (a: ClaudeAgent) => (a.workflow === undefined ? a.type : 'workflow')

/** One reviewer or agent as usage lists it: the model it ran (catalog key), its group, and what it cost at API prices. */
export type UsageItem = { key: string; group: string; what: string; status: string; startedAt: number; endedAt?: number; tokens?: Tokens; usd: number }

/** What a model's tokens cost, and whether the catalog placed and priced the model or crew stood in for it. */
function costed(catalog: Catalog, key: string, tokens: Tokens | undefined) {
  const { group, isPlaced } = groupOf(catalog, key)
  const { price, isPriced } = priceOf(catalog, key)
  return { group: group.id, usd: costOf(tokens, price), isGuessed: !isPlaced || !isPriced }
}

/** Each reviewer and agent the session started, with its model, group and cost. */
export function itemsOf(catalog: Catalog, sessionRuns: readonly Run[], agents: readonly ClaudeAgent[]): UsageItem[] {
  const item = (key: string, what: string, status: string, startedAt: number, endedAt: number | undefined, tokens: Tokens | undefined): UsageItem => {
    const { group, usd } = costed(catalog, key, tokens)
    return { key, group, what, status, startedAt, usd, ...(endedAt === undefined ? {} : { endedAt }), ...(tokens === undefined ? {} : { tokens }) }
  }
  return [
    ...sessionRuns.flatMap(run =>
      run.reviewers.map(r => item(modelKey(catalog, r.provider, r.usedModel ?? r.model), `review: ${run.description} (${r.key})`, r.status, r.startedAt, r.endedAt, r.tokens)),
    ),
    ...agents.map(a => item(modelKey(catalog, 'claude', a.model), `${agentType(a)}: ${a.description}`, a.status, a.startedAt, a.endedAt, a.tokens)),
  ]
}

const modelName = (key: string) => key.slice(key.indexOf('/') + 1)

/** What the session spent: this chat, then each group with its models under it, reviewers and agents together. */
export function usageProps(catalog: Catalog, items: readonly UsageItem[], record: SessionRecord, note: string | null): UsageProps {
  const chat = Object.entries(record.chat).map(([key, t]) => costed(catalog, key, t).usd)
  const rows: UsageRow[] = [
    { label: 'this chat', count: `${record.turns} turns`, usd: usd(chat.reduce((n, x) => n + x, 0)), isPart: false, isGuessed: false, open: null, ...cells(record.main) },
  ]
  for (const group of catalog.groups) {
    const inGroup = items.filter(i => i.group === group.id)
    if (inGroup.length === 0) continue
    rows.push({ label: group.name, ...totals(inGroup), isPart: false, isGuessed: false, open: { group: group.id } })
    for (const key of [...new Set(inGroup.map(i => i.key))].sort()) {
      rows.push({ label: modelName(key), ...totals(inGroup.filter(i => i.key === key)), isPart: true, isGuessed: costed(catalog, key, undefined).isGuessed, open: { model: key } })
    }
  }
  return { rows, isGuessing: rows.some(r => r.isGuessed), note: note === null ? [] : wrap(note, OVERVIEW_COLUMNS) }
}

function totals(items: readonly UsageItem[]) {
  return { count: String(items.length), usd: usd(items.reduce((n, i) => n + i.usd, 0)), ...cells(sum(items.map(i => i.tokens))) }
}

/** A group's or a model's details for the pop-out: what it spent, against the group's limit, then each reviewer and agent, newest first. */
export function usageDetail(catalog: Catalog, items: readonly UsageItem[], limits: Limits, target: { group: string } | { model: string }, now: number): string {
  const shown = items.filter(i => ('group' in target ? i.group === target.group : i.key === target.model)).sort((a, b) => b.startedAt - a.startedAt)
  const group = 'group' in target ? target.group : groupOf(catalog, target.model).group.id
  const spent = items.filter(i => i.group === group).reduce((n, i) => n + i.usd, 0)
  const name = catalog.groups.find(g => g.id === group)?.name ?? group
  const head = [
    `${shown.length} run${shown.length === 1 ? '' : 's'} · ${usd(shown.reduce((n, i) => n + i.usd, 0))} at API prices`,
    `${name} group: ${usd(spent)} of ${usd(groupLimit(limits, group))} this session`,
    `Tokens: ${tokensLine(sum(shown.map(i => i.tokens)))}`,
    '',
  ]
  const lines = shown.flatMap(i => [
    `${timeOfDay(i.startedAt)} ${i.what}${'group' in target ? ` · ${modelName(i.key)}` : ''}`,
    `└ ${i.status}, ${clock((i.endedAt ?? now) - i.startedAt)} · ${tokensLine(i.tokens)} · ${usd(i.usd)}`,
  ])
  return [...head, ...lines].join('\n')
}

export function runningProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], now: number): RunningProps {
  const reviews = sessionRuns.filter(isRunning).map(run => ({
    at: run.createdAt,
    row: { kind: 'review' as const, id: run.id, description: run.description, elapsed: clock(now - run.createdAt), reviewers: run.reviewers.map(r => reviewerRow(r, now)) },
  }))
  const live = agents
    .filter(a => LIVE.includes(a.status))
    .map(a => ({
      at: a.startedAt,
      row: { kind: 'agent' as const, id: a.id, type: agentType(a), description: a.description, status: a.status, elapsed: clock(now - a.startedAt), tokens: tokensText(a.tokens) },
    }))
  return { live: [...reviews, ...live].sort((a, b) => b.at - a.at).map(x => x.row) }
}

/** Statuses short enough for a tally to fit the log's status column. */
const SHORT_STATUS: Record<string, string> = { stopped: 'stop', failed: 'fail', timeout: 'time', signed_out: 'auth', quota: 'quota', left_roots: 'left' }

/** `3 ok`, `2 ok · 1 stop`. */
function tally(run: Run): string {
  const counts = new Map<string, number>()
  for (const r of run.reviewers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${SHORT_STATUS[status] ?? status}`).join(' · ')
}

function runEnd(run: Run): number {
  return Math.max(run.createdAt, ...run.reviewers.map(r => r.endedAt ?? r.startedAt))
}


/** Every finished run and agent, newest first, one row each. */
export function logProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], page: number): LogProps {
  const rows: (LogRow & { at: number })[] = [
    ...sessionRuns
      .filter(run => !isRunning(run))
      .map(run => ({
        at: run.createdAt,
        time: timeOfDay(run.createdAt),
        what: `review: ${run.description}`,
        status: tally(run),
        took: clock(runEnd(run) - run.createdAt),
        open: { run: run.id },
        ...cells(sum(run.reviewers.map(r => r.tokens))),
      })),
    ...agents
      .filter(a => !LIVE.includes(a.status))
      .map(a => ({
        at: a.startedAt,
        time: timeOfDay(a.startedAt),
        what: `${agentType(a)}: ${a.description}`,
        status: a.status,
        took: clock((a.endedAt ?? a.startedAt) - a.startedAt),
        open: { agent: a.id },
        ...cells(a.tokens),
      })),
  ].sort((a, b) => b.at - a.at)
  return { rows: rows.map(({ at: _, ...row }) => row), page }
}

const tokensLine = (t: Tokens | undefined) =>
  t === undefined ? 'no usage reported' : `${shortCount(t.in - t.cached)} new · ${shortCount(t.cached)} cached · ${shortCount(t.out)} out`

/** A run's details for the pop-out: when, how it went, each reviewer, then the brief. */
export function runDetail(run: Run, brief: string): string {
  const head = [
    `Started ${timeOfDay(run.createdAt)} · took ${clock(runEnd(run) - run.createdAt)} · ${tally(run)}`,
    `Read: ${run.roots.length === 0 ? 'nothing' : run.roots.join(', ')} · web ${run.web ? 'on' : 'off'}${run.changes === undefined ? '' : ` · ${run.changes}`}`,
    '',
    ...run.reviewers.map(r => {
      const pick = pickText(r)
      const findings = r.findings === undefined ? '' : ` · ${r.findings} finding${r.findings === 1 ? '' : 's'}`
      return `${r.provider}${pick === '' ? '' : ` (${pick})`}: ${r.status}, ${clock((r.endedAt ?? r.startedAt) - r.startedAt)} · ${tokensLine(r.tokens)}${findings}`
    }),
    `Reports: ${run.reportDir}`,
    '',
    '── Brief ──',
  ]
  return [...head, brief].join('\n')
}

/** An agent's details for the pop-out: what it was, how long, what it spent, then its prompt. */
export function agentDetail(a: ClaudeAgent, prompt: string, now: number): string {
  const head = [
    `${a.type}${a.model === undefined ? '' : ` on ${a.model}`} · ${a.status}`,
    `Started ${timeOfDay(a.startedAt)} · ${LIVE.includes(a.status) ? 'running for' : 'took'} ${clock((a.endedAt ?? now) - a.startedAt)}`,
    `Tokens: ${tokensLine(a.tokens)}`,
    ...(a.workflow === undefined ? [] : [`Workflow run ${a.workflow}`]),
    '',
    '── Prompt ──',
  ]
  return [...head, prompt].join('\n')
}

/** The catalog's group limits with this session's raises and switches. */
export function limitsOf(catalog: Catalog, fallbackUsd: number, record: SessionRecord): Limits {
  return {
    isOn: !record.isLimitsOff,
    groups: Object.fromEntries(catalog.groups.map(g => [g.id, (g.limitUsd ?? fallbackUsd) + (record.raises.groups[g.id] ?? 0)])),
    fallbackUsd,
    closed: record.closed,
  }
}

/** $ at API prices each group's reviewers and agents spent. */
export function spentOf(items: readonly UsageItem[]): Spent {
  const spent: Record<string, number> = {}
  for (const i of items) spent[i.group] = (spent[i.group] ?? 0) + i.usd
  return spent
}

/** What one press of a group's raise adds, in $. */
export const RAISES_USD = [1, 10] as const

/** Every group of the catalog: what it spent against its limit, a raise, and over once spent reaches it. */
export function limitsProps(catalog: Catalog, limits: Limits, spent: Spent): LimitsProps {
  return {
    isOn: limits.isOn,
    groups: catalog.groups.map(g => {
      const used = spent[g.id] ?? 0
      const limit = groupLimit(limits, g.id)
      const raises = RAISES_USD.map(n => ({ label: `+$${n}`, raise: { group: g.id, usd: n } }))
      return { label: g.name, spent: usd(used), limit: usd(limit), raises, isOver: used >= limit }
    }),
    gates: GATES.map(gate => ({ gate, isOpen: !limits.closed.includes(gate) })),
  }
}

export type Badge = { count: number; level: SidebarBadgeLevel }

/** The tab's badge: reviewers and Claude's agents running now, plus the limits reached; amber once one is. */
export function badgeOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], limits: LimitsProps): Badge {
  const running = sessionRuns.flatMap(run => run.reviewers).filter(r => r.status === 'running').length
  const live = agents.filter(a => LIVE.includes(a.status)).length
  const reached = limits.isOn ? limits.groups.filter(r => r.isOver).length : 0
  return { count: running + live + reached, level: reached > 0 ? 'attention' : 'info' }
}

export type ViewInput = {
  tab: Tab
  page: number
  rows: number
  now: number
  opened: Target | null
  catalog: Catalog
  catalogNote: string | null
  sessionRuns: readonly Run[]
  agents: readonly ClaudeAgent[]
  record: SessionRecord
  fallbackUsd: number
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.sessionRuns, v.agents, v.now)
  const log = logProps(v.sessionRuns, v.agents, v.page)
  const items = itemsOf(v.catalog, v.sessionRuns, v.agents)
  return {
    tab: v.tab,
    counts: { running: running.live.length, log: log.rows.length },
    rows: v.rows,
    opened: v.opened,
    running,
    usage: usageProps(v.catalog, items, v.record, v.catalogNote),
    log,
    limits: limitsProps(v.catalog, limitsOf(v.catalog, v.fallbackUsd, v.record), spentOf(items)),
  }
}
