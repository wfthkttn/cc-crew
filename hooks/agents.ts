import type { AgentInfo, AgentStatus } from 'claude-code'

import { sum } from './limits.ts'
import type { Tokens } from './usage.ts'

/** One agent Claude started in this session: an Agent tool subagent, or one agent of a workflow run. */
export type ClaudeAgent = {
  id: string
  type: string
  description: string
  /** The workflow run it belongs to, `wf_...`. */
  workflow?: string
  /** What it runs on, as its spawn resolved it. */
  model?: string
  startedAt: number
  /** When its last turn ended. */
  endedAt?: number
  /** Where its loop stands: the engine's word while it lists the agent, else ours from its turns. */
  status: AgentStatus
  /** Every turn it finished, summed. */
  tokens?: Tokens
}

export const LIVE: readonly AgentStatus[] = ['pending', 'running', 'waiting']

/** Claude's own agents of this load, newest last; crew's reviewers are not among them. */
export class ClaudeAgents {
  private byId = new Map<string, ClaudeAgent>()

  /**
   * The agents a session record kept, in place of any held now. One kept as running goes on if the engine still lists it
   * (crew reloaded under it); one it does not list ended with an earlier process.
   */
  restore(kept: readonly ClaudeAgent[], listed: readonly AgentInfo[]): void {
    const live = new Set(listed.map(a => a.id))
    this.byId = new Map(kept.map(a => [a.id, LIVE.includes(a.status) && !live.has(a.id) ? { ...a, status: 'killed' as const } : { ...a }]))
    this.refresh(listed)
  }

  started(a: Omit<ClaudeAgent, 'status'>): void {
    this.byId.set(a.id, { ...a, status: 'running' })
  }

  /** A turn of a known agent ended; false for an agent this session did not see start. */
  finished(id: string, isAnswer: boolean, tokens: Tokens | undefined, at: number): boolean {
    const a = this.byId.get(id)
    if (a === undefined) return false
    a.status = isAnswer ? 'completed' : 'failed'
    a.endedAt = at
    if (tokens !== undefined) a.tokens = a.tokens === undefined ? tokens : sum([a.tokens, tokens])
    return true
  }

  /** Takes the engine's status for every agent it still lists; a resumed agent runs again this way. */
  refresh(listed: readonly AgentInfo[]): void {
    for (const info of listed) {
      const a = this.byId.get(info.id)
      if (a !== undefined) a.status = info.status
    }
  }

  all(): ClaudeAgent[] {
    return [...this.byId.values()]
  }
}
