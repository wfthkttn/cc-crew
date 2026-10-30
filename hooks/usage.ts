import type { BusSpend } from 'cc-bus'
import type { ProvidersTokens } from 'cc-providers'

/** The token columns the views show. */
export type Shown = Pick<ProvidersTokens, 'in' | 'cached' | 'out'>

/** What cc-agents added up for the session, asked over the bus for each draw. */
export type Spend = BusSpend

/** `837k`, `1.2M`, `950`. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export const usd = (n: number) => `$${n.toFixed(2)}`
