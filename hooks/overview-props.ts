/** What a press on the overview asks for. */
export type OverviewAction = { stop: { run: string; key?: string } } | { brief: string }

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

export type OverviewProps = { runs: RunRow[]; agents: AgentRow[] }

export type BriefProps = { title: string; lines: string[] }
