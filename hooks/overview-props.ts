import type { Gate } from './limits'

export type Tab = 'running' | 'log' | 'limits'

export type Raise = 'reviewRuns' | 'reviewTokens' | 'agentTokens'

/** What a press on the overview asks for. */
export type OverviewAction =
  | { tab: Tab }
  | { stop: { run: string; key?: string } }
  | { brief: string }
  | { page: 1 | -1 }
  | { raise: Raise }
  | { toggle: Gate }

export type ReviewerRow = {
  key: string
  provider: string
  /** `sol · medium`; empty when neither is set. */
  pick: string
  status: string
  elapsed: string
  isRunning: boolean
  /** `212k in · 9k out` once it reported usage. */
  tokens: string | null
}

export type RunRow = { id: string; description: string; elapsed: string; reviewers: ReviewerRow[] }

export type AgentRow = { id: string; type: string; description: string; status: string; elapsed: string; tokens: string | null }

export type RunningProps = { runs: RunRow[]; agents: AgentRow[] }

/** One finished run or agent in the log, newest first; `time` is when it started, `13:07`. */
export type LogEntry =
  | { kind: 'run'; time: string; description: string; elapsed: string; tally: string; reviewers: (ReviewerRow & { findings: string })[] }
  | { kind: 'agent'; time: string; type: string; description: string; status: string; elapsed: string; tokens: string | null }

export type LogProps = { totals: string[]; entries: LogEntry[]; page: number }

export type LimitRow = { label: string; spent: string; limit: string; raise: Raise; raiseLabel: string }

export type LimitsProps = { rows: LimitRow[]; gates: { gate: Gate; isOpen: boolean }[] }

export type OverviewProps = {
  tab: Tab
  /** What the tab row counts: runs and agents running, entries logged. */
  counts: { running: number; log: number }
  /** The rows the drawer has for the view, the tab row included. */
  rows: number
  running: RunningProps
  log: LogProps
  limits: LimitsProps
}

export type BriefProps = { title: string; lines: string[] }
