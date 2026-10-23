import { type ClaudeAgent, LIVE } from './agents.ts'
import type { Settings } from './config.ts'
import { type Limits, type Spent, GATES, fresh, sum } from './limits.ts'
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

export function runningProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], record: SessionRecord, usd: number | null, now: number): RunningProps {
  return {
    usd,
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
  return {
    isOn: !record.isLimitsOff,
    reviewRuns: base.reviewRuns + record.raises.reviewRuns,
    reviewTokens: base.reviewTokens + record.raises.reviewTokens,
    agentTokens: base.agentTokens + record.raises.agentTokens,
    closed: record.closed,
  }
}

export function spentOf(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[]): Spent {
  return {
    reviewRuns: sessionRuns.length,
    reviewTokens: sessionRuns.flatMap(run => run.reviewers).reduce((n, r) => n + fresh(r.tokens), 0),
    agentTokens: agents.reduce((n, a) => n + fresh(a.tokens), 0),
  }
}

/** What a raise from the Limits tab adds: the setting's own default size, so one press is one more allowance. */
export const RAISE_BY = { reviewRuns: 10, reviewTokens: 10_000_000, agentTokens: 20_000_000 } as const

export function limitsProps(limits: Limits, spent: Spent): LimitsProps {
  return {
    isOn: limits.isOn,
    rows: [
      { label: 'Reviews', spent: String(spent.reviewRuns), limit: `${limits.reviewRuns} runs`, raise: 'reviewRuns', raiseLabel: `+${RAISE_BY.reviewRuns} runs` },
      {
        label: '',
        spent: shortCount(spent.reviewTokens),
        limit: `${shortCount(limits.reviewTokens)} tokens`,
        raise: 'reviewTokens',
        raiseLabel: `+${shortCount(RAISE_BY.reviewTokens)}`,
      },
      {
        label: 'Claude agents',
        spent: shortCount(spent.agentTokens),
        limit: `${shortCount(limits.agentTokens)} tokens`,
        raise: 'agentTokens',
        raiseLabel: `+${shortCount(RAISE_BY.agentTokens)}`,
      },
    ],
    gates: GATES.map(gate => ({ gate, isOpen: !limits.closed.includes(gate) })),
  }
}

export type ViewInput = {
  tab: Tab
  page: number
  rows: number
  now: number
  usd: number | null
  opened: Target | null
  sessionRuns: readonly Run[]
  agents: readonly ClaudeAgent[]
  record: SessionRecord
  limits: Settings['limits']
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.sessionRuns, v.agents, v.record, v.usd, v.now)
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
