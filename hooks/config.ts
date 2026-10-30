import type { AgentsTier } from 'cc-agents'
import type { PluginOptions } from 'claude-code'

import { isAbsolute, join, parentOf } from './paths.ts'

export type Settings = { rules: string[] }

export function settingsFrom(options: PluginOptions): Settings {
  return { rules: [...(options.reviewer_rules as readonly string[])] }
}

/** How one model runs a job; what it leaves out is the job's. */
export type ModelSpec = {
  /** The provider to run it on; absent, cc-agents places it by the job's `prefer`. */
  provider?: string
  effort?: string
  web?: boolean
  helpers?: boolean
  timeoutMin?: number
  pokeMin?: number
  stallMin?: number
}

/** One kind of work crew offers, as a tool of its name. Models are `<vendor>/<model>`, as cc-providers' offers serve them. */
export type JobSpec = {
  description: string
  /** The instructions every agent of the job gets: an absolute path. */
  prompt: string
  /** The cc-agents kind its agents run as. */
  kind: string
  /** The cc-agents profile its agents run as: what they may do. */
  profile: string
  /** The tiers its agents may run on, in the order to try them; a tier left out is never used. */
  prefer: AgentsTier[]
  web: boolean
  helpers: boolean
  /** Whether a call must name the paths its agents may read; without any they read nothing on disk. */
  paths: 'required' | 'optional'
  /** Whether a call may put a git diff in front of its agents. */
  diff: boolean
  timeoutMin: number
  /** How often an idle conversation hears how a running job goes. */
  pokeMin: number
  /** How long an agent may stay on one call, or silent, before it counts as stalled. */
  stallMin: number
  models: Record<string, ModelSpec>
  /** The models a call runs. */
  default: string[]
  /** `default` by the session's model key. */
  bySessionModel: Record<string, string[]>
}

export type CrewFile = { jobs: Record<string, JobSpec> }

/** A job as a crew file writes it; a machine's own file names only what it changes. */
export type JobEntry = Partial<JobSpec>

export type CrewEntries = { jobs: Record<string, JobEntry> }

/** The tools every job shares, which no job can be named. */
const TAKEN = ['jobs', 'report', 'stop']
const JOB_NAME = /^[a-z][a-z0-9_-]{0,63}$/
const FIELDS: readonly (keyof JobSpec)[] = ['description', 'prompt', 'kind', 'profile', 'prefer', 'web', 'helpers', 'paths', 'diff', 'timeoutMin', 'pokeMin', 'stallMin', 'models', 'default']

function fail(path: string, what: string): never {
  throw new Error(`crew: ${path}: ${what}`)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isMinutes = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

function modelOf(v: unknown, at: string, path: string): ModelSpec {
  if (!isObject(v)) fail(path, `${at} must be an object`)
  for (const k of ['provider', 'effort'] as const) if (v[k] !== undefined && typeof v[k] !== 'string') fail(path, `${at} has a ${k} that is no string`)
  for (const k of ['web', 'helpers'] as const) if (v[k] !== undefined && typeof v[k] !== 'boolean') fail(path, `${at} has a ${k} that is no boolean`)
  for (const k of ['timeoutMin', 'pokeMin', 'stallMin'] as const) if (v[k] !== undefined && !isMinutes(v[k])) fail(path, `${at} has a ${k} that is no positive number of minutes`)
  return v as ModelSpec
}

function entryOf(name: string, v: unknown, path: string): JobEntry {
  const at = `job ${name}`
  if (!JOB_NAME.test(name) || TAKEN.includes(name)) fail(path, `${at}: a job's name is its tool's, lower case, and none of ${TAKEN.join(', ')}`)
  if (!isObject(v)) fail(path, `${at} must be an object`)
  for (const k of ['description', 'prompt', 'kind', 'profile'] as const) if (v[k] !== undefined && (typeof v[k] !== 'string' || v[k] === '')) fail(path, `${at} has a ${k} that is no string`)
  if (v.prefer !== undefined && (!isList(v.prefer) || v.prefer.length === 0)) fail(path, `${at}: prefer must be a list of tiers, in the order to try them`)
  for (const k of ['web', 'helpers', 'diff'] as const) if (v[k] !== undefined && typeof v[k] !== 'boolean') fail(path, `${at} has a ${k} that is no boolean`)
  for (const k of ['timeoutMin', 'pokeMin', 'stallMin'] as const) if (v[k] !== undefined && !isMinutes(v[k])) fail(path, `${at} has a ${k} that is no positive number of minutes`)
  if (v.paths !== undefined && v.paths !== 'required' && v.paths !== 'optional') fail(path, `${at}: paths must be "required" or "optional"`)
  if (v.default !== undefined && !isList(v.default)) fail(path, `${at}: default must be a list of models`)
  if (v.bySessionModel !== undefined && (!isObject(v.bySessionModel) || !Object.values(v.bySessionModel).every(isList))) fail(path, `${at}: bySessionModel must map model keys to lists of models`)
  const models = v.models
  if (models !== undefined && !isObject(models)) fail(path, `${at}: models must be an object by model`)
  const { prompt, ...rest } = v
  return {
    ...(rest as JobEntry),
    ...(prompt === undefined ? {} : { prompt: isAbsolute(prompt as string) ? (prompt as string) : join(parentOf(path), prompt as string) }),
    ...(models === undefined ? {} : { models: Object.fromEntries(Object.entries(models).map(([m, spec]) => [m, modelOf(spec, `${at}'s model ${m}`, path)])) }),
  }
}

/** A crew file's jobs; a prompt it names by a relative path is found from the file's folder. */
export function parseCrewFile(text: string, path: string): CrewEntries {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(path, `not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isObject(parsed) || !isObject(parsed.jobs)) fail(path, 'must be an object with jobs, by name')
  return { jobs: Object.fromEntries(Object.entries(parsed.jobs).map(([name, v]) => [name, entryOf(name, v, path)])) }
}

function complete(name: string, e: JobEntry, where: string): JobSpec {
  const missing = FIELDS.filter(k => e[k] === undefined)
  if (missing.length > 0) fail(where, `job ${name} needs ${missing.join(', ')}`)
  const job = { bySessionModel: {}, ...e } as JobSpec
  const named = [...job.default, ...Object.values(job.bySessionModel).flat()]
  const unknown = named.filter(m => job.models[m] === undefined)
  if (unknown.length > 0) fail(where, `job ${name} runs ${[...new Set(unknown)].join(', ')}, none of its models (${Object.keys(job.models).join(', ')})`)
  if (job.default.length === 0) fail(where, `job ${name} needs a model in default`)
  return job
}

/** The shipped file with a machine's own over it: a job's fields replaced one by one, its models merged by model. */
export function mergeCrew(shipped: CrewEntries, own: CrewEntries | null, where: string): CrewFile {
  const names = [...new Set([...Object.keys(shipped.jobs), ...Object.keys(own?.jobs ?? {})])]
  return {
    jobs: Object.fromEntries(
      names.map(name => {
        const base = shipped.jobs[name]
        const mine = own?.jobs[name]
        const models = base?.models === undefined && mine?.models === undefined ? {} : { models: { ...base?.models, ...mine?.models } }
        return [name, complete(name, { ...base, ...mine, ...models }, where)]
      }),
    ),
  }
}

/** One model of a job as it runs: the model's settings over the job's. */
export type Effective = { serves: string; provider?: string; effort?: string; web: boolean; helpers: boolean; timeoutMs: number; pokeMs: number; stallMs: number }

const MINUTE = 60_000

/** `pokeMin`: what this session set in the tab, over the files. */
export function effective(job: JobSpec, serves: string, pokeMin: number | undefined): Effective {
  const m = job.models[serves]
  if (m === undefined) throw new Error(`crew: ${serves} is none of the job's models`)
  return {
    serves,
    ...(m.provider === undefined ? {} : { provider: m.provider }),
    ...(m.effort === undefined ? {} : { effort: m.effort }),
    web: m.web ?? job.web,
    helpers: m.helpers ?? job.helpers,
    timeoutMs: (m.timeoutMin ?? job.timeoutMin) * MINUTE,
    pokeMs: (pokeMin ?? m.pokeMin ?? job.pokeMin) * MINUTE,
    stallMs: (m.stallMin ?? job.stallMin) * MINUTE,
  }
}

/** What this session changed of a job in the tab. */
export type JobChoice = { ticked?: string[]; pokeMin?: Record<string, number> }

/** The models a call of the job runs in this session: ticked in the tab, else the session model's, else the default. */
export function modelsFor(job: JobSpec, sessionKey: string, choice: JobChoice | undefined): string[] {
  // a tick outlives a model taken out of the file, and the tab no longer shows it to untick
  return choice?.ticked?.filter(m => job.models[m] !== undefined) ?? job.bySessionModel[sessionKey] ?? job.default
}

/** What is wrong between a job and the mods under it. `isBlocking`: its tool can't run at all; else one of its models can't. */
export type JobProblem = { job: string; text: string; isBlocking: boolean }

export type CrewFacts = {
  kinds: readonly string[]
  profiles: readonly string[]
  missingPrompts: ReadonlySet<string>
}

/** A job's links to cc-agents and its own files; each of these stops its tool. What a model can run on is cc-providers' `checkModel`. */
export function checkJobs(jobs: Readonly<Record<string, JobSpec>>, facts: CrewFacts): JobProblem[] {
  return Object.entries(jobs).flatMap(([job, spec]) =>
    [
      ...(facts.kinds.includes(spec.kind) ? [] : [`it runs as kind ${spec.kind}, and cc-agents has ${facts.kinds.join(', ')}`]),
      ...(facts.profiles.includes(spec.profile) ? [] : [`it runs as profile ${spec.profile}, and cc-agents has ${facts.profiles.join(', ')}`]),
      ...(facts.missingPrompts.has(spec.prompt) ? [`its prompt ${spec.prompt} does not exist`] : []),
    ].map(text => ({ job, text, isBlocking: true })),
  )
}
