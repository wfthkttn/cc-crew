import { type ClaudeAgent, LIVE } from './agents.ts'
import type { Settings } from './config.ts'
import { type Limits, type Spent, GATES, fresh, sum } from './limits.ts'
import type { LimitsProps, LogEntry, LogProps, OverviewProps, ReviewerRow, RunningProps, Tab } from './overview-props.ts'
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

const tokensText = (t: Tokens | undefined) => (t === undefined ? null : `${shortCount(t.in)} in · ${shortCount(t.out)} out`)

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

export function runningProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], now: number): RunningProps {
  return {
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

/** `3 ok`, `2 ok · 1 stopped`. */
function tally(run: Run): string {
  const counts = new Map<string, number>()
  for (const r of run.reviewers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${status}`).join(' · ')
}

function runEnd(run: Run): number {
  return Math.max(run.createdAt, ...run.reviewers.map(r => r.endedAt ?? r.startedAt))
}

const PROVIDER_SHORT: Record<string, string> = { codex: 'codex', antigravity: 'agy', claude: 'claude', 'claude-p': 'claude-p' }

/** The session's totals, then every finished run and agent, newest first. */
export function logProps(sessionRuns: readonly Run[], agents: readonly ClaudeAgent[], record: SessionRecord, usd: number | null, page: number): LogProps {
  const done = sessionRuns.filter(run => !isRunning(run))
  const finished = agents.filter(a => !LIVE.includes(a.status))
  const entries: (LogEntry & { at: number })[] = [
    ...done.map(run => ({
      kind: 'run' as const,
      at: run.createdAt,
      time: timeOfDay(run.createdAt),
      description: run.description,
      elapsed: clock(runEnd(run) - run.createdAt),
      tally: tally(run),
      reviewers: run.reviewers.map(r => ({
        ...reviewerRow(r, runEnd(run)),
        findings: r.findings === undefined ? '' : `${r.findings} finding${r.findings === 1 ? '' : 's'}`,
      })),
    })),
    ...finished.map(a => ({
      kind: 'agent' as const,
      at: a.startedAt,
      time: timeOfDay(a.startedAt),
      type: agentType(a),
      description: a.description,
      status: a.status,
      elapsed: clock((a.endedAt ?? a.startedAt) - a.startedAt),
      tokens: tokensText(a.tokens),
    })),
  ].sort((a, b) => b.at - a.at)
  const reviewers = sessionRuns.flatMap(run => run.reviewers)
  const reviewTokens = sum(reviewers.map(r => r.tokens))
  const byProvider = [...new Set(reviewers.map(r => r.provider))]
    .map(p => `${PROVIDER_SHORT[p] ?? p} ${shortCount(sum(reviewers.filter(r => r.provider === p).map(r => r.tokens)).in)}`)
    .join(' · ')
  const agentTokens = sum(agents.map(a => a.tokens))
  const totals = [
    `This session${usd === null ? '' : ` · Claude $${usd.toFixed(2)} so far`}`,
    `  Claude      ${record.turns} turns · ${shortCount(record.main.in)} in · ${shortCount(record.main.out)} out`,
    `  Reviews     ${sessionRuns.length} runs · ${shortCount(reviewTokens.in)} in · ${shortCount(reviewTokens.out)} out`,
    ...(byProvider === '' ? [] : [`              ${byProvider} in`]),
    `  Agents      ${agents.length} · ${shortCount(agentTokens.in)} in · ${shortCount(agentTokens.out)} out`,
  ]
  return { totals, entries: entries.map(({ at: _, ...e }) => e), page }
}

/** The settings' limits with this session's raises and switches. */
export function limitsOf(base: Settings['limits'], record: SessionRecord): Limits {
  return {
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
    rows: [
      { label: 'Reviews', spent: String(spent.reviewRuns), limit: `${limits.reviewRuns} runs`, raise: 'reviewRuns', raiseLabel: `+${RAISE_BY.reviewRuns} runs` },
      {
        label: '',
        spent: shortCount(spent.reviewTokens),
        limit: `${shortCount(limits.reviewTokens)} fresh tokens`,
        raise: 'reviewTokens',
        raiseLabel: `+${shortCount(RAISE_BY.reviewTokens)}`,
      },
      {
        label: 'Claude agents',
        spent: shortCount(spent.agentTokens),
        limit: `${shortCount(limits.agentTokens)} fresh tokens`,
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
  sessionRuns: readonly Run[]
  agents: readonly ClaudeAgent[]
  record: SessionRecord
  limits: Settings['limits']
}

export function overviewProps(v: ViewInput): OverviewProps {
  const running = runningProps(v.sessionRuns, v.agents, v.now)
  const log = logProps(v.sessionRuns, v.agents, v.record, v.usd, v.page)
  return {
    tab: v.tab,
    counts: { running: running.runs.length + running.agents.length, log: log.entries.length },
    rows: v.rows,
    running,
    log,
    limits: limitsProps(limitsOf(v.limits, v.record), spentOf(v.sessionRuns, v.agents)),
  }
}
