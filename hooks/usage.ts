import type { ProvidersTokens } from 'cc-providers'

/** Tokens one agent spent, as cc-providers counts them for every provider. */
export type Tokens = ProvidersTokens

const num = (o: Record<string, unknown>, key: string): number => (typeof o[key] === 'number' ? (o[key] as number) : 0)

/** The counts added up; `written` and `written1h` only where some were reported. */
export function sum(all: readonly (Tokens | undefined)[]): Tokens {
  return all.reduce<Tokens>((s, t) => {
    if (t === undefined) return s
    const written = s.written === undefined && t.written === undefined ? {} : { written: (s.written ?? 0) + (t.written ?? 0) }
    const written1h = s.written1h === undefined && t.written1h === undefined ? {} : { written1h: (s.written1h ?? 0) + (t.written1h ?? 0) }
    return { in: s.in + t.in, cached: s.cached + t.cached, ...written, ...written1h, out: s.out + t.out }
  }, { in: 0, cached: 0, out: 0 })
}

/** A Claude turn's usage: input_tokens is only the part neither read from nor written to the cache. */
export function claudeTokens(u: Record<string, unknown>): Tokens {
  const cached = num(u, 'cache_read_input_tokens')
  const written = num(u, 'cache_creation_input_tokens')
  const base = { in: num(u, 'input_tokens') + cached + written, cached, written, out: num(u, 'output_tokens') }
  const split = u.cache_creation
  if (split === null || typeof split !== 'object') return base
  return { ...base, written1h: num(split as Record<string, unknown>, 'ephemeral_1h_input_tokens') }
}

/** `837k`, `1.2M`, `950`. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export const usd = (n: number) => `$${n.toFixed(2)}`
