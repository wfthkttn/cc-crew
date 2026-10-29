import type { PluginOptions } from 'claude-code'

export type Choice = { model?: string; effort?: string }

export type Settings = {
  /** Provider ids, checked against the providers that run headless when a review uses them. */
  reviewers: string[]
  /** What a reviewer of each provider runs when its call leaves the model or effort out; a provider absent here runs its own default. */
  defaults: Record<string, Choice>
  reviewerRules: string[]
  timeoutMs: number
}

/** The call's own model and effort win; the provider's defaults fill what it left out. */
export function withDefaults<T extends { provider: string } & Choice>(spec: T, defaults: Readonly<Record<string, Choice>>): T {
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
  return {
    reviewers: [...(options.reviewers as readonly string[])],
    defaults: {
      codex: choice(options.codex_model, options.codex_effort),
      antigravity: choice(options.agy_model, options.agy_effort),
      claude: choice(options.claude_model, options.claude_effort),
    },
    reviewerRules: [...(options.reviewer_rules as readonly string[])],
    timeoutMs: (options.timeout_s as number) * 1000,
  }
}
