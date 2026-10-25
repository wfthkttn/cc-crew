import type { Group } from './catalog.ts'
import { BUILT_IN, type Provider } from './config.ts'
import type { CustomReviewer } from './reviewers.ts'
import type { Tokens } from './usage.ts'

/** The counts added up; `written` only where some were reported. */
export function sum(all: readonly (Tokens | undefined)[]): Tokens {
  return all.reduce<Tokens>((s, t) => {
    if (t === undefined) return s
    const written = s.written === undefined && t.written === undefined ? {} : { written: (s.written ?? 0) + (t.written ?? 0) }
    return { in: s.in + t.in, cached: s.cached + t.cached, ...written, out: s.out + t.out }
  }, { in: 0, cached: 0, out: 0 })
}

/** Who may be stopped from starting: a reviewer provider, or Claude's own agents. */
export type Gate = Provider | 'agents'

/** Each built-in reviewer, each one reviewers.json adds, and Claude's agents. */
export const gatesOf = (custom: readonly CustomReviewer[]): Gate[] => [...BUILT_IN, ...custom.map(r => r.name), 'agents']

/** A session's limits in $ at API prices, by group id: the catalog's with this session's raises on top; `isOn` false leaves only the gates. */
export type Limits = {
  isOn: boolean
  groups: Readonly<Record<string, number>>
  /** For a group the catalog gives no limit. */
  fallbackUsd: number
  closed: readonly Gate[]
}

export const groupLimit = (limits: Limits, group: string): number => limits.groups[group] ?? limits.fallbackUsd

/** $ at API prices by group id the session spent, reviewers and Claude's agents together. */
export type Spent = Readonly<Record<string, number>>

export const usd = (n: number) => `$${n.toFixed(2)}`

const RAISE_WHERE = 'raise it in the crew tab (Limits) for this session, or in models.json for every session'

function overGroup(limits: Limits, spent: Spent, group: Group): string | undefined {
  const used = spent[group.id] ?? 0
  const limit = groupLimit(limits, group.id)
  if (used < limit) return undefined
  return `the ${group.name} group spent ${usd(used)} at API prices in this session, its limit is ${usd(limit)}: ${RAISE_WHERE}`
}

/** Why a review may not start, or undefined when it may; `groups` are its reviewers' groups. */
export function reviewRefusal(limits: Limits, spent: Spent, providers: readonly Provider[], groups: readonly Group[]): string | undefined {
  const closed = providers.filter(p => limits.closed.includes(p))
  if (closed.length > 0) return `${closed.join(', ')} reviewers are switched off for this session in the crew tab (Limits)`
  if (!limits.isOn) return undefined
  return groups.map(g => overGroup(limits, spent, g)).find(r => r !== undefined)
}

/** Why a follow-up may not be asked, or undefined: it adds spend, not a run. */
export function followUpRefusal(limits: Limits, spent: Spent, provider: Provider, group: Group): string | undefined {
  if (limits.closed.includes(provider)) return `${provider} reviewers are switched off for this session in the crew tab (Limits)`
  if (!limits.isOn) return undefined
  return overGroup(limits, spent, group)
}

/** Why one of Claude's own agents may not start in `group`, or undefined. */
export function agentRefusal(limits: Limits, spent: Spent, group: Group): string | undefined {
  if (limits.closed.includes('agents')) return "Claude's agents are switched off for this session in the crew tab (Limits)"
  if (!limits.isOn) return undefined
  return overGroup(limits, spent, group)
}
