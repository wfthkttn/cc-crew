import type { Gate } from './limits'

export type Tab = 'running' | 'usage' | 'limits' | 'log'

/** A raise press: `usd` more for one quota group, by its id. */
export type Raise = { group: string; usd: number }

/** What the pop-out shows: a run, an agent, a quota group (by id) or a model (by catalog key). */
export type Target = { run: string } | { agent: string } | { group: string } | { model: string }

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

/**
 * A row of the session's usage: this chat, then each quota group with its models under it (`isPart`); `usd` at API
 * prices; `isGuessed` for a model models.json neither places nor prices, so crew stood in; a group's or model's row opens it.
 */
export type UsageRow = TokenCells & { label: string; count: string; usd: string; isPart: boolean; isGuessed: boolean; open: Target | null }

/** `note`: why the catalog stands on models.json alone where it would ask a tool, as the drawer's lines; empty when it doesn't. */
export type UsageProps = { rows: UsageRow[]; isGuessing: boolean; note: string[] }

/** One finished run or agent, newest first; a press opens its details. */
export type LogRow = TokenCells & { time: string; what: string; status: string; took: string; open: Target }

export type LogProps = { rows: LogRow[]; page: number }

/** `isOver`: what is spent reached the limit, so new work on it is refused. */
export type LimitRow = { label: string; spent: string; limit: string; raises: { label: string; raise: Raise }[]; isOver: boolean }

/** `isOn` false: the group limits are shown but not enforced; the gates still are. */
export type LimitsProps = { isOn: boolean; groups: LimitRow[]; gates: { gate: Gate; isOpen: boolean }[] }

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

/** One page of a details text: `lines` are the page's, `first`–`last` of `total` count from 1. */
export type DetailProps = { title: string; lines: string[]; columns: number; page: number; pages: number; first: number; last: number; total: number }
