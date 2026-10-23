import type { SidebarBadgeLevel } from 'sidebar'

import { type ClaudeAgent, LIVE } from './agents.ts'
import type { Settings } from './config.ts'
import { type Limits, type Spent, GATES, claudeModel, modelLimit, reviewerModel, sum, weighted } from './limits.ts'
import type { LimitsProps, LogProps, LogRow, OverviewProps, ReviewerRow, RunningProps, Tab, Target, TokenCells, TotalRow } from './overview-props.ts'
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

/** What the session spent: Claude itself, the reviews (each provider under them) and Claude's agents. */
function totalsOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], record: SessionRecord): TotalRow[] {
  const reviewers = sessionRuns.flatMap(run => run.reviewers)
  const providers = [...new Set(reviewers.map(r => r.provider))]
  return [
    { label: 'Claude', count: `${record.turns} turns`, isPart: false, ...cells(record.main) },
    { label: 'Reviews', count: `${sessionRuns.length} runs`, isPart: false, ...cells(sum(reviewers.map(r => r.tokens))) },
    ...providers.map(p => ({
      label: PROVIDER_SHORT[p] ?? p,
      count: '',
      isPart: true,
      ...cells(sum(reviewers.filter(r => r.provider === p).map(r => r.tokens))),
    })),
    { label: 'Agents', count: String(agents.length), isPart: false, ...cells(sum(agents.map(a => a.tokens))) },
  ]
}

export function runningProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], record: SessionRecord, now: number): RunningProps {
  return {
    totals: totalsOf(sessionRuns, agents, record),
    runs: sessionRuns.filter(isRunning).map(run => ({
      id: run.id,
      description: run.description,
      elapsed: clock(now - run.createdAt),
      reviewers: run.reviewers.map(r => reviewerRow(r, now)),
    })),
    agents: agents
      .filter(a => LIVE.includes(a.status))
      .map(a => ({ id: a.id, type: agentType(a), description: a.description, status: a.status, elapsed: clock(now - a.startedAt), tokens: tokensText(a.tokens) })),
  }
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

const PROVIDER_SHORT: Record<string, string> = { codex: 'codex', antigravity: 'agy', claude: 'claude', 'claude-p': 'claude-p' }

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
    reviewRuns: base.reviewRuns + record.raises.reviewRuns,
    models: Object.fromEntries([...named].map(m => [m, (base.models[m] ?? base.modelDefault) + (record.raises.models[m] ?? 0)])),
    modelDefault: base.modelDefault,
    closed: record.closed,
  }
}

/** A Claude agent's limit name; one kept before agents knew their model has none to tell. */
export const agentModel = (a: ClaudeAgent) => claudeModel(a.model ?? 'unknown')

/** Every model the session's reviewers and agents ran on, with the tokens spent on it, none spent included. */
export function spentOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[]): Spent {
  const models: Record<string, number> = {}
  const add = (model: string, t: Tokens | undefined) => (models[model] = (models[model] ?? 0) + weighted(t))
  for (const r of sessionRuns.flatMap(run => run.reviewers)) add(reviewerModel(r.provider, r.usedModel ?? r.model), r.tokens)
  for (const a of agents) add(agentModel(a), a.tokens)
  return { reviewRuns: sessionRuns.length, models }
}

/** What a raise from the Limits tab adds: the default limit's size, so one press is one more allowance. */
export const RAISE_BY = { reviewRuns: 10, model: 20_000_000 } as const

export function limitsProps(limits: Limits, spent: Spent): LimitsProps {
  const named = [...new Set([...Object.keys(spent.models), ...Object.keys(limits.models)])].sort()
  return {
    isOn: limits.isOn,
    reviews: {
      label: 'Reviews',
      spent: String(spent.reviewRuns),
      limit: `${limits.reviewRuns} runs`,
      raise: 'reviewRuns',
      raiseLabel: `+${RAISE_BY.reviewRuns} runs`,
      isOver: spent.reviewRuns >= limits.reviewRuns,
    },
    models: named.map(model => {
      const used = spent.models[model] ?? 0
      const limit = modelLimit(limits, model)
      return { label: model, spent: shortCount(used), limit: shortCount(limit), raise: { model }, raiseLabel: `+${shortCount(RAISE_BY.model)}`, isOver: used >= limit }
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
  const reached = limits.isOn ? [limits.reviews, ...limits.models].filter(r => r.isOver).length : 0
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
  const running = runningProps(v.sessionRuns, v.agents, v.record, v.now)
  const log = logProps(v.sessionRuns, v.agents, v.page)
  return {
    tab: v.tab,
    counts: { running: running.runs.length + running.agents.length, log: log.rows.length },
    rows: v.rows,
    opened: v.opened,
    running,
    log,
    limits: limitsProps(limitsOf(v.limits, v.record), spentOf(v.sessionRuns, v.agents)),
  }
}
