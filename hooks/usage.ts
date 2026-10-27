import type { Kind } from './config.ts'

/** Tokens one reviewer or agent spent, alike for every provider. */
export type Tokens = {
  /** Every input token, the cached ones included. */
  in: number
  /** The part of `in` the provider's cache served. */
  cached: number
  /** The part of `in` written to the cache, where the provider reports it apart (Claude). */
  written?: number
  /** The part of `written` that went to the 1-hour cache, where the report splits writes by lifetime. */
  written1h?: number
  /** Every generated token, reasoning included. */
  out: number
  /** The part of `out` spent reasoning, where the provider reports it. */
  reasoning?: number
}

const num = (o: Record<string, unknown>, key: string): number => (typeof o[key] === 'number' ? (o[key] as number) : 0)

/** A reviewer's own usage report as Tokens, read the way its kind reports; undefined when it reported none. */
export function tokensOf(kind: Kind, raw: unknown): Tokens | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  switch (kind) {
    case 'codex':
      // Codex counts its cached input inside input_tokens, and reasoning inside output_tokens.
      return { in: num(u, 'input_tokens'), cached: num(u, 'cached_input_tokens'), out: num(u, 'output_tokens'), reasoning: num(u, 'reasoning_output_tokens') }
    case 'antigravity':
      // Antigravity counts cache reads apart from input_tokens, and thinking inside output_tokens.
      return {
        in: num(u, 'input_tokens') + num(u, 'cache_read_tokens'),
        cached: num(u, 'cache_read_tokens'),
        out: num(u, 'output_tokens'),
        reasoning: num(u, 'thinking_tokens'),
      }
    case 'claude':
    case 'claude-p':
      return claudeTokens(u)
  }
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
