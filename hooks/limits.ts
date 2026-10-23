import type { Provider } from './config.ts'
import type { Tokens } from './usage.ts'

/** What counts against a limit: tokens not served from a cache, in and out; a cache read costs a fraction of one. */
export function fresh(t: Tokens | undefined): number {
  return t === undefined ? 0 : t.in - t.cached + t.out
}

export function sum(all: readonly (Tokens | undefined)[]): Tokens {
  return all.reduce<Tokens>((s, t) => (t === undefined ? s : { in: s.in + t.in, cached: s.cached + t.cached, out: s.out + t.out }), { in: 0, cached: 0, out: 0 })
}

/** Who may be stopped from starting: a reviewer provider, or Claude's own agents. */
export type Gate = Provider | 'agents'

export const GATES: readonly Gate[] = ['codex', 'antigravity', 'claude', 'agents']

/** A session's limits: the settings' defaults with this session's raises on top. */
export type Limits = { reviewRuns: number; reviewTokens: number; agentTokens: number; closed: readonly Gate[] }

/** What the session has spent so far. */
export type Spent = { reviewRuns: number; reviewTokens: number; agentTokens: number }

const RAISE_WHERE = 'raise it in the crew tab (Limits) for this session, or in /config for every session'

/** Why a review with these providers may not start, or undefined when it may. */
export function reviewRefusal(limits: Limits, spent: Spent, providers: readonly Provider[]): string | undefined {
  const closed = providers.filter(p => limits.closed.includes(p))
  if (closed.length > 0) return `${closed.join(', ')} reviewers are switched off for this session in the crew tab (Limits)`
  if (spent.reviewRuns >= limits.reviewRuns) return `this session ran ${spent.reviewRuns} reviews, its limit is ${limits.reviewRuns}: ${RAISE_WHERE}`
  if (spent.reviewTokens >= limits.reviewTokens) {
    return `this session's reviews spent ${spent.reviewTokens} fresh tokens, the limit is ${limits.reviewTokens}: ${RAISE_WHERE}`
  }
  return undefined
}

/** Why a follow-up may not be asked, or undefined: it adds tokens, not a run. */
export function followUpRefusal(limits: Limits, spent: Spent, provider: Provider): string | undefined {
  if (limits.closed.includes(provider)) return `${provider} reviewers are switched off for this session in the crew tab (Limits)`
  if (spent.reviewTokens >= limits.reviewTokens) {
    return `this session's reviews spent ${spent.reviewTokens} fresh tokens, the limit is ${limits.reviewTokens}: ${RAISE_WHERE}`
  }
  return undefined
}

/** Why one of Claude's own agents may not start, or undefined. */
export function agentRefusal(limits: Limits, spent: Spent): string | undefined {
  if (limits.closed.includes('agents')) return "Claude's agents are switched off for this session in the crew tab (Limits)"
  if (spent.agentTokens >= limits.agentTokens) {
    return `this session's agents spent ${spent.agentTokens} fresh tokens, the limit is ${limits.agentTokens}: ${RAISE_WHERE}`
  }
  return undefined
}
