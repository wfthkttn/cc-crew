import type { PluginOptions } from 'claude-code'

export const PROVIDERS = ['codex', 'antigravity', 'claude', 'claude-p'] as const
export type Provider = (typeof PROVIDERS)[number]

export type Settings = {
  codexBin: string
  agyBin: string
  reviewers: Provider[]
  reviewerRules: string[]
  timeoutMs: number
}

export function isProvider(name: string): name is Provider {
  return (PROVIDERS as readonly string[]).includes(name)
}

export function settingsFrom(options: PluginOptions): Settings {
  const reviewers = options.reviewers as readonly string[]
  const unknown = reviewers.filter(r => !isProvider(r))
  if (unknown.length > 0) {
    throw new Error(`crew: unknown reviewers in settings: ${unknown.join(', ')} (known: ${PROVIDERS.join(', ')})`)
  }
  return {
    codexBin: options.codex_bin as string,
    agyBin: options.agy_bin as string,
    reviewers: reviewers as Provider[],
    reviewerRules: [...(options.reviewer_rules as readonly string[])],
    timeoutMs: (options.timeout_s as number) * 1000,
  }
}
