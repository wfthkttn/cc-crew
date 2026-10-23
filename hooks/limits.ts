import { DEFAULT_MODEL } from './claude.ts'
import type { Provider } from './config.ts'
import type { Tokens } from './usage.ts'

/**
 * How the plans weigh a token against new input, as their API prices do: OpenAI's Codex credits and Google's Gemini pool
 * are drawn down so; Anthropic publishes no formula and its API ratios stand in. One set for every model: Codex's cached
 * input is 0.05 on some models, Gemini's output up to 8.
 */
export const WEIGHTS = { cached: 0.1, written: 1.25, out: 5 } as const

/** What counts against a model's limit: tokens weighted as `WEIGHTS`, in new-input tokens. */
export function weighted(t: Tokens | undefined): number {
  if (t === undefined) return 0
  const written = t.written ?? 0
  return Math.round(t.in - t.cached - written + WEIGHTS.cached * t.cached + WEIGHTS.written * written + WEIGHTS.out * t.out)
}

/** The counts added up; `written` only where some were reported. */
export function sum(all: readonly (Tokens | undefined)[]): Tokens {
  return all.reduce<Tokens>((s, t) => {
    if (t === undefined) return s
    const written = s.written === undefined && t.written === undefined ? {} : { written: (s.written ?? 0) + (t.written ?? 0) }
    return { in: s.in + t.in, cached: s.cached + t.cached, ...written, out: s.out + t.out }
  }, { in: 0, cached: 0, out: 0 })
}

/** The quota a provider draws on, as a model's limit name begins: Claude's own agents share Anthropic's with the claude reviewers. */
const POOL: Record<Provider, string> = { codex: 'codex', antigravity: 'agy', claude: 'claude', 'claude-p': 'claude' }

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/
const CLAUDE_FAMILY = /(opus|sonnet|haiku|fable)/

/** A Claude model's limit name: an alias and every id of its family are one model (`opus`, `claude-opus-5-5`, `claude-opus-5-5[1m]`). */
export function claudeModel(model: string): string {
  return `claude ${CLAUDE_FAMILY.exec(model)?.[1] ?? model}`
}

/**
 * The limit name a reviewer's spend counts against: `claude opus`, `agy gemini-3.8-flash`, `codex default`. An Antigravity
 * id's effort suffix is dropped, as the quota is the model's. Without a model a Claude reviewer runs crew's default; Codex
 * and Antigravity run their own pick, named `default` alike before and after the run so the gate and the spend meet.
 */
export function reviewerModel(provider: Provider, model: string | undefined): string {
  if (POOL[provider] === 'claude') return claudeModel(model ?? DEFAULT_MODEL)
  const m = model ?? 'default'
  if (provider === 'antigravity') return `agy ${m.replace(EFFORT_SUFFIX, '')}`
  return `${POOL[provider]} ${m}`
}

/** Who may be stopped from starting: a reviewer provider, or Claude's own agents. */
export type Gate = Provider | 'agents'

export const GATES: readonly Gate[] = ['codex', 'antigravity', 'claude', 'agents']

/** A session's limits: the settings with this session's raises on top; `isOn` false leaves only the gates. */
export type Limits = {
  isOn: boolean
  /** Tokens by model; a model not named here has `modelDefault`. */
  models: Readonly<Record<string, number>>
  modelDefault: number
  closed: readonly Gate[]
}

export const modelLimit = (limits: Limits, model: string): number => limits.models[model] ?? limits.modelDefault

/** Tokens by model the session spent, reviewers and Claude's agents together. */
export type Spent = Readonly<Record<string, number>>

const RAISE_WHERE = 'raise it in the crew tab (Limits) for this session, or in /config for every session'

function overModel(limits: Limits, spent: Spent, model: string): string | undefined {
  const used = spent[model] ?? 0
  const limit = modelLimit(limits, model)
  if (used < limit) return undefined
  return `${model} spent ${used} weighted tokens in this session, its limit is ${limit}: ${RAISE_WHERE}`
}

/** Why a review may not start, or undefined when it may; `models` are its reviewers' limit names. */
export function reviewRefusal(limits: Limits, spent: Spent, providers: readonly Provider[], models: readonly string[]): string | undefined {
  const closed = providers.filter(p => limits.closed.includes(p))
  if (closed.length > 0) return `${closed.join(', ')} reviewers are switched off for this session in the crew tab (Limits)`
  if (!limits.isOn) return undefined
  return models.map(m => overModel(limits, spent, m)).find(r => r !== undefined)
}

/** Why a follow-up may not be asked, or undefined: it adds tokens, not a run. */
export function followUpRefusal(limits: Limits, spent: Spent, provider: Provider, model: string): string | undefined {
  if (limits.closed.includes(provider)) return `${provider} reviewers are switched off for this session in the crew tab (Limits)`
  if (!limits.isOn) return undefined
  return overModel(limits, spent, model)
}

/** Why one of Claude's own agents may not start on `model` (a limit name), or undefined. */
export function agentRefusal(limits: Limits, spent: Spent, model: string): string | undefined {
  if (limits.closed.includes('agents')) return "Claude's agents are switched off for this session in the crew tab (Limits)"
  if (!limits.isOn) return undefined
  return overModel(limits, spent, model)
}
