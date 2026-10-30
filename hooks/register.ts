import type { EngineInterface, Register } from 'claude-code'
import type { SidebarDrawerSlot, SidebarModalSlot, SidebarRowComponent } from 'cc-sidebar'
import type { BusPersonAnswered } from 'cc-bus'
import type { AgentsSubagent, AgentsTier } from 'cc-agents'
import type { Providers, ProvidersGroup, ProvidersInfo, ProvidersLimitReached, ProvidersLimits } from 'cc-providers'

import type { ChangeSpec } from './changes.ts'
import { checkJobs, type CrewFile, type Effective, effective, type JobProblem, type JobSpec, mergeCrew, modelsFor, parseCrewFile, settingsFrom } from './config.ts'
import { detailProps } from './detail.ts'
import type { Io } from './io.ts'
import { type Alert, type AgentsPort, type Job, type Jobs, makeJobs, type ProvidersPort, Refused } from './jobs.ts'
import { OVERVIEW_COLUMNS, overviewLines } from './overview.ts'
import type { Role, Tab, Target } from './overview-props.ts'
import { join } from './paths.ts'
import { systemPrompt, toolDescription } from './prompt.ts'
import { gaugeColumns, type QuotaView } from './quota.ts'
import { emptyRecord, loadRecord, recordPath, saveRecord, type SessionRecord } from './record.ts'
import { fillSlot, hasSlot } from './slot.ts'
import { type Spend, usd } from './usage.ts'
import { type Badge, type Pools, RAISES_USD, agentDetail, badgeOf, itemsOf, jobDetail, overviewProps, usageDetail, usageKeys } from './views.ts'

const PREFIX = 'mcp__cc-crew__'

/** Ends a refusal the calling agent can do nothing about. */
const FOR_THE_PERSON = 'The call was fine: this is how crew is set up, so tell the person. Retrying will not help.'
const JOB_ID = 'The id its start or `jobs` gave, <job>-<n>; from an earlier session, <session>/<job>-<n>'

function jobSchema(spec: JobSpec) {
  const diff = {
    description: 'A git diff to put in front of every agent, from the repository of the first path: "uncommitted", { "base": "<branch>" } or { "commit": "<sha>" }',
    anyOf: [
      { type: 'string', enum: ['uncommitted'] },
      { type: 'object', properties: { base: { type: 'string' } }, required: ['base'], additionalProperties: false },
      { type: 'object', properties: { commit: { type: 'string' } }, required: ['commit'], additionalProperties: false },
    ],
  }
  const paths = { type: 'array', items: { type: 'string' }, description: `What its agents may read, absolute or relative to the project; "." is the project${spec.paths === 'optional' ? '. Without it they read nothing on disk' : ''}` }
  return {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'The self-contained brief' }, paths, ...(spec.diff ? { diff } : {}) },
    required: ['prompt', ...(spec.paths === 'required' ? ['paths'] : [])],
    additionalProperties: false,
  }
}

const JOBS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false }

const REPORT_SCHEMA_INPUT = {
  type: 'object',
  properties: {
    id: { type: 'string', description: JOB_ID },
    scope: { type: 'string', description: 'Read this scope alone' },
    findings_only: { type: 'boolean', description: 'Read only the findings and their references' },
  },
  required: ['id'],
  additionalProperties: false,
}

const STOP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: JOB_ID },
    agent: { type: 'string', description: 'The letter of one agent; every running agent of it when left out' },
  },
  required: ['id'],
  additionalProperties: false,
}

let rules: { path: string; text: string }[] = []
/** The jobs, read at session start; none while `broken`. */
let crew: CrewFile = { jobs: {} }
/** Why crew has no jobs: its files are wrong or it did not finish starting. `jobs` says so and the tab shows it. */
let broken: string | null = null
/** What the last check of the jobs against cc-agents and cc-providers found. */
let problems: JobProblem[] = []
/** The problems the person was told of, so each is told once. */
const toldProblems = new Set<string>()
const shownFailures = new Set<string>()
let cacheDir = ''
/** What one press moves a poke by, in minutes. */
const MINUTES_STEP = 5
/** How often running agents are read for signs of life. */
const LIVENESS_MS = 60_000

const TAB_ID = 'crew'
const DRAWER_SLOT: SidebarDrawerSlot = `sidebar-drawer:${TAB_ID}`
const MODAL_SLOT: SidebarModalSlot = `sidebar-modal:${TAB_ID}`
const OVERVIEW_KEY = 'crew-overview'
const DETAIL_KEY = 'crew-detail'
/** The sidebar's drawer frame: a border and a padding column on each side. */
const DRAWER_FRAME_COLUMNS = 4
const ROW_COMPONENTS = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'TurnDuration',
  'InfoNotice',
] as const satisfies readonly SidebarRowComponent[]
/** After the vault's tab. */
const TOOL = { id: TAB_ID, icon: '👥', short: 'crew', drawerColumns: OVERVIEW_COLUMNS + DRAWER_FRAME_COLUMNS, order: 2 }
/** How often the open drawer redraws, for its clocks, and the limits are read again. */
const TICK_MS = 1000
/** How often the quota, the providers and their pools are read again: providers reads a provider's quota every 5 minutes. */
const QUOTA_MS = 30_000

/** The session crew draws and records, moved by `follow`. */
let sessionId = ''
/** Made at the first session start of this load: jobs running across a `/clear` still end into it. */
let jobs: Jobs | null = null
/** What cc-agents last said of the session's subagents, read each tick for the badge and the draws. */
let subagents: AgentsSubagent[] = []
/** What the modal shows: a job or agent with its brief or prompt as read when it was opened, or a pool or model worked out on each draw; the page it is at. */
let detail: { target: Target; text: string; page: number } | null = null
let ticker: { cancel(): void } | null = null
let quotaTicker: { cancel(): void } | null = null
let livenessTicker: { cancel(): void } | null = null
let record: SessionRecord = emptyRecord()
let view: { tab: Tab; page: number } = { tab: 'running', page: 0 }
/** Set at session start and read again with the quota. */
let providersInfo: ProvidersInfo[] = []
let catalog: Awaited<ReturnType<Providers['catalog']>>['providers'] = []
let groups: ProvidersGroup[] = []
/** The pools read so far, by model key; they go with the catalog, as a live catalog can place a model anew. */
const pools = new Map<string, { pool: string | null; isPlaced: boolean }>()
let quotaViews: QuotaView[] = []
/** Why the last quota read failed, shown on the Quota tab. */
let quotaError: string | null = null
/** The provider the session runs on; its subagents' models are keyed under it. */
let sessionProvider = ''
/** Set at session start and read again every tick. */
let limits: ProvidersLimits | null = null
type Ask = { session: string; key: string; pool: string }
/** The person's ask about a paused pool, open until answered, the pause ends or the session moves on. */
let openAsk: Ask | null = null
/** Puts up one ask at a time, so the ask a newer one replaces is always cancelled. */
let asking: Promise<unknown> = Promise.resolve()
let following: Promise<void> = Promise.resolve()

function liveJobs(): Jobs {
  if (jobs === null) throw new Error('crew: jobs are used before session start')
  return jobs
}

function liveLimits(): ProvidersLimits {
  if (limits === null) throw new Error('crew: limits are used before session start')
  return limits
}

const sessionViews = () => liveJobs().sessionJobs(sessionId).map(j => liveJobs().viewOf(j))
const headless = () => catalog.filter(p => p.isHeadless)
/** The tab's switches: each provider that runs headless, and Claude's own agents. */
const gates = () => [...headless().map(p => p.id), 'agents']
/** A failure's text as the person or the agent reads it, under one `crew:`. */
function reason(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^crew: /, '')
}

/** The session's own model as cc-providers keys it; a job's list can depend on it. */
const sessionKey = async ($: EngineInterface) => $.providers.modelKey({ provider: sessionProvider, model: await $.session.model() })

async function keep($: EngineInterface): Promise<void> {
  await saveRecord(ioOf($), recordPath(cacheDir, sessionId), record)
}

/** The pools of `keys`, reading those not read yet; a draw of known models calls nobody. */
async function poolsOf($: EngineInterface, keys: readonly string[]): Promise<Pools> {
  const unread = [...new Set(keys)].filter(key => !pools.has(key))
  await Promise.all(unread.map(async key => void pools.set(key, await $.providers.poolOf({ key: key as `${string}/${string}` }))))
  return pools
}

/** The pop-out's title and text for what it shows, from the job's, agent's or model's state now; null once it is gone. */
function shownDetail(shown: NonNullable<typeof detail>, now: number, read: Pools, spend: Spend): { title: string; text: string } | null {
  const target = shown.target
  if ('group' in target || 'model' in target) {
    const items = itemsOf(read, sessionViews(), subagents)
    const title = 'model' in target ? target.model : (groups.find(g => g.id === target.group)?.name ?? target.group)
    return { title, text: usageDetail(read, items, liveLimits(), target, now, spend) }
  }
  if ('run' in target) {
    const job = liveJobs().sessionJobs(sessionId).find(j => j.id === target.run)
    return job === undefined ? null : { title: `${job.id}: ${job.title}`, text: jobDetail(liveJobs().viewOf(job), shown.text, spend) }
  }
  const id = target.agent
  const agent = subagents.find(a => a.id === id)
  return agent === undefined ? null : { title: `${agent.type}: ${agent.description}`, text: agentDetail(agent, shown.text, now, spend) }
}

/** Opens the details in the modal, or closes them when they are what it shows. */
async function open($: EngineInterface, target: Target): Promise<void> {
  if (detail !== null && JSON.stringify(detail.target) === JSON.stringify(target)) {
    detail = null
    await $.sidebar.modal({ id: TAB_ID, isShown: false })
    return
  }
  if ('group' in target || 'model' in target) {
    detail = { target, text: '', page: 0 }
    await $.sidebar.modal({ id: TAB_ID, isShown: true })
    return
  }
  let text: string
  if ('run' in target) {
    const job = liveJobs().sessionJobs(sessionId).find(j => j.id === target.run)
    if (job === undefined) throw new Error(`crew: no job ${target.run} in this session to open`)
    text = await $.fs.read(join(job.dir, 'brief.md'))
  } else {
    text = (await $.agents.prompt({ session: sessionId, id: target.agent })).text ?? '(not kept: cc-agents did not see this agent start)'
  }
  detail = { target, text, page: 0 }
  await $.sidebar.modal({ id: TAB_ID, isShown: true })
}

/**
 * The badge last set, so the tick sets it only on a change: each set rewrites the rail's state. Null until this load
 * set one: the rail still shows what an earlier load set.
 */
let badge: Badge | null = null

async function syncBadge($: EngineInterface): Promise<void> {
  const next = badgeOf(sessionViews(), subagents, liveLimits())
  if (badge !== null && next.count === badge.count && next.level === badge.level) return
  badge = next
  await $.sidebar.badge({ id: TAB_ID, ...next })
}

/**
 * The holds cc-agents has, as the limits say: a pool the conversation is past, unless limits are off. Runs on a change
 * and once a load, so a reload of crew and a raise need nothing else. While anything is held it runs every time: holds
 * live in cc-agents' memory, which may have reloaded alone, and each is the same call again.
 */
let heldPools: string | null = null

async function syncHolds($: EngineInterface): Promise<void> {
  const { isOn, pools: all } = liveLimits()
  const reached = isOn ? all.filter(p => p.reachedAt !== null) : []
  const shown = `${sessionId}:${reached.map(p => p.pool).join()}`
  if (shown === heldPools && reached.length === 0) return
  const session = sessionId
  await Promise.all(all.map(p => (reached.includes(p) ? $.agents.hold({ session, pool: p.pool, notice: holdNotice(p.name) }) : $.agents.release({ session, pool: p.pool }))))
  heldPools = shown
}

/** What cc-agents adds up for a session; crew requires it, so no answer is a failure. */
async function spendOf($: EngineInterface, session: string): Promise<Spend> {
  const said = (await $.bus.ask({ topic: 'spend', session })).answers.find(a => a.by === 'cc-agents')
  if (said === undefined) throw new Error('crew: cc-agents did not answer the bus topic spend, so the tab has no totals')
  return said
}

/** Reads the session's record, agents, jobs and limits; they replace what crew held only once all are read. */
async function enter($: EngineInterface, id: string): Promise<void> {
  const entered = await loadRecord(ioOf($), recordPath(cacheDir, id))
  await liveJobs().restore(ioOf($), agentsOf($), alertOf($), id)
  const read = await $.providers.limits({ session: id })
  const seen = await $.agents.subagents({ session: id })
  record = entered
  limits = read
  subagents = seen
  sessionId = id
  await syncHolds($)
  await syncBadge($)
  for (const job of liveJobs().sessionJobs(id)) announceWork($, job)
}

/**
 * Moves crew onto the session the engine runs now: a `/clear` or a resume goes on under a new id without a session
 * start. A failed entry rejects its caller, and the next call tries again.
 */
function follow($: EngineInterface): Promise<void> {
  const step = following.then(async () => {
    const id = await $.session.id()
    if (id !== sessionId) await enter($, id)
  })
  following = step.catch(() => undefined)
  return step
}

async function tick($: EngineInterface): Promise<void> {
  await follow($)
  subagents = await $.agents.subagents({ session: sessionId })
  limits = await $.providers.limits({ session: sessionId })
  await syncHolds($)
  if (openAsk !== null && openAsk.session !== sessionId) await closeAsk($, 'That conversation ended: a /clear or a resume started another.')
  if (openAsk !== null && !limits.pools.some(p => p.pool === openAsk?.pool && p.reachedAt !== null)) {
    await closeAsk($, 'The pause ended: its limit was raised or the limits were switched off.')
  }
  await syncBadge($)
  if ((await $.sidebar.selected({})) !== TAB_ID) return
  $.ui.invalidate('ui.render')
}

/**
 * Reads how the running agents are doing, for the tab and `jobs`. The idle conversation hears of an agent stalled or
 * ended badly, and of a job past its poke; a busy one hears when its turn ends and the next read finds it idle.
 */
async function watchJobs($: EngineInterface): Promise<void> {
  await follow($)
  if (jobs === null) return
  const all = liveJobs()
  const now = await $.clock.now()
  await all.read(agentsOf($), sessionId)
  for (const job of all.sessionJobs(sessionId)) announceWork($, job)
  if (!(await $.agents.isIdle()).isIdle) return
  for (const job of all.sessionJobs(sessionId)) {
    const text = all.poke(job, now)
    if (text !== undefined) await $.conversation.deliver({ from: 'crew', text })
  }
}

/** Checks the jobs against what cc-agents and cc-providers have now, telling the person once of what is new. */
async function checkCrew($: EngineInterface): Promise<void> {
  const specs = Object.values(crew.jobs)
  const missing = await Promise.all(specs.map(async s => ((await $.fs.exists(s.prompt)) ? [] : [s.prompt])))
  const models = await Promise.all(
    Object.entries(crew.jobs).flatMap(([job, spec]) =>
      Object.entries(spec.models).map(async ([serves, m]): Promise<JobProblem[]> => {
        const { problem } = await $.providers.checkModel({ serves, ...(m.provider === undefined ? {} : { provider: m.provider }), ...(m.effort === undefined ? {} : { effort: m.effort }) })
        return problem === null ? [] : [{ job, text: problem, isBlocking: false }]
      }),
    ),
  )
  problems = [...checkJobs(crew.jobs, { kinds: Object.keys(await $.agents.kinds()), profiles: Object.keys(await $.agents.profiles()), missingPrompts: new Set(missing.flat()) }), ...models.flat()]
  const fresh = problems.map(problemText).filter(text => !toldProblems.has(text))
  if (fresh.length === 0) return
  for (const text of fresh) toldProblems.add(text)
  await notice($, `crew's jobs need fixing in crew.json: ${fresh.join('; ')}`)
}

const problemText = (p: JobProblem) => `${p.job}: ${p.text}`

/** Reads the providers, their pools and their quota again, and draws the gauge. */
async function readQuota($: EngineInterface): Promise<void> {
  try {
    providersInfo = await $.providers.list()
    ;({ providers: catalog, groups } = await $.providers.catalog())
    pools.clear()
    quotaViews = await Promise.all(providersInfo.map(async info => ({ info, slots: await $.providers.quota({ provider: info.id, session: sessionId }) })))
    quotaError = null
  } catch (err) {
    quotaError = `quota not read: ${err instanceof Error ? err.message : String(err)}`
  }
  const columns = gaugeColumns(quotaViews, await $.clock.now())
  await $.sidebar.gauge({ id: TAB_ID, columns: columns.length === 0 ? null : columns })
  $.ui.invalidate('ui.render')
}

type Fields = Record<string, unknown>

class BadInput extends Error {}

function str(f: Fields, key: string): string {
  const v = f[key]
  if (typeof v !== 'string' || v.trim() === '') throw new BadInput(`${key} must be a non-empty string`)
  return v
}

/** A call's fields other than these are refused, saying what it takes. */
function only(f: Fields, name: string, takes: readonly string[], hint = ''): void {
  const extra = Object.keys(f).filter(k => !takes.includes(k))
  if (extra.length > 0) throw new BadInput(`${name} takes ${takes.length === 0 ? 'nothing' : takes.join(', ')}, not ${extra.join(', ')}${hint}`)
}

/** What its agents may read, from the call. */
function readOf(f: Fields, name: string, spec: JobSpec): 'none' | string[] {
  const v = f.paths
  if (v === undefined) {
    if (spec.paths === 'required') throw new BadInput(`${name} needs paths: what its agents may read, "." for the project`)
    return 'none'
  }
  if (Array.isArray(v) && v.length > 0 && v.every(p => typeof p === 'string' && p !== '')) return v as string[]
  throw new BadInput('paths must be a non-empty list of paths, such as ["."]')
}

function diffOf(f: Fields): ChangeSpec | undefined {
  const v = f.diff
  if (v === undefined) return undefined
  if (v === 'uncommitted') return v
  if (typeof v === 'object' && v !== null) {
    const o = v as Fields
    if (typeof o.base === 'string') return { base: o.base }
    if (typeof o.commit === 'string') return { commit: o.commit }
  }
  throw new BadInput('diff must be "uncommitted", { base } or { commit }')
}

/** The models cc-agents can place now, and why it can't the rest. */
async function placeable($: EngineInterface, prefer: readonly AgentsTier[], settings: readonly Effective[]): Promise<{ models: Effective[]; skipped: { serves: string; why: string }[] }> {
  const models: Effective[] = []
  const skipped: { serves: string; why: string }[] = []
  for (const s of settings) {
    const { why } = await $.agents.placeable({ session: sessionId, serves: s.serves, prefer, ...(s.provider === undefined ? {} : { provider: s.provider }), ...(s.effort === undefined ? {} : { effort: s.effort }) })
    if (why === null) models.push(s)
    else skipped.push({ serves: s.serves, why })
  }
  return { models, skipped }
}

function ioOf($: EngineInterface): Io {
  return {
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
  }
}

function agentsOf($: EngineInterface): AgentsPort {
  return {
    start: input => $.agents.start(input),
    followUp: input => $.agents.followUp(input),
    stop: input => $.agents.stop(input),
    health: input => $.agents.health(input),
    get: input => $.agents.get(input),
    list: input => $.agents.list(input),
    outcome: input => $.agents.outcome(input),
  }
}

function providersOf($: EngineInterface): ProvidersPort {
  return {
    roots: input => $.providers.roots(input),
    secretPaths: input => $.providers.secretPaths(input),
  }
}

function alertOf($: EngineInterface): Alert {
  return async (provider, detail) => {
    try {
      await $.conversation.tell({ text: `crew: ${provider}: ${detail}`, group: 'attention' })
      return undefined
    } catch (err) {
      return String(err)
    }
  }
}

/** Starts the job a tool of its name was called for, answering its id; the end arrives as a message. */
async function startJob($: EngineInterface, name: string, spec: JobSpec, f: Fields): Promise<string> {
  await follow($)
  only(f, name, ['prompt', 'paths', ...(spec.diff ? ['diff'] : [])], '; which models run it and how is set in the crew tab and crew.json')
  const brief = str(f, 'prompt')
  const read = readOf(f, name, spec)
  const diff = diffOf(f)
  const kinds = await $.agents.kinds()
  if (kinds[spec.kind] === undefined) throw new Refused(`${name} runs as kind ${spec.kind}, which cc-agents does not have (${Object.keys(kinds).join(', ')}). ${FOR_THE_PERSON}`)
  const profiles = await $.agents.profiles()
  if (profiles[spec.profile] === undefined) throw new Refused(`${name} runs as profile ${spec.profile}, which cc-agents does not have (${Object.keys(profiles).join(', ')}). ${FOR_THE_PERSON}`)
  if (!(await $.fs.exists(spec.prompt))) throw new Refused(`${name}'s prompt ${spec.prompt} does not exist. ${FOR_THE_PERSON}`)
  const choice = record.jobs[name]
  const models = modelsFor(spec, await sessionKey($), choice)
  if (models.length === 0) throw new Refused(`no model is ticked for ${name} in the crew tab. ${FOR_THE_PERSON}`)
  const placed = await placeable($, spec.prefer, models.map(m => effective(spec, m, choice?.pokeMin?.[m])))
  const { skipped } = placed
  if (placed.models.length === 0) throw new Refused(`no model can run ${name} now: ${skipped.map(s => `${s.serves}: ${s.why}`).join('; ')}. ${FOR_THE_PERSON}`)
  const all = liveJobs()
  const job = await all.begin(ioOf($), agentsOf($), providersOf($), {
    session: sessionId,
    job: name,
    brief,
    models: placed.models,
    skipped,
    kind: spec.kind,
    profile: spec.profile,
    prefer: spec.prefer,
    read,
    project: await $.session.root(),
    ...(diff === undefined ? {} : { diff }),
    system: systemPrompt(await $.fs.read(spec.prompt), rules),
  })
  for (const s of skipped) await alertOf($)(s.serves, `${job.id} runs without it: ${s.why}`)
  // a /clear during its start leaves the caller in another session than the job's
  const here = await $.session.id()
  if (all.isDone(job)) {
    await all.announce(ioOf($), job, here, async () => undefined)
    return all.summary(ioOf($), job, here)
  }
  const ref = all.refOf(job, here)
  return `Started ${ref} with ${job.agents.length} agent${job.agents.length === 1 ? '' : 's'}. A message says when it finished; read it with report { id: "${ref}" }.`
}

/** The running jobs and the finished ones not read in full yet. */
async function listJobs($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'jobs', [])
  const all = liveJobs()
  const now = await $.clock.now()
  const shown = all.sessionJobs(sessionId).filter(j => !all.isDone(j) || !j.isAcked)
  const lines = await Promise.all(shown.map(j => all.line(ioOf($), j, now)))
  if (broken !== null) return [`Crew has no jobs: ${broken} ${FOR_THE_PERSON}`, ...lines].join('\n')
  return lines.length === 0 ? 'Nothing runs and nothing is unread.' : lines.join('\n')
}

async function readReport($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'report', ['id', 'scope', 'findings_only'])
  if (f.findings_only !== undefined && typeof f.findings_only !== 'boolean') throw new BadInput('findings_only must be true or false')
  return liveJobs().report(ioOf($), agentsOf($), sessionId, str(f, 'id'), {
    ...(f.scope === undefined ? {} : { scope: str(f, 'scope') }),
    ...(f.findings_only === true ? { findingsOnly: true } : {}),
  })
}

async function stopJob($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'stop', ['id', 'agent'])
  const label = f.agent === undefined ? undefined : str(f, 'agent')
  const { stopping, unreachable } = await liveJobs().stop(ioOf($), agentsOf($), sessionId, str(f, 'id'), label)
  const stopped = stopping === 0 ? [] : [`Stopping ${stopping} agent${stopping === 1 ? '' : 's'}; the report keeps what the others find.`]
  const out = unreachable === 0 ? [] : [`${unreachable} agent${unreachable === 1 ? ' reads' : 's read'} as running with nothing here to stop: it runs in another session, or its end is on its way.`]
  return [...stopped, ...out].join(' ') || 'Nothing of it was running.'
}

/** The tool's work, or undefined for a tool that is none of crew's. */
function toolWork($: EngineInterface, tool: string, f: Fields): Promise<string> | undefined {
  if (!tool.startsWith(PREFIX)) return undefined
  const name = tool.slice(PREFIX.length)
  // where the engine puts arguments that were not JSON; left to `only`, a model resends them unchanged
  const unparsed = f.__unparsedToolInput as { raw?: unknown } | undefined
  if (unparsed !== undefined) return Promise.reject(new BadInput(`your arguments were not valid JSON: ${String(unparsed.raw)}. Send one JSON object with every string in double quotes, such as { "prompt": "Look at X.", "paths": ["src"] }`))
  if (name === 'jobs') return listJobs($, f)
  if (name === 'report') return readReport($, f)
  if (name === 'stop') return stopJob($, f)
  const spec = crew.jobs[name]
  if (spec !== undefined) return startJob($, name, spec, f)
  return broken === null ? undefined : Promise.reject(new Refused(`${broken} ${FOR_THE_PERSON}`))
}

function fields(e: unknown): Fields {
  return e as Fields
}

function answer(work: Promise<string>) {
  return work.then(
    text => ({ result: text }),
    (err: unknown) => ({ deny: `crew: ${reason(err)}` }),
  )
}

/** Ticks or unticks a job's model for this session, from the list it runs now. */
async function tickModel($: EngineInterface, name: string, model: string): Promise<void> {
  const spec = crew.jobs[name]
  if (spec?.models[model] === undefined) return
  const now = modelsFor(spec, await sessionKey($), record.jobs[name])
  const ticked = now.includes(model) ? now.filter(m => m !== model) : [...now, model]
  record.jobs[name] = { ...record.jobs[name], ticked }
  await keep($)
}

/** Moves a model's poke for this session, keeping it at one step or more. */
async function movePoke($: EngineInterface, name: string, model: string, by: number): Promise<void> {
  const spec = crew.jobs[name]
  if (spec?.models[model] === undefined || Math.abs(by) !== MINUTES_STEP) return
  const set = record.jobs[name]?.pokeMin
  const was = set?.[model] ?? effective(spec, model, undefined).pokeMs / 60_000
  record.jobs[name] = { ...record.jobs[name], pokeMin: { ...set, [model]: Math.max(MINUTES_STEP, was + by) } }
  await keep($)
}

const KEEP_PAUSED = 'Keep paused'
const LABELS = [...RAISES_USD.map(n => `+$${n}`), KEEP_PAUSED]
const ASK_PREFIX = 'crew-limit:'

/** The session and pool a pause ask's key names, so an answer after a reload is still acted on. */
function askOf(key: string): Ask {
  const [session, pool] = key.slice(ASK_PREFIX.length).split(':')
  if (session === undefined || pool === undefined) throw new Error(`crew: the ask key ${key} names no session and pool`)
  return { session, key, pool }
}

type Pause = { name: string; spentUsd: number; limitUsd: number }

const pauseText = (p: Pause) =>
  `Paused: this conversation spent ${usd(p.spentUsd)} in the ${p.name} pool at API prices, past its limit of ${usd(p.limitUsd)}. It goes on in turns you start; a raise lets it go on by itself.`

/** What the held conversation answers its own steps with. */
const holdNotice = (name: string) => `crew: paused. This conversation went past its limit in the ${name} pool; it goes on in turns you start or type into, and on its own again once its limit is raised.`

/** Where nobody carries the ask to the person: the terminal, and the thread for whoever carries notices there. */
async function notice($: EngineInterface, text: string): Promise<void> {
  await $.ui.toast(`crew: ${text}`)
  await $.conversation.tell({ text: `crew: ${text}`, group: 'attention' })
}

async function closeAsk($: EngineInterface, reason: string): Promise<void> {
  if (openAsk === null) return
  const ask = openAsk
  openAsk = null
  await $.bus.tell({ topic: 'person.close', key: ask.key, reason })
}

/**
 * Asks the person away from the terminal whether to let the paused conversation go on; their answer comes as
 * `person.answered`. Nobody carrying it, the terminal and the thread get a notice instead.
 */
async function askRaise($: EngineInterface, session: string, reached: Pick<ProvidersLimitReached, 'pool' | 'name' | 'spentUsd' | 'limitUsd' | 'at'>): Promise<void> {
  const text = pauseText(reached)
  const ask: Ask = { session, key: `${ASK_PREFIX}${session}:${reached.pool}:${reached.at}`, pool: reached.pool }
  const put = asking.then(async () => {
    await closeAsk($, 'Replaced by a newer ask.')
    const { answers } = await $.bus.ask({ topic: 'person.ask', key: ask.key, questions: [{ id: 'action', text, options: LABELS.map(label => ({ label })) }] })
    const isCarried = answers.some(a => a.topic === 'person.ask' && a.key === ask.key)
    if (isCarried) openAsk = ask
    return isCarried
  })
  // its failure is this caller's; the next ask still goes up
  asking = put.catch(() => undefined)
  if (!(await put)) await notice($, text)
}

/**
 * Raises the limit by what the person pressed, and asks again while the raise leaves the conversation paused; one
 * they never saw becomes a notice.
 */
async function answered($: EngineInterface, e: BusPersonAnswered): Promise<void> {
  if (openAsk?.key === e.key) openAsk = null
  const ask = askOf(e.key)
  const paused = (await $.providers.limits({ session: ask.session })).pools.find(p => p.pool === ask.pool && p.reachedAt !== null)
  if (!('answers' in e)) {
    if (!e.wasShown && paused !== undefined && paused.main.limitUsd !== null) await notice($, pauseText({ ...paused, spentUsd: paused.main.spentUsd, limitUsd: paused.main.limitUsd }))
    return
  }
  const picked = e.answers['action']?.selected[0]
  if (picked === undefined || !LABELS.includes(picked)) throw new Error(`the answer ${JSON.stringify(picked)} is none of ${LABELS.join(', ')}`)
  // a raise in the tab can land before the press does
  if (picked === KEEP_PAUSED || paused === undefined) return
  const raised = await $.providers.raise({ session: ask.session, pool: ask.pool, role: 'main', usd: Number(picked.slice(2)) })
  if (ask.session === sessionId) {
    limits = raised
    await syncHolds($)
    await syncBadge($)
  }
  const pool = raised.pools.find(p => p.pool === ask.pool)
  if (pool?.reachedAt === null || pool === undefined || pool.main.limitUsd === null) return
  await askRaise($, ask.session, { pool: ask.pool, name: pool.name, spentUsd: pool.main.spentUsd, limitUsd: pool.main.limitUsd, at: await $.clock.now() })
}

/** Runs the pause work in the background, past a noun call's 10 s; a failure is shown, not swallowed. */
function pauseWork($: EngineInterface, what: string, work: () => Promise<void>): void {
  $.clock.after(0, () =>
    void work().catch(async (err: unknown) => {
      const why = `crew: ${what} failed: ${err instanceof Error ? err.message : String(err)}`
      $.ui.log(why, { to: 'debug' })
      await $.ui.toast(why)
    }),
  )
}

/** Tells the conversation of a job that finished and was not told yet, past a noun call's 10 s; the liveness tick retries one that failed. */
function announceWork($: EngineInterface, job: Job): void {
  if (!liveJobs().needsTelling(job)) return
  $.clock.after(0, () =>
    void liveJobs()
      .announce(ioOf($), job, sessionId, text => $.conversation.deliver({ from: 'crew', text }))
      .catch(async (err: unknown) => showOnce($, `crew: telling the end of ${job.id} failed: ${reason(err)}`)),
  )
}

/** The jobs and the person's rules from the files, the machine's own over the shipped ones. */
async function readCrew($: EngineInterface, home: string, ruleFiles: readonly string[]): Promise<CrewFile> {
  rules = await Promise.all(ruleFiles.map(async path => ({ path, text: await $.fs.read(path) })))
  const shippedPath = join($.plugin.root, 'crew.json')
  const ownPath = join(join(join(home, '.config'), 'crew'), 'crew.json')
  const own = (await $.fs.exists(ownPath)) ? parseCrewFile(await $.fs.read(ownPath), ownPath) : null
  return mergeCrew(parseCrewFile(await $.fs.read(shippedPath), shippedPath), own, own === null ? shippedPath : `${shippedPath} with ${ownPath} over it`)
}

async function startCrew($: EngineInterface, ruleFiles: readonly string[]): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('crew: HOME is not set, so its cache folder is unknown')
  cacheDir = join(join(home, '.cache'), 'crew')
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  jobs ??= makeJobs(join(configDir !== undefined && configDir !== '' ? configDir : join(home, '.claude'), 'crew'))
  await $.tool.register({ name: 'jobs', description: "List what crew runs now and what finished unread, with how each agent is doing. A finish reaches you as a message, so call this when you need a job's standing or id.", inputSchema: JOBS_SCHEMA, isDeferred: false })
  await $.tool.register({
    name: 'report',
    description: 'Read what a crew job found, grouped by scope, the system a finding is about. Only the whole report marks the job read and takes it off `jobs`; `scope` reads one scope and `findings_only` the findings and their references.',
    inputSchema: REPORT_SCHEMA_INPUT,
    isDeferred: false,
  })
  await $.tool.register({ name: 'stop', description: 'Give up on a running crew job or one agent of it. What the others find is kept.', inputSchema: STOP_SCHEMA, isDeferred: false })
  try {
    crew = await readCrew($, home, ruleFiles)
    broken = null
  } catch (err) {
    crew = { jobs: {} }
    broken = reason(err)
    await notice($, `crew has no jobs: ${broken}`)
  }
  providersInfo = await $.providers.list()
  ;({ providers: catalog, groups } = await $.providers.catalog())
  sessionProvider = (await $.providers.sessionProvider()).provider
  const profiles = await $.agents.profiles()
  for (const [name, spec] of Object.entries(crew.jobs)) {
    await $.tool.register({ name, description: toolDescription(spec.description, profiles[spec.profile]?.write), inputSchema: jobSchema(spec), isDeferred: false })
  }
  await $.sidebar.register(TOOL)
  await follow($)
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => void tick($))
  quotaTicker?.cancel()
  // not on the first read: providers' live catalogs join just after it starts, and a model only they offer would read as missing
  quotaTicker = $.clock.every(QUOTA_MS, () => void readQuota($).then(() => checkCrew($)).catch(async (err: unknown) => showOnce($, `crew: checking its jobs failed: ${reason(err)}`)))
  livenessTicker?.cancel()
  livenessTicker = $.clock.every(LIVENESS_MS, () => void watchJobs($).catch(async (err: unknown) => showOnce($, `crew: reading how its agents do failed: ${reason(err)}`)))
  $.clock.after(0, () => void readQuota($))
}

/** The ticks repeat, so a failure that stays is shown to the person once. */
async function showOnce($: EngineInterface, why: string): Promise<void> {
  $.ui.log(why, { to: 'debug' })
  if (shownFailures.has(why)) return
  shownFailures.add(why)
  await $.ui.toast(why)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // cc-providers and cc-agents, which crew lists as dependencies, start inside next(e)
    const started = await next(e)
    try {
      await startCrew($, settingsFrom(options).rules)
    } catch (err) {
      broken = `crew did not start: ${reason(err)}`
      await notice($, broken)
    }
    return started
  })

  on('agents.changed', async ($, e, next) => {
    jobs?.changed(e.run)
    return next(e)
  })

  on('agents.ended', async ($, e, next) => {
    const ended = await next(e)
    const job = jobs === null ? undefined : await jobs.ended(ioOf($), alertOf($), e.run, e.outcome)
    if (job !== undefined) {
      await syncBadge($)
      $.ui.invalidate('ui.render')
      announceWork($, job)
    }
    return ended
  })

  on('providers.limitReached', async ($, e, next) => {
    const reached = await next(e)
    await follow($)
    if (e.session === sessionId) {
      limits = await $.providers.limits({ session: sessionId })
      await syncHolds($)
      await syncBadge($)
      pauseWork($, `asking about the pause in ${e.name}`, () => askRaise($, e.session, e))
    }
    return reached
  })

  on('bus.tell', { topic: 'person.answered' }, async ($, e, next) => {
    if (e.key.startsWith(ASK_PREFIX)) pauseWork($, 'acting on the answer about a pause', () => answered($, e))
    return next(e)
  })

  on('ui.message', { element: OVERVIEW_KEY }, async ($, e, next) => {
    const data = e.data as {
      tab?: unknown
      page?: unknown
      raise?: { pool?: unknown; role?: unknown; usd?: unknown }
      toggle?: unknown
      switchLimits?: unknown
      stop?: { run?: unknown; key?: unknown }
      open?: { run?: unknown; agent?: unknown; group?: unknown; model?: unknown }
      tick?: { job?: unknown; model?: unknown }
      poke?: { job?: unknown; model?: unknown; by?: unknown }
    }
    await follow($)
    if (data.switchLimits === true) limits = await $.providers.switchLimits({ session: sessionId, isOff: liveLimits().isOn })
    if (data.tab === 'running' || data.tab === 'jobs' || data.tab === 'usage' || data.tab === 'log' || data.tab === 'limits' || data.tab === 'quota') view = { tab: data.tab, page: 0 }
    if (typeof data.tick?.job === 'string' && typeof data.tick.model === 'string') await tickModel($, data.tick.job, data.tick.model)
    if (typeof data.poke?.job === 'string' && typeof data.poke.model === 'string' && typeof data.poke.by === 'number') await movePoke($, data.poke.job, data.poke.model, data.poke.by)
    if (data.page === 1 || data.page === -1) view = { ...view, page: Math.max(0, view.page + data.page) }
    const raise = data.raise
    if (typeof raise?.pool === 'string' && (raise.role === 'main' || raise.role === 'helpers') && (RAISES_USD as readonly unknown[]).includes(raise.usd)) {
      limits = await $.providers.raise({ session: sessionId, pool: raise.pool, role: raise.role as Role, usd: raise.usd as number })
    }
    if (typeof data.toggle === 'string' && gates().includes(data.toggle)) {
      limits = await $.providers.close({ session: sessionId, gate: data.toggle, isClosed: !liveLimits().closed.includes(data.toggle) })
    }
    if (typeof data.stop?.run === 'string') {
      await liveJobs().stop(ioOf($), agentsOf($), sessionId, data.stop.run, typeof data.stop.key === 'string' ? data.stop.key : undefined)
    }
    if (typeof data.open?.run === 'string') await open($, { run: data.open.run })
    if (typeof data.open?.agent === 'string') await open($, { agent: data.open.agent })
    if (typeof data.open?.group === 'string') await open($, { group: data.open.group })
    if (typeof data.open?.model === 'string') await open($, { model: data.open.model })
    await syncHolds($)
    await syncBadge($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.message', { element: DETAIL_KEY }, async ($, e, next) => {
    const data = e.data as { close?: unknown; page?: unknown }
    if (data.close === true) {
      detail = null
      await $.sidebar.modal({ id: TAB_ID, isShown: false })
    }
    if (detail !== null && (data.page === 1 || data.page === -1)) detail = { ...detail, page: Math.max(0, detail.page + data.page) }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: [...ROW_COMPONENTS] }, async ($, e, next) => {
    const tree = await next(e)
    if (e.surface !== 'terminal') return tree
    const isDrawer = hasSlot(tree, DRAWER_SLOT)
    const shown = detail !== null && hasSlot(tree, MODAL_SLOT) ? detail : null
    if (!isDrawer && shown === null) return tree
    const room = await $.sidebar.room({})
    if (room === null) return tree
    const { Client } = $.ui.resolve(e)
    const now = await $.clock.now()
    // one snapshot: everything drawn below has its pool read, whatever starts during these reads
    const jobViews = sessionViews()
    const agents = subagents
    const read = await poolsOf($, [...usageKeys(jobViews, agents), ...(detail !== null && 'model' in detail.target ? [detail.target.model] : [])])
    const spend = await spendOf($, sessionId)
    let filled: unknown = tree
    if (isDrawer) {
      const props = overviewProps({
        ...view,
        rows: room.drawer,
        now,
        opened: detail?.target ?? null,
        groups,
        pools: read,
        jobs: jobViews,
        agents,
        spend,
        record,
        limits: liveLimits(),
        gates: gates(),
        quota: quotaViews,
        crew: crew.jobs,
        sessionKey: await sessionKey($),
        problems: [...(broken === null ? [] : [broken]), ...problems.map(problemText)],
      })
      if (quotaError !== null) props.quota.blocks.unshift({ title: 'Quota', color: '#e06c75', rows: [], notes: [quotaError] })
      const height = Math.min(room.drawer, overviewLines(props).length)
      filled = fillSlot(filled, DRAWER_SLOT, () => Client({ key: OVERVIEW_KEY, module: './overview.ts', props, width: OVERVIEW_COLUMNS, height }))
    }
    const shownNow = shown === null ? null : shownDetail(shown, now, read, spend)
    if (shown !== null && shownNow !== null) {
      const props = detailProps(shownNow.title, shownNow.text, room.modal, shown.page)
      const height = 1 + props.lines.length + (props.pages > 1 ? 1 : 0)
      filled = fillSlot(filled, MODAL_SLOT, () => Client({ key: DETAIL_KEY, module: './detail.ts', props, width: props.columns, height }))
    }
    return filled as typeof tree
  })

  on('tool.call', ($, e, next) => {
    const { tool: _tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, consent: _consent, ...input } = fields(e)
    const work = toolWork($, e.tool, input)
    return work === undefined ? next(e) : answer(work)
  })
}
