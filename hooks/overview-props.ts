import type { Gate } from './limits'

export type Tab = 'running' | 'limits' | 'log'

/** What a raise press adds to: the reviews a session may start, or one model's tokens by its limit name. */
export type Raise = 'reviewRuns' | { model: string }

/** A run or an agent whose details the pop-out shows. */
export type Target = { run: string } | { agent: string }

/** What a press on the overview asks for. */
export type OverviewAction =
  | { tab: Tab }
  | { stop: { run: string; key?: string } }
  | { open: Target }
  | { page: 1 | -1 }
  | { raise: Raise }
  | { toggle: Gate }
  | { switchLimits: true }

export type ReviewerRow = {
  key: string
  provider: string
  /** `sol · medium`; empty when neither is set. */
  pick: string
  status: string
  elapsed: string
  isRunning: boolean
  /** `109k new · 4k out` once it reported usage. */
  tokens: string | null
}

export type RunRow = { id: string; description: string; elapsed: string; reviewers: ReviewerRow[] }

export type AgentRow = { id: string; type: string; description: string; status: string; elapsed: string; tokens: string | null }

/** Token counts as a table's columns show them, `109k`; empty where nothing was reported. */
export type TokenCells = { new: string; cached: string; out: string }

/** A row of the session's totals; `isPart` rows break the one above down. */
export type TotalRow = TokenCells & { label: string; count: string; isPart: boolean }

/** The first tab: what the session spent, then what runs now. */
export type RunningProps = {
  totals: TotalRow[]
  runs: RunRow[]
  agents: AgentRow[]
}

/** One finished run or agent, newest first; a press opens its details. */
export type LogRow = TokenCells & { time: string; what: string; status: string; took: string; open: Target }

export type LogProps = { rows: LogRow[]; page: number }

/** `isOver`: what is spent reached the limit, so new work on it is refused. */
export type LimitRow = { label: string; spent: string; limit: string; raise: Raise; raiseLabel: string; isOver: boolean }

/**
 * `isOn` false: the limits below are shown but not enforced; the gates still are. `models` are the ones that spent or have
 * a limit of their own; any other has `modelDefault`.
 */
export type LimitsProps = { isOn: boolean; reviews: LimitRow; models: LimitRow[]; modelDefault: string; gates: { gate: Gate; isOpen: boolean }[] }

export type OverviewProps = {
  tab: Tab
  /** What the tab row counts: runs and agents running, entries logged. */
  counts: { running: number; log: number }
  /** The rows the drawer has for the view, the tab row included. */
  rows: number
  /** The run or agent the pop-out shows, so its line reads as open. */
  opened: Target | null
  running: RunningProps
  log: LogProps
  limits: LimitsProps
}

export type DetailProps = { title: string; lines: string[] }
