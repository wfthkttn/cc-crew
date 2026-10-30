import type { AgentsSpent, AgentsSubagent } from 'cc-agents'
import type { BusSpendTotal } from 'cc-bus'
import type { SidebarBadgeLevel } from 'cc-sidebar'
import type { ProvidersGroup, ProvidersLimits, ProvidersRoleLimit } from 'cc-providers'

import { effective, type JobSpec, modelsFor } from './config.ts'
import { wrap } from './detail.ts'
import { clockText, jobKey, type JobView } from './jobs.ts'
import { OVERVIEW_COLUMNS } from './overview.ts'
import type {
  JobsProps,
  LimitsProps,
  LogProps,
  LogRow,
  MemberRow,
  OverviewProps,
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
import { shortCount, type Shown, type Spend, usd } from './usage.ts'

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A row's tokens: input not read from a cache, and output; cache reads re-send the same context every request. */
const tokensText = (t: Shown | undefined) => (t === undefined ? null : `${shortCount(t.in - t.cached)} new · ${shortCount(t.out)} out`)

/** A log row's token columns; blank where nothing was reported. */
function cells(t: Shown | undefined): TokenCells {
  if (t === undefined) return { new: '', cached: '', out: '' }
  return { new: shortCount(t.in - t.cached), cached: shortCount(t.cached), out: shortCount(t.out) }
}

type Member = JobView['agents'][number]

function pickText(r: Member): string {
  const model = r.run?.usedModel ?? r.run?.job.model ?? r.entry.serves
  return [model === 'default' ? undefined : model, r.entry.effort].filter(x => x !== undefined).join(' · ')
}

/** Where it ran; before cc-agents placed it, the provider it is pinned to, if any. */
const providerOf = (r: Member) => r.run?.provider ?? r.entry.provider ?? ''

const isLive = (r: Member) => r.status === 'running' || r.status === 'starting'

function memberRow(v: JobView, r: Member, now: number, spend: Spend): MemberRow {
  const startedAt = r.run?.startedAt ?? v.job.createdAt
  return {
    key: r.entry.label,
    provider: providerOf(r),
    pick: pickText(r),
    status: r.status,
    elapsed: clock((isLive(r) ? now : (r.run?.endedAt ?? startedAt)) - startedAt),
    isRunning: isLive(r),
    tokens: tokensText(r.run === undefined ? undefined : spend.agents[r.run.id]?.tokens),
    reading: isLive(r) ? (r.reading?.text ?? null) : null,
    isStalled: isLive(r) && r.reading?.isStalled === true,
  }
}

const isRunning = (v: JobView) => v.agents.some(isLive)
const agentType = (a: AgentsSubagent) => (a.workflow === undefined ? a.type : 'workflow')

/** One job agent or Claude agent on one model as usage lists it: its pool, and what it cost at API prices. */
export type UsageItem = { key: string; group: string; what: string; status: string; startedAt: number; endedAt?: number; tokens?: Shown; usd: number; isGuessed: boolean }

/** Where providers places each model key, read for the keys about to be drawn: `usageKeys` names them. */
export type Pools = ReadonlyMap<string, { pool: string | null; isPlaced: boolean }>

/** What a record spent, a row per model; one that spent nothing yet shows under the model it runs on. */
const spendRows = (key: string, spent: Readonly<Record<string, AgentsSpent>>): (AgentsSpent & { key: string })[] => {
  const rows = Object.entries(spent).map(([k, s]) => ({ key: k, ...s }))
  return rows.length === 0 ? [{ key, usd: 0, isEstimate: false }] : rows
}

/** The model keys of what usage lists. */
export const usageKeys = (jobs: readonly JobView[], agents: readonly AgentsSubagent[]): string[] => [
  ...jobs.flatMap(v => v.agents.flatMap(r => (r.run === undefined ? [] : spendRows(r.run.key, r.run.spent).map(s => s.key)))),
  ...agents.flatMap(a => spendRows(a.key, a.spent).map(s => s.key)),
]

/** The pool a model counts in; one whose provider is gone from the config counts under that provider's name. */
function groupOf(pools: Pools, key: string): { id: string; isPlaced: boolean } {
  const placed = pools.get(key)
  if (placed === undefined) throw new Error(`crew: ${key} was drawn without its pool being read`)
  return { id: placed.pool ?? key.slice(0, key.indexOf('/')), isPlaced: placed.isPlaced }
}

/** Each job agent and Claude agent the session started, a row per model it spent on, with its pool and cost. */
export function itemsOf(pools: Pools, jobs: readonly JobView[], agents: readonly AgentsSubagent[]): UsageItem[] {
  const items = (rows: readonly (AgentsSpent & { key: string })[], rest: Pick<UsageItem, 'what' | 'status' | 'startedAt' | 'endedAt'>): UsageItem[] =>
    rows.map(s => {
      const { id, isPlaced } = groupOf(pools, s.key)
      const { endedAt, ...started } = rest
      return { key: s.key, group: id, ...started, ...(endedAt === undefined ? {} : { endedAt }), usd: s.usd, ...(s.tokens === undefined ? {} : { tokens: s.tokens }), isGuessed: s.isEstimate || !isPlaced }
    })
  return [
    ...jobs.flatMap(v =>
      v.agents.flatMap(r => {
        const run = r.run
        if (run === undefined) return []
        return items(spendRows(run.key, run.spent), { what: `${v.job.id}: ${v.job.title} (${r.entry.label})`, status: r.status, startedAt: run.startedAt, ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }) })
      }),
    ),
    ...agents.flatMap(a => items(spendRows(a.key, a.spent), { what: `${agentType(a)}: ${a.description}`, status: a.status, startedAt: a.startedAt, ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }) })),
  ]
}

const modelName = (key: string) => key.slice(key.indexOf('/') + 1)

const NOTHING: Shown = { in: 0, cached: 0, out: 0 }

/** A row of `items` at the total cc-agents added up; agents that spent nothing have no total. */
function totals(items: readonly UsageItem[], total: BusSpendTotal | undefined) {
  return { count: String(items.length), usd: usd(total?.usd ?? 0), ...cells(total?.tokens ?? NOTHING) }
}

/** What the session spent: this chat, then each pool with its models under it, jobs and agents together. */
export function usageProps(groups: readonly ProvidersGroup[], items: readonly UsageItem[], spend: Spend): UsageProps {
  const { chat } = spend
  const rows: UsageRow[] = [{ label: 'this chat', count: `${chat.turns} turns`, usd: usd(chat.usd), isPart: false, isGuessed: chat.isEstimate, open: null, ...cells(chat.tokens ?? NOTHING) }]
  for (const group of groups) {
    const inGroup = items.filter(i => i.group === group.id)
    if (inGroup.length === 0) continue
    rows.push({ label: group.name, ...totals(inGroup, spend.pools[group.id]), isPart: false, isGuessed: false, open: { group: group.id } })
    for (const key of [...new Set(inGroup.map(i => i.key))].sort()) {
      const ofKey = inGroup.filter(i => i.key === key)
      rows.push({ label: modelName(key), ...totals(ofKey, spend.keys[key]), isPart: true, isGuessed: ofKey.some(i => i.isGuessed), open: { model: key } })
    }
  }
  return { rows, isGuessing: rows.some(r => r.isGuessed) }
}

const tokensLine = (t: Shown | undefined) =>
  t === undefined ? 'no usage reported' : `${shortCount(t.in - t.cached)} new · ${shortCount(t.cached)} cached · ${shortCount(t.out)} out`

const limitText = (l: ProvidersRoleLimit) => (l.limitUsd === null ? `${usd(l.spentUsd)}, no limit` : `${usd(l.spentUsd)} of ${usd(l.limitUsd)}`)

/** A pool's or a model's details for the pop-out: what it spent, against the pool's limits, then each job agent and Claude agent, newest first. */
export function usageDetail(pools: Pools, items: readonly UsageItem[], limits: ProvidersLimits, target: { group: string } | { model: string }, now: number, spend: Spend): string {
  const shown = items.filter(i => ('group' in target ? i.group === target.group : i.key === target.model)).sort((a, b) => b.startedAt - a.startedAt)
  const group = 'group' in target ? target.group : groupOf(pools, target.model).id
  const pool = limits.pools.find(p => p.pool === group)
  const total = 'group' in target ? spend.pools[target.group] : spend.keys[target.model]
  const head = [
    `${shown.length} run${shown.length === 1 ? '' : 's'} · ${usd(total?.usd ?? 0)} at API prices`,
    pool === undefined ? `${group}: no limits known` : `${pool.name} pool this session: helpers ${limitText(pool.helpers)}; chat ${limitText(pool.main)}`,
    `Tokens: ${tokensLine(total?.tokens)}`,
    '',
  ]
  const lines = shown.flatMap(i => [
    `${clockText(i.startedAt)} ${i.what}${'group' in target ? ` · ${modelName(i.key)}` : ''}`,
    `└ ${i.status}, ${clock((i.endedAt ?? now) - i.startedAt)} · ${tokensLine(i.tokens)} · ${usd(i.usd)}${i.isGuessed ? ' at most' : ''}`,
  ])
  return [...head, ...lines].join('\n')
}

export function runningProps(jobs: readonly JobView[], agents: readonly AgentsSubagent[], now: number, spend: Spend): RunningProps {
  const running = jobs.filter(isRunning).map(v => ({
    at: v.job.createdAt,
    row: {
      kind: 'job' as const,
      id: v.job.id,
      description: `${v.job.id}: ${v.job.title}`,
      elapsed: clock(now - v.job.createdAt),
      members: v.agents.map(r => memberRow(v, r, now, spend)),
    },
  }))
  const live = agents
    .filter(a => a.isLive)
    .map(a => ({
      at: a.startedAt,
      row: { kind: 'agent' as const, id: a.id, type: agentType(a), description: a.description, status: a.status, elapsed: clock(now - a.startedAt), tokens: tokensText(spend.agents[a.id]?.tokens) },
    }))
  return { live: [...running, ...live].sort((a, b) => b.at - a.at).map(x => x.row) }
}

/** Statuses short enough for a tally to fit the log's status column. */
const SHORT_STATUS: Record<string, string> = { stopped: 'stop', failed: 'fail', timeout: 'time', signed_out: 'auth', quota: 'quota', limit: 'limit', left_roots: 'left' }

/** `3 ok`, `2 ok · 1 stop`. */
function tally(v: JobView): string {
  const counts = new Map<string, number>()
  for (const r of v.agents) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${SHORT_STATUS[status] ?? status}`).join(' · ')
}

function jobEnd(v: JobView): number {
  return Math.max(v.job.createdAt, ...v.agents.map(r => r.run?.endedAt ?? r.run?.startedAt ?? v.job.createdAt))
}

/** Every finished job and agent, newest first, one row each. */
export function logProps(jobs: readonly JobView[], agents: readonly AgentsSubagent[], page: number, spend: Spend): LogProps {
  const rows: (LogRow & { at: number })[] = [
    ...jobs
      .filter(v => !isRunning(v))
      .map(v => ({
        at: v.job.createdAt,
        time: clockText(v.job.createdAt),
        what: `${v.job.id}: ${v.job.title}`,
        status: tally(v),
        took: clock(jobEnd(v) - v.job.createdAt),
        open: { run: v.job.id },
        ...cells(spend.groups[jobKey(v.job)]?.tokens),
      })),
    ...agents
      .filter(a => !a.isLive)
      .map(a => ({
        at: a.startedAt,
        time: clockText(a.startedAt),
        what: `${agentType(a)}: ${a.description}`,
        status: a.status,
        took: clock((a.endedAt ?? a.startedAt) - a.startedAt),
        open: { agent: a.id },
        ...cells(spend.agents[a.id]?.tokens),
      })),
  ].sort((a, b) => b.at - a.at)
  return { rows: rows.map(({ at: _, ...row }) => row), page }
}

/** A job's details for the pop-out: when, how it went, which model each agent was, then the brief. */
export function jobDetail(v: JobView, brief: string, spend: Spend): string {
  const job = v.job
  const head = [
    `Started ${clockText(job.createdAt)} · took ${clock(jobEnd(v) - job.createdAt)} · ${tally(v)}${job.isAcked ? ' · read' : ''}`,
    `Read: ${job.roots.length === 0 ? 'nothing' : job.roots.join(', ')}${job.diff === undefined ? '' : ` · ${job.diff}`}`,
    '',
    ...v.agents.map(r => {
      const pick = pickText(r)
      const findings = r.entry.findings === undefined ? '' : ` · ${r.entry.findings} finding${r.entry.findings === 1 ? '' : 's'}`
      const run = r.run
      const total = run === undefined ? undefined : spend.agents[run.id]
      const took = run === undefined ? '' : `, ${clock((run.endedAt ?? run.startedAt) - run.startedAt)}`
      const spent = total === undefined ? '' : ` · ${usd(total.usd)}${total.isEstimate ? ' at most' : ''}`
      const warm = run?.cacheUntil === undefined ? '' : ` · cache warm until ${clockText(run.cacheUntil)}`
      return `${r.entry.label} ${providerOf(r)}${pick === '' ? '' : ` (${pick})`}: ${r.status}${took} · ${tokensLine(total?.tokens)}${spent}${findings}${warm}`
    }),
    ...job.skipped.map(s => `Not run, ${s.serves}: ${s.why}`),
    `Report: ${job.dir}`,
    '',
    '── Brief ──',
  ]
  return [...head, brief].join('\n')
}

/** Every job's models, ticked as a call runs them now, each with its poke, under what is wrong with crew's setup. */
export function jobsProps(crew: Readonly<Record<string, JobSpec>>, sessionKey: string, choices: SessionRecord['jobs'], problems: readonly string[]): JobsProps {
  return {
    problems: problems.flatMap(p => wrap(p, OVERVIEW_COLUMNS)),
    jobs: Object.entries(crew).map(([job, spec]) => {
      const choice = choices[job]
      const ticked = modelsFor(spec, sessionKey, choice)
      return {
        job,
        models: Object.keys(spec.models).map(model => ({ model, isTicked: ticked.includes(model), pokeMin: effective(spec, model, choice?.pokeMin?.[model]).pokeMs / 60_000 })),
      }
    }),
  }
}

/** An agent's details for the pop-out: what it was, how long, what it spent, then its prompt. */
export function agentDetail(a: AgentsSubagent, prompt: string, now: number, spend: Spend): string {
  const total = spend.agents[a.id]
  const head = [
    `${a.type}${a.model === undefined ? '' : ` on ${a.model}`} · ${a.status}`,
    `Started ${clockText(a.startedAt)} · ${a.isLive ? 'running for' : 'took'} ${clock((a.endedAt ?? now) - a.startedAt)}`,
    `Tokens: ${tokensLine(total?.tokens)} · ${usd(total?.usd ?? 0)}${total?.isEstimate === true ? ' at most' : ''}`,
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
      isPaused: limits.isOn && p.reachedAt !== null,
    })),
    gates: gates.map(gate => ({ gate, isOpen: !limits.closed.includes(gate) })),
  }
}

export type Badge = { count: number; level: SidebarBadgeLevel }

/**
 * The tab's badge: job agents and Claude's agents running now, plus the pools at a limit; red while the conversation
 * is paused in one, amber at a helpers' limit.
 */
export function badgeOf(jobs: readonly JobView[], agents: readonly AgentsSubagent[], limits: ProvidersLimits): Badge {
  const running = jobs.flatMap(v => v.agents).filter(isLive).length
  const live = agents.filter(a => a.isLive).length
  const paused = limits.isOn ? limits.pools.filter(p => p.reachedAt !== null).length : 0
  const over = limits.isOn ? limits.pools.filter(p => p.reachedAt === null && p.helpers.isOver).length : 0
  return { count: running + live + paused + over, level: paused > 0 ? 'urgent' : over > 0 ? 'attention' : 'info' }
}

export type ViewInput = {
  tab: Tab
  page: number
  rows: number
  now: number
  opened: Target | null
  groups: readonly ProvidersGroup[]
  pools: Pools
  jobs: readonly JobView[]
  agents: readonly AgentsSubagent[]
  spend: Spend
  record: SessionRecord
  limits: ProvidersLimits
  gates: readonly string[]
  quota: readonly QuotaView[]
  crew: Readonly<Record<string, JobSpec>>
  sessionKey: string
  problems: readonly string[]
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.jobs, v.agents, v.now, v.spend)
  const log = logProps(v.jobs, v.agents, v.page, v.spend)
  return {
    tab: v.tab,
    counts: { running: running.live.length, log: log.rows.length },
    rows: v.rows,
    opened: v.opened,
    running,
    jobs: jobsProps(v.crew, v.sessionKey, v.record.jobs, v.problems),
    usage: usageProps(v.groups, itemsOf(v.pools, v.jobs, v.agents), v.spend),
    log,
    limits: limitsProps(v.limits, v.gates),
    quota: quotaProps(v.quota, v.now),
  }
}
