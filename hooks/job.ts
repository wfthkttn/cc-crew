import type { Findings } from './prompt.ts'

/** One reviewer's run: what it may read and what it is asked. */
export type Job = {
  /** This reviewer's own folder for its files, absolute. */
  dir: string
  roots: readonly string[]
  /** The roots that are files rather than folders. */
  files: readonly string[]
  /** Secret files under the roots, absolute. */
  secrets: readonly string[]
  system: string
  task: string
  web: boolean
  helpers: boolean
  model?: string
  effort?: string
  timeoutMs: number
  signal?: AbortSignal
}

export type FollowUp = Omit<Job, 'task'> & {
  continueId: string
  message: string
  /** The first run's folder, where a harness that keeps its state per run kept it. */
  stateDir: string
}

export type Status = 'ok' | 'signed_out' | 'quota' | 'failed' | 'timeout' | 'stopped' | 'left_roots'

export type Outcome = {
  status: Status
  /** The reviewer's final answer as it wrote it; empty when there was none. */
  text: string
  findings?: Findings
  model: string
  usage?: unknown
  /** What a follow-up passes to reach the same conversation. */
  continueId?: string
  /** Why it is not ok, in the harness's words where it gave any. */
  detail?: string
}

export type Preflight = { ok: true } | { ok: false; status: 'signed_out' | 'failed'; detail: string }
