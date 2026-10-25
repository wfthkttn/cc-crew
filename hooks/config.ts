import type { PluginOptions } from 'claude-code'

export const BUILT_IN = ['codex', 'antigravity', 'claude'] as const
export type BuiltIn = (typeof BUILT_IN)[number]

/** A built-in, or a reviewer the person's reviewers.json names. */
export type Provider = string

/** How a reviewer runs: a built-in's own way, or a `claude -p` child for a reviewer from reviewers.json. */
export type Kind = BuiltIn | 'claude-p'

export type Choice = { model?: string; effort?: string }

export type Settings = {
  codexBin: string
  agyBin: string
  /** Checked against the known reviewers when a review uses them: reviewers.json is read at session start. */
  reviewers: Provider[]
  /** What a reviewer of each built-in runs when its call leaves the model or effort out. */
  defaults: Partial<Record<BuiltIn, Choice>>
  reviewerRules: string[]
  timeoutMs: number
  /** A group's limit in $ at API prices when models.json gives it none. */
  fallbackUsd: number
  /** Claude Code's config folder, parts of which a `claude -p` reviewer is denied. */
  claudeConfigDir: string
}

export function isBuiltIn(name: string): name is BuiltIn {
  return (BUILT_IN as readonly string[]).includes(name)
}

/** The call's own model and effort win; the provider's defaults fill what it left out. */
export function withDefaults<T extends { provider: Provider } & Choice>(spec: T, defaults: Partial<Record<Provider, Choice>>): T {
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

export function settingsFrom(options: PluginOptions, claudeConfigDir: string): Settings {
  return {
    claudeConfigDir,
    codexBin: options.codex_bin as string,
    agyBin: options.agy_bin as string,
    reviewers: [...(options.reviewers as readonly string[])],
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
