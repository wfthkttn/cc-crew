import type { Gate } from './limits'

export type Tab = 'running' | 'usage' | 'limits' | 'log'

/** What a raise press adds to: one model's tokens, by its limit name. */
export type Raise = { model: string }

/** A run, an agent or a model (by its limit name) whose details the pop-out shows. */
export type Target = { run: string } | { agent: string } | { model: string }

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

export type RunRow = { kind: 'review'; id: string; description: string; elapsed: string; reviewers: ReviewerRow[] }

export type AgentRow = { kind: 'agent'; id: string; type: string; description: string; status: string; elapsed: string; tokens: string | null }

/** Token counts as a table's columns show them, `109k`; empty where nothing was reported. */
export type TokenCells = { new: string; cached: string; out: string }

/** The first tab: the reviews and agents running now, newest first. */
export type RunningProps = { live: (RunRow | AgentRow)[] }

/** A row of the session's usage: Claude's own chat, then each model its reviewers and agents ran on; a model's row opens its details. */
export type UsageRow = TokenCells & { label: string; count: string; weighted: string; model: string | null }

export type UsageProps = { rows: UsageRow[] }

/** One finished run or agent, newest first; a press opens its details. */
export type LogRow = TokenCells & { time: string; what: string; status: string; took: string; open: Target }

export type LogProps = { rows: LogRow[]; page: number }

/** `isOver`: what is spent reached the limit, so new work on it is refused. */
export type LimitRow = { label: string; spent: string; limit: string; raise: Raise; raiseLabel: string; isOver: boolean }

/**
 * `isOn` false: the limits below are shown but not enforced; the gates still are. `models` are the ones that spent or have
 * a limit of their own; any other has `modelDefault`.
 */
export type LimitsProps = { isOn: boolean; models: LimitRow[]; modelDefault: string; gates: { gate: Gate; isOpen: boolean }[] }

export type OverviewProps = {
  tab: Tab
  /** What the tab row counts: runs and agents running, entries logged. */
  counts: { running: number; log: number }
  /** The rows the drawer has for the view, the tab row included. */
  rows: number
  /** The run or agent the pop-out shows, so its line reads as open. */
  opened: Target | null
  running: RunningProps
  usage: UsageProps
  log: LogProps
  limits: LimitsProps
}

export type DetailProps = { title: string; lines: string[] }
