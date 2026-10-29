import type { SidebarBadgeLevel } from 'cc-sidebar'
import type { ProvidersGroup, ProvidersLimits, ProvidersRoleLimit } from 'cc-providers'

import { type ClaudeAgent, LIVE } from './agents.ts'
import type {
  LimitsProps,
  LogProps,
  LogRow,
  OverviewProps,
  ReviewerRow,
  Role,
  RoleRow,
  RunningProps,
  Tab,
  Target,
  TokenCells,
  UsageProps,
  UsageRow,
} from './overview-props.ts'
import { quotaProps, type QuotaView } from './quota.ts'
import type { SessionRecord } from './record.ts'
import { clockText, type ReviewView } from './reviews.ts'
import { shortCount, sum, type Tokens, usd } from './usage.ts'

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A row's tokens: input not read from a cache, and output; cache reads re-send the same context every request. */
const tokensText = (t: Tokens | undefined) => (t === undefined ? null : `${shortCount(t.in - t.cached)} new · ${shortCount(t.out)} out`)

/** A log row's token columns; blank where nothing was reported. */
function cells(t: Tokens | undefined): TokenCells {
  if (t === undefined) return { new: '', cached: '', out: '' }
  return { new: shortCount(t.in - t.cached), cached: shortCount(t.cached), out: shortCount(t.out) }
}

type Reviewer = ReviewView['reviewers'][number]

function pickText(r: Reviewer): string {
  const model = r.run?.usedModel ?? r.entry.model
  return [model === 'default' ? undefined : model, r.entry.effort].filter(x => x !== undefined).join(' · ')
}

const isLive = (r: Reviewer) => r.status === 'running' || r.status === 'starting'

function reviewerRow(v: ReviewView, r: Reviewer, now: number): ReviewerRow {
  const startedAt = r.run?.startedAt ?? v.review.createdAt
  return {
    key: r.entry.key,
    provider: r.entry.provider,
    pick: pickText(r),
    status: r.status,
    elapsed: clock((isLive(r) ? now : (r.run?.endedAt ?? startedAt)) - startedAt),
    isRunning: isLive(r),
    tokens: tokensText(r.run?.tokens),
  }
}

const isRunning = (v: ReviewView) => v.reviewers.some(isLive)
const agentType = (a: ClaudeAgent) => (a.workflow === undefined ? a.type : 'workflow')

/** One reviewer or agent as usage lists it: the model it ran, its pool, and what it cost at API prices. */
export type UsageItem = { key: string; group: string; what: string; status: string; startedAt: number; endedAt?: number; tokens?: Tokens; usd: number; isGuessed: boolean }

/** The pool a model counts in, as providers' catalog places it; one it doesn't place counts in its provider's first. */
function groupOf(groups: readonly ProvidersGroup[], key: string): { id: string; isPlaced: boolean } {
  const cut = key.indexOf('/')
  const provider = key.slice(0, cut)
  const placed = groups.find(g => g.provider === provider && g.models.includes(key.slice(cut + 1)))
  if (placed !== undefined) return { id: placed.id, isPlaced: true }
  return { id: groups.find(g => g.provider === provider)?.id ?? provider, isPlaced: false }
}

/** Each reviewer and agent the session started, with its model, pool and cost. */
export function itemsOf(groups: readonly ProvidersGroup[], reviews: readonly ReviewView[], agents: readonly ClaudeAgent[]): UsageItem[] {
  const item = (key: string, rest: Omit<UsageItem, 'key' | 'group' | 'isGuessed'>, isEstimate: boolean): UsageItem => {
    const { id, isPlaced } = groupOf(groups, key)
    return { key, group: id, ...rest, isGuessed: isEstimate || !isPlaced }
  }
  return [
    ...reviews.flatMap(v =>
      v.reviewers.flatMap(r => {
        const run = r.run
        if (run === undefined) return []
        const rest = {
          what: `review: ${v.review.description} (${r.entry.key})`,
          status: r.status,
          startedAt: run.startedAt,
          usd: run.costUsd,
          ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          ...(run.tokens === undefined ? {} : { tokens: run.tokens }),
        }
        return [item(run.key, rest, run.isCostEstimate)]
      }),
    ),
    ...agents.map(a =>
      item(
        a.key,
        {
          what: `${agentType(a)}: ${a.description}`,
          status: a.status,
          startedAt: a.startedAt,
          usd: a.usd,
          ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }),
          ...(a.tokens === undefined ? {} : { tokens: a.tokens }),
        },
        a.isEstimate,
      ),
    ),
  ]
}

const modelName = (key: string) => key.slice(key.indexOf('/') + 1)

function totals(items: readonly UsageItem[]) {
  return { count: String(items.length), usd: usd(items.reduce((n, i) => n + i.usd, 0)), ...cells(sum(items.map(i => i.tokens))) }
}

/** What the session spent: this chat as providers metered it, then each pool with its models under it, reviewers and agents together. */
export function usageProps(groups: readonly ProvidersGroup[], items: readonly UsageItem[], record: SessionRecord, limits: ProvidersLimits): UsageProps {
  const chatUsd = limits.pools.reduce((n, p) => n + p.main.spentUsd, 0)
  const rows: UsageRow[] = [{ label: 'this chat', count: `${record.turns} turns`, usd: usd(chatUsd), isPart: false, isGuessed: false, open: null, ...cells(record.main) }]
  for (const group of groups) {
    const inGroup = items.filter(i => i.group === group.id)
    if (inGroup.length === 0) continue
    rows.push({ label: group.name, ...totals(inGroup), isPart: false, isGuessed: false, open: { group: group.id } })
    for (const key of [...new Set(inGroup.map(i => i.key))].sort()) {
      const ofKey = inGroup.filter(i => i.key === key)
      rows.push({ label: modelName(key), ...totals(ofKey), isPart: true, isGuessed: ofKey.some(i => i.isGuessed), open: { model: key } })
    }
  }
  return { rows, isGuessing: rows.some(r => r.isGuessed) }
}

const tokensLine = (t: Tokens | undefined) =>
  t === undefined ? 'no usage reported' : `${shortCount(t.in - t.cached)} new · ${shortCount(t.cached)} cached · ${shortCount(t.out)} out`

const limitText = (l: ProvidersRoleLimit) => (l.limitUsd === null ? `${usd(l.spentUsd)}, no limit` : `${usd(l.spentUsd)} of ${usd(l.limitUsd)}`)

/** A pool's or a model's details for the pop-out: what it spent, against the pool's limits, then each reviewer and agent, newest first. */
export function usageDetail(groups: readonly ProvidersGroup[], items: readonly UsageItem[], limits: ProvidersLimits, target: { group: string } | { model: string }, now: number): string {
  const shown = items.filter(i => ('group' in target ? i.group === target.group : i.key === target.model)).sort((a, b) => b.startedAt - a.startedAt)
  const group = 'group' in target ? target.group : groupOf(groups, target.model).id
  const pool = limits.pools.find(p => p.pool === group)
  const head = [
    `${shown.length} run${shown.length === 1 ? '' : 's'} · ${usd(shown.reduce((n, i) => n + i.usd, 0))} at API prices`,
    pool === undefined ? `${group}: no limits known` : `${pool.name} pool this session: helpers ${limitText(pool.helpers)}; chat ${limitText(pool.main)}`,
    `Tokens: ${tokensLine(sum(shown.map(i => i.tokens)))}`,
    '',
  ]
  const lines = shown.flatMap(i => [
    `${clockText(i.startedAt)} ${i.what}${'group' in target ? ` · ${modelName(i.key)}` : ''}`,
    `└ ${i.status}, ${clock((i.endedAt ?? now) - i.startedAt)} · ${tokensLine(i.tokens)} · ${usd(i.usd)}${i.isGuessed ? ' at most' : ''}`,
  ])
  return [...head, ...lines].join('\n')
}

export function runningProps(reviews: readonly ReviewView[], agents: readonly ClaudeAgent[], now: number): RunningProps {
  const running = reviews.filter(isRunning).map(v => ({
    at: v.review.createdAt,
    row: {
      kind: 'review' as const,
      id: v.review.id,
      description: v.review.description,
      elapsed: clock(now - v.review.createdAt),
      reviewers: v.reviewers.map(r => reviewerRow(v, r, now)),
    },
  }))
  const live = agents
    .filter(a => LIVE.includes(a.status))
    .map(a => ({
      at: a.startedAt,
      row: { kind: 'agent' as const, id: a.id, type: agentType(a), description: a.description, status: a.status, elapsed: clock(now - a.startedAt), tokens: tokensText(a.tokens) },
    }))
  return { live: [...running, ...live].sort((a, b) => b.at - a.at).map(x => x.row) }
}

/** Statuses short enough for a tally to fit the log's status column. */
const SHORT_STATUS: Record<string, string> = { stopped: 'stop', failed: 'fail', timeout: 'time', signed_out: 'auth', quota: 'quota', limit: 'limit', left_roots: 'left' }

/** `3 ok`, `2 ok · 1 stop`. */
function tally(v: ReviewView): string {
  const counts = new Map<string, number>()
  for (const r of v.reviewers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${SHORT_STATUS[status] ?? status}`).join(' · ')
}

function reviewEnd(v: ReviewView): number {
  return Math.max(v.review.createdAt, ...v.reviewers.map(r => r.run?.endedAt ?? r.run?.startedAt ?? v.review.createdAt))
}

/** Every finished review and agent, newest first, one row each. */
export function logProps(reviews: readonly ReviewView[], agents: readonly ClaudeAgent[], page: number): LogProps {
  const rows: (LogRow & { at: number })[] = [
    ...reviews
      .filter(v => !isRunning(v))
      .map(v => ({
        at: v.review.createdAt,
        time: clockText(v.review.createdAt),
        what: `review: ${v.review.description}`,
        status: tally(v),
        took: clock(reviewEnd(v) - v.review.createdAt),
        open: { run: v.review.id },
        ...cells(sum(v.reviewers.map(r => r.run?.tokens))),
      })),
    ...agents
      .filter(a => !LIVE.includes(a.status))
      .map(a => ({
        at: a.startedAt,
        time: clockText(a.startedAt),
        what: `${agentType(a)}: ${a.description}`,
        status: a.status,
        took: clock((a.endedAt ?? a.startedAt) - a.startedAt),
        open: { agent: a.id },
        ...cells(a.tokens),
      })),
  ].sort((a, b) => b.at - a.at)
  return { rows: rows.map(({ at: _, ...row }) => row), page }
}

/** A review's details for the pop-out: when, how it went, each reviewer, then the brief. */
export function runDetail(v: ReviewView, brief: string): string {
  const review = v.review
  const head = [
    `Started ${clockText(review.createdAt)} · took ${clock(reviewEnd(v) - review.createdAt)} · ${tally(v)}`,
    `Read: ${review.roots.length === 0 ? 'nothing' : review.roots.join(', ')} · web ${review.web ? 'on' : 'off'}${review.changes === undefined ? '' : ` · ${review.changes}`}`,
    '',
    ...v.reviewers.map(r => {
      const pick = pickText(r)
      const findings = r.entry.findings === undefined ? '' : ` · ${r.entry.findings} finding${r.entry.findings === 1 ? '' : 's'}`
      const run = r.run
      const took = run === undefined ? '' : `, ${clock((run.endedAt ?? run.startedAt) - run.startedAt)}`
      const spent = run === undefined ? '' : ` · ${usd(run.costUsd)}${run.isCostEstimate ? ' at most' : ''}`
      const warm = run?.cacheUntil === undefined ? '' : ` · cache warm until ${clockText(run.cacheUntil)}`
      return `${r.entry.provider}${pick === '' ? '' : ` (${pick})`}: ${r.status}${took} · ${tokensLine(run?.tokens)}${spent}${findings}${warm}`
    }),
    `Reports: ${review.reportDir}`,
    '',
    '── Brief ──',
  ]
  return [...head, brief].join('\n')
}

/** An agent's details for the pop-out: what it was, how long, what it spent, then its prompt. */
export function agentDetail(a: ClaudeAgent, prompt: string, now: number): string {
  const head = [
    `${a.type}${a.model === undefined ? '' : ` on ${a.model}`} · ${a.status}`,
    `Started ${clockText(a.startedAt)} · ${LIVE.includes(a.status) ? 'running for' : 'took'} ${clock((a.endedAt ?? now) - a.startedAt)}`,
    `Tokens: ${tokensLine(a.tokens)} · ${usd(a.usd)}${a.isEstimate ? ' at most' : ''}`,
    ...(a.workflow === undefined ? [] : [`Workflow run ${a.workflow}`]),
    '',
    '── Prompt ──',
  ]
  return [...head, prompt].join('\n')
}

/** What one press of a raise adds, in $. */
export const RAISES_USD = [1, 10] as const

function roleRow(pool: string, role: Role, l: ProvidersRoleLimit): RoleRow {
  const raises = l.limitUsd === null ? [] : RAISES_USD.map(n => ({ label: `+$${n}`, raise: { pool, role, usd: n } }))
  return { role, spent: usd(l.spentUsd), limit: l.limitUsd === null ? null : usd(l.limitUsd), raises, isOver: l.isOver }
}

/** Every pool: its helpers' spend against their limit, the conversation's where it has a limit or spent, raises; a switch per gate. */
export function limitsProps(limits: ProvidersLimits, gates: readonly string[]): LimitsProps {
  return {
    isOn: limits.isOn,
    pools: limits.pools.map(p => ({
      label: p.name,
      roles: [roleRow(p.pool, 'helpers', p.helpers), ...(p.main.limitUsd !== null || p.main.spentUsd > 0 ? [roleRow(p.pool, 'main', p.main)] : [])],
      isPaused: limits.isOn && p.pausedAt !== null,
    })),
    gates: gates.map(gate => ({ gate, isOpen: !limits.closed.includes(gate) })),
  }
}

export type Badge = { count: number; level: SidebarBadgeLevel }

/**
 * The tab's badge: reviewers and Claude's agents running now, plus the pools at a limit; red while the conversation
 * is paused in one, amber at a helpers' limit.
 */
export function badgeOf(reviews: readonly ReviewView[], agents: readonly ClaudeAgent[], limits: ProvidersLimits): Badge {
  const running = reviews.flatMap(v => v.reviewers).filter(isLive).length
  const live = agents.filter(a => LIVE.includes(a.status)).length
  const paused = limits.isOn ? limits.pools.filter(p => p.pausedAt !== null).length : 0
  const over = limits.isOn ? limits.pools.filter(p => p.pausedAt === null && p.helpers.isOver).length : 0
  return { count: running + live + paused + over, level: paused > 0 ? 'urgent' : over > 0 ? 'attention' : 'info' }
}

export type ViewInput = {
  tab: Tab
  page: number
  rows: number
  now: number
  opened: Target | null
  groups: readonly ProvidersGroup[]
  reviews: readonly ReviewView[]
  agents: readonly ClaudeAgent[]
  record: SessionRecord
  limits: ProvidersLimits
  gates: readonly string[]
  quota: readonly QuotaView[]
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.reviews, v.agents, v.now)
  const log = logProps(v.reviews, v.agents, v.page)
  return {
    tab: v.tab,
    counts: { running: running.live.length, log: log.rows.length },
    rows: v.rows,
    opened: v.opened,
    running,
    usage: usageProps(v.groups, itemsOf(v.groups, v.reviews, v.agents), v.record, v.limits),
    log,
    limits: limitsProps(v.limits, v.gates),
    quota: quotaProps(v.quota, v.now),
  }
}
