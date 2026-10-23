import type { AgentInfo, AgentStatus } from 'claude-code'

import type { Tokens } from './usage.ts'

/** One agent Claude started in this session: an Agent tool subagent, or one agent of a workflow run. */
export type ClaudeAgent = {
  id: string
  type: string
  description: string
  /** The workflow run it belongs to, `wf_...`. */
  workflow?: string
  startedAt: number
  /** Where its loop stands: the engine's word while it lists the agent, else ours from its turns. */
  status: AgentStatus
  /** Every turn it finished, summed. */
  tokens?: Tokens
}

export const LIVE: readonly AgentStatus[] = ['pending', 'running', 'waiting']

function add(a: Tokens | undefined, b: Tokens): Tokens {
  if (a === undefined) return b
  return { in: a.in + b.in, cached: a.cached + b.cached, out: a.out + b.out }
}

/** Claude's own agents of this load, newest last; crew's reviewers are not among them. */
export class ClaudeAgents {
  private byId = new Map<string, ClaudeAgent>()

  started(a: Omit<ClaudeAgent, 'status'>): void {
    this.byId.set(a.id, { ...a, status: 'running' })
  }

  /** A turn of a known agent ended; false for an agent this load did not see start. */
  finished(id: string, isAnswer: boolean, tokens: Tokens | undefined): boolean {
    const a = this.byId.get(id)
    if (a === undefined) return false
    a.status = isAnswer ? 'completed' : 'failed'
    if (tokens !== undefined) a.tokens = add(a.tokens, tokens)
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
