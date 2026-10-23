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
  /** Each session's limits before the Limits tab raises them; `models` by limit name, others get `modelDefault`. */
  limits: { reviewRuns: number; modelDefault: number; models: Record<string, number> }
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

const SCALE: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 }

/** `claude opus=5M` as its name and tokens. */
function modelLimitOf(entry: string): [string, number] {
  const at = entry.lastIndexOf('=')
  const amount = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(entry.slice(at + 1))
  const name = entry.slice(0, at).trim()
  if (at < 0 || name === '' || amount === null) {
    throw new Error(`crew: model limit "${entry}" in settings is not <model>=<tokens>, e.g. "claude opus=5M"`)
  }
  return [name, Math.round(Number(amount[1]) * SCALE[amount[2]!.toLowerCase()]!)]
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
    limits: {
      reviewRuns: options.limit_review_runs as number,
      modelDefault: options.limit_model_tokens as number,
      models: Object.fromEntries((options.model_limits as readonly string[]).map(modelLimitOf)),
    },
  }
}
