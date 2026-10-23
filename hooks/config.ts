import type { PluginOptions } from 'claude-code'

export const PROVIDERS = ['codex', 'antigravity', 'claude', 'claude-p'] as const
export type Provider = (typeof PROVIDERS)[number]

export type Choice = { model?: string; effort?: string }

export type Settings = {
  codexBin: string
  agyBin: string
  reviewers: Provider[]
  /** What a reviewer of each provider runs when its call leaves the model or effort out. */
  defaults: Partial<Record<Provider, Choice>>
  reviewerRules: string[]
  timeoutMs: number
  /** A group's limit in $ at API prices when models.json gives it none. */
  fallbackUsd: number
}

export function isProvider(name: string): name is Provider {
  return (PROVIDERS as readonly string[]).includes(name)
}

/** The call's own model and effort win; the provider's defaults fill what it left out. */
export function withDefaults<T extends { provider: Provider } & Choice>(spec: T, defaults: Settings['defaults']): T {
  const d = defaults[spec.provider] ?? {}
  return {
    ...spec,
    ...(spec.model === undefined && d.model !== undefined ? { model: d.model } : {}),
    ...(spec.effort === undefined && d.effort !== undefined ? { effort: d.effort } : {}),
  }
}

/** An empty setting leaves the choice to the reviewer's own tool. */
function choice(model: unknown, effort: unknown): Choice {
  return {
    ...(model === '' ? {} : { model: model as string }),
    ...(effort === '' ? {} : { effort: effort as string }),
  }
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
    defaults: {
      codex: choice(options.codex_model, options.codex_effort),
      antigravity: choice(options.agy_model, options.agy_effort),
      claude: choice(options.claude_model, options.claude_effort),
    },
    reviewerRules: [...(options.reviewer_rules as readonly string[])],
    timeoutMs: (options.timeout_s as number) * 1000,
    fallbackUsd: options.limit_group_usd as number,
  }
}
