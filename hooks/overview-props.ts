export type Tab = 'running' | 'jobs' | 'usage' | 'limits' | 'quota' | 'log'

export type Role = 'main' | 'helpers'

/** A raise press: `usd` more for one role in one pool, by the pool's id. */
export type Raise = { pool: string; role: Role; usd: number }

/** What the pop-out shows: a job, an agent, a pool (by id) or a model (by its `<provider>/<model>` key). */
export type Target = { run: string } | { agent: string } | { group: string } | { model: string }

/** What a press on the overview asks for. */
export type OverviewAction =
  | { tab: Tab }
  | { stop: { run: string; key?: string } }
  | { open: Target }
  | { page: 1 | -1 }
  | { raise: Raise }
  | { toggle: string }
  | { switchLimits: true }
  | { tick: { job: string; model: string } }
  | { poke: { job: string; model: string; by: number } }

export type MemberRow = {
  /** The agent's letter. */
  key: string
  provider: string
  /** `sol · medium`; empty when neither is set. */
  pick: string
  status: string
  elapsed: string
  isRunning: boolean
  /** `109k new · 4k out` once it reported usage. */
  tokens: string | null
  /** What liveness last read of it, while it runs. */
  reading: string | null
  isStalled: boolean
}

export type RunRow = { kind: 'job'; id: string; description: string; elapsed: string; members: MemberRow[] }

export type AgentRow = { kind: 'agent'; id: string; type: string; description: string; status: string; elapsed: string; tokens: string | null }

/** Token counts as a table's columns show them, `109k`; empty where nothing was reported. */
export type TokenCells = { new: string; cached: string; out: string }

/** The first tab: the jobs and agents running now, newest first. */
export type RunningProps = { live: (RunRow | AgentRow)[] }

/**
 * A row of the session's usage: this chat, then each pool with its models under it (`isPart`); `usd` at API prices;
 * `isGuessed` where some of it was priced at the dearest it could be; a pool's or model's row opens it.
 */
export type UsageRow = TokenCells & { label: string; count: string; usd: string; isPart: boolean; isGuessed: boolean; open: Target | null }

export type UsageProps = { rows: UsageRow[]; isGuessing: boolean }

/** One finished job or agent, newest first; a press opens its details. */
export type LogRow = TokenCells & { time: string; what: string; status: string; took: string; open: Target }

export type LogProps = { rows: LogRow[]; page: number }

/** One role's spend in a pool against its limit; `limit` null where the pool sets none, so it has no raises. */
export type RoleRow = { role: Role; spent: string; limit: string | null; raises: { label: string; raise: Raise }[]; isOver: boolean }

/** A pool: its helpers, then its conversation where it has a limit or spent; `isPaused` while the conversation is paused there. */
export type LimitRow = { label: string; roles: RoleRow[]; isPaused: boolean }

/** `isOn` false: the limits are shown but not enforced; the gates still are. */
export type LimitsProps = { isOn: boolean; pools: LimitRow[]; gates: { gate: string; isOpen: boolean }[] }

/** One window of a pool: how much is left and when it resets. */
export type QuotaRow = { pool: string; window: string; left: string; resets: string; isLow: boolean }

/** A provider's quota: its windows by pool, and why some are missing. */
export type QuotaBlock = { title: string; color: string; rows: QuotaRow[]; notes: string[] }

export type QuotaProps = { blocks: QuotaBlock[] }

/** A job's models: `isTicked` where a call runs it in this session, and after how many minutes an idle conversation hears. */
export type JobRow = { job: string; models: { model: string; isTicked: boolean; pokeMin: number }[] }

/** `problems`: what is wrong with crew's setup, as drawn lines. */
export type JobsProps = { jobs: JobRow[]; problems: string[] }

export type OverviewProps = {
  tab: Tab
  /** What the tab row counts: jobs and agents running, entries logged. */
  counts: { running: number; log: number }
  /** The rows the drawer has for the view, the tab row included. */
  rows: number
  /** The job, agent, pool or model the pop-out shows, so its line reads as open. */
  opened: Target | null
  running: RunningProps
  jobs: JobsProps
  usage: UsageProps
  log: LogProps
  limits: LimitsProps
  quota: QuotaProps
}

/** One page of a details text: `lines` are the page's, `first`–`last` of `total` count from 1. */
export type DetailProps = { title: string; lines: string[]; columns: number; page: number; pages: number; first: number; last: number; total: number }
