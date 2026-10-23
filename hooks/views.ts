import type { SidebarBadgeLevel } from 'sidebar'

import { type ClaudeAgent, LIVE } from './agents.ts'
import type { Settings } from './config.ts'
import { type Limits, type Spent, GATES, claudeModel, modelLimit, reviewerModel, sum, weighted } from './limits.ts'
import type { LimitsProps, LogProps, LogRow, OverviewProps, ReviewerRow, RunningProps, Tab, Target, TokenCells, UsageProps } from './overview-props.ts'
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

/** One reviewer or agent as a model's usage lists it. */
type ModelItem = { what: string; status: string; startedAt: number; endedAt?: number; tokens?: Tokens }

/** Each reviewer and agent the session started, under the model limit it counts against, by limit name. */
function byModel(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[]): Map<string, ModelItem[]> {
  const models = new Map<string, ModelItem[]>()
  const add = (model: string, item: ModelItem) => models.set(model, [...(models.get(model) ?? []), item])
  for (const run of sessionRuns) {
    for (const r of run.reviewers) {
      const what = `review: ${run.description} (${r.key})`
      add(reviewerModel(r.provider, r.usedModel ?? r.model), { what, status: r.status, startedAt: r.startedAt, ...ends(r.endedAt), ...spent(r.tokens) })
    }
  }
  for (const a of agents) {
    add(agentModel(a), { what: `${agentType(a)}: ${a.description}`, status: a.status, startedAt: a.startedAt, ...ends(a.endedAt), ...spent(a.tokens) })
  }
  return models
}

const ends = (at: number | undefined) => (at === undefined ? {} : { endedAt: at })
const spent = (t: Tokens | undefined) => (t === undefined ? {} : { tokens: t })

/** What the session spent: Claude's own chat, then each model, its reviewers and agents together. */
export function usageProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], record: SessionRecord): UsageProps {
  const models = [...byModel(sessionRuns, agents)].sort(([a], [b]) => a.localeCompare(b))
  return {
    rows: [
      { label: 'this chat', count: `${record.turns} turns`, weighted: shortCount(weighted(record.main)), model: null, ...cells(record.main) },
      ...models.map(([model, items]) => {
        const total = sum(items.map(i => i.tokens))
        return { label: model, count: String(items.length), weighted: shortCount(weighted(total)), model, ...cells(total) }
      }),
    ],
  }
}

/** A model's details for the pop-out: what it spent against its limit, then each reviewer and agent on it, newest first. */
export function modelDetail(model: string, sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], limits: Limits, now: number): string {
  const items = [...(byModel(sessionRuns, agents).get(model) ?? [])].sort((a, b) => b.startedAt - a.startedAt)
  const total = sum(items.map(i => i.tokens))
  const head = [
    `${items.length} run${items.length === 1 ? '' : 's'} · ${shortCount(weighted(total))} of ${shortCount(modelLimit(limits, model))} weighted tokens`,
    `Tokens: ${tokensLine(total)}`,
    '',
  ]
  const lines = items.flatMap(i => [
    `${timeOfDay(i.startedAt)} ${i.what}`,
    `└ ${i.status}, ${clock((i.endedAt ?? now) - i.startedAt)} · ${tokensLine(i.tokens)} · ${shortCount(weighted(i.tokens))} weighted`,
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

/** The settings' limits with this session's raises and switches. */
export function limitsOf(base: Settings['limits'], record: SessionRecord): Limits {
  const named = new Set([...Object.keys(base.models), ...Object.keys(record.raises.models)])
  return {
    isOn: !record.isLimitsOff,
    models: Object.fromEntries([...named].map(m => [m, (base.models[m] ?? base.modelDefault) + (record.raises.models[m] ?? 0)])),
    modelDefault: base.modelDefault,
    closed: record.closed,
  }
}

/** A Claude agent's limit name; one kept before agents knew their model has none to tell. */
export const agentModel = (a: ClaudeAgent) => claudeModel(a.model ?? 'unknown')

/** Every model the session's reviewers and agents ran on, with the weighted tokens spent on it, none spent included. */
export function spentOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[]): Spent {
  return Object.fromEntries([...byModel(sessionRuns, agents)].map(([model, items]) => [model, items.reduce((n, i) => n + weighted(i.tokens), 0)]))
}

/** What a raise from the Limits tab adds: the default limit's size, so one press is one more allowance. */
export const RAISE_BY = 20_000_000

export function limitsProps(limits: Limits, spent: Spent): LimitsProps {
  const named = [...new Set([...Object.keys(spent), ...Object.keys(limits.models)])].sort()
  return {
    isOn: limits.isOn,
    models: named.map(model => {
      const used = spent[model] ?? 0
      const limit = modelLimit(limits, model)
      return { label: model, spent: shortCount(used), limit: shortCount(limit), raise: { model }, raiseLabel: `+${shortCount(RAISE_BY)}`, isOver: used >= limit }
    }),
    modelDefault: shortCount(limits.modelDefault),
    gates: GATES.map(gate => ({ gate, isOpen: !limits.closed.includes(gate) })),
  }
}

export type Badge = { count: number; level: SidebarBadgeLevel }

/** The tab's badge: reviewers and Claude's agents running now, plus the limits reached; amber once one is. */
export function badgeOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], limits: LimitsProps): Badge {
  const running = sessionRuns.flatMap(run => run.reviewers).filter(r => r.status === 'running').length
  const live = agents.filter(a => LIVE.includes(a.status)).length
  const reached = limits.isOn ? limits.models.filter(r => r.isOver).length : 0
  return { count: running + live + reached, level: reached > 0 ? 'attention' : 'info' }
}

export type ViewInput = {
  tab: Tab
  page: number
  rows: number
  now: number
  opened: Target | null
  sessionRuns: readonly Run[]
  agents: readonly ClaudeAgent[]
  record: SessionRecord
  limits: Settings['limits']
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.sessionRuns, v.agents, v.now)
  const log = logProps(v.sessionRuns, v.agents, v.page)
  return {
    tab: v.tab,
    counts: { running: running.live.length, log: log.rows.length },
    rows: v.rows,
    opened: v.opened,
    running,
    usage: usageProps(v.sessionRuns, v.agents, v.record),
    log,
    limits: limitsProps(limitsOf(v.limits, v.record), spentOf(v.sessionRuns, v.agents)),
  }
}
