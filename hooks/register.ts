import type { EngineInterface, Register } from 'claude-code'
import type { SidebarDrawerSlot, SidebarModalSlot, SidebarRowComponent } from 'cc-sidebar'
import type { BusPersonAnswered } from 'cc-bus'
import type { ProvidersGroup, ProvidersInfo, ProvidersLimitReached, ProvidersLimits, ProvidersProvider } from 'cc-providers'

import { ClaudeAgents } from './agents.ts'
import type { ChangeSpec } from './changes.ts'
import { type CrewFile, type Effective, effective, type JobSpec, mergeCrew, modelsFor, parseCrewFile, settingsFrom } from './config.ts'
import { wrap } from './detail.ts'
import type { Io } from './io.ts'
import { type Alert, type AgentsPort, type Jobs, makeJobs, type Picked, type ProvidersPort, Refused } from './jobs.ts'
import { OVERVIEW_COLUMNS, overviewLines } from './overview.ts'
import type { DetailProps, Role, Tab, Target } from './overview-props.ts'
import { join } from './paths.ts'
import { systemPrompt } from './prompt.ts'
import { gaugeColumns, type QuotaView } from './quota.ts'
import { emptyRecord, loadRecord, recordPath, saveRecord, type SessionRecord } from './record.ts'
import { fillSlot, hasSlot } from './slot.ts'
import { claudeTokens, sum, usd } from './usage.ts'
import { type Badge, RAISES_USD, agentDetail, badgeOf, itemsOf, jobDetail, overviewProps, usageDetail } from './views.ts'

const PREFIX = 'mcp__cc-crew__'

const RUNS_IN_BACKGROUND = `It runs in the background: you get its id at once, and a message when it finishes, or when an agent behind it stalls. Do not poll or wait for it. Agents read only the paths you name, secret files are always closed to them, and they change nothing. Read the result with \`report\`, not from files.`

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
    id: { type: 'string', description: 'The id its start or `jobs` gave, such as review-3' },
    scope: { type: 'string', description: 'Read this scope alone' },
    findings_only: { type: 'boolean', description: 'Read only the findings and their references' },
  },
  required: ['id'],
  additionalProperties: false,
}

const STOP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The id its start or `jobs` gave, such as review-3' },
    agent: { type: 'string', description: 'The letter of one agent; every running agent of it when left out' },
  },
  required: ['id'],
  additionalProperties: false,
}

let rules: { path: string; text: string }[] = []
/** The jobs, read at session start. */
let crew: CrewFile
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
const claudeAgents = new ClaudeAgents()
/** What the modal shows: a job or agent with its brief or prompt as read when it was opened, or a pool or model worked out on each draw; the page it is at. */
let detail: { target: Target; text: string; page: number } | null = null
let ticker: { cancel(): void } | null = null
let quotaTicker: { cancel(): void } | null = null
let livenessTicker: { cancel(): void } | null = null
/** Turns under way: none means the conversation is idle, so a poke can wake it. */
const openTurns = new Set<string>()
let record: SessionRecord = emptyRecord()
let view: { tab: Tab; page: number } = { tab: 'running', page: 0 }
/** Set at session start and read again with the quota. */
let providersInfo: ProvidersInfo[] = []
let catalog: ProvidersProvider[] = []
let groups: ProvidersGroup[] = []
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
/** The tab's switches: each provider that runs headless, and Claude's own agents. */
const gates = () => [...catalog.filter(p => Object.keys(p.endpoints).some(s => s.startsWith('cli:'))).map(p => p.id), 'agents']

/** The session's own model as cc-providers keys it; a job's list can depend on it. */
const sessionKey = async ($: EngineInterface) => $.providers.modelKey({ provider: sessionProvider, model: await $.session.model() })

async function keep($: EngineInterface): Promise<void> {
  record.agents = claudeAgents.all()
  await saveRecord(ioOf($), recordPath(cacheDir, sessionId), record)
}

const promptPath = (agentId: string) => `${cacheDir}/sessions/${sessionId}/prompts/${agentId}.md`

/** One page of the text, wrapped to the modal's width: the rows it has less the title row and, when it pages, the row of page buttons. */
export function detailProps(title: string, text: string, room: { rows: number; columns: number }, page: number): DetailProps {
  const lines = wrap(text, room.columns)
  const isOnePage = lines.length <= room.rows - 1
  const size = isOnePage ? lines.length : Math.max(1, room.rows - 2)
  const pages = Math.max(1, Math.ceil(lines.length / size))
  const at = Math.min(page, pages - 1)
  const shown = lines.slice(at * size, at * size + size)
  return { title, lines: shown, columns: room.columns, page: at, pages, first: at * size + 1, last: at * size + shown.length, total: lines.length }
}

/** The pop-out's title and text for what it shows, from the job's, agent's or model's state now; null once it is gone. */
function shownDetail(shown: NonNullable<typeof detail>, now: number): { title: string; text: string } | null {
  const target = shown.target
  if ('group' in target || 'model' in target) {
    const items = itemsOf(groups, sessionViews(), claudeAgents.all())
    const title = 'model' in target ? target.model : (groups.find(g => g.id === target.group)?.name ?? target.group)
    return { title, text: usageDetail(groups, items, liveLimits(), target, now) }
  }
  if ('run' in target) {
    const job = liveJobs().sessionJobs(sessionId).find(j => j.id === target.run)
    return job === undefined ? null : { title: `${job.id}: ${job.title}`, text: jobDetail(liveJobs().viewOf(job), shown.text) }
  }
  const id = target.agent
  const agent = claudeAgents.all().find(a => a.id === id)
  return agent === undefined ? null : { title: `${agent.type}: ${agent.description}`, text: agentDetail(agent, shown.text, now) }
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
  let path: string
  if ('run' in target) {
    const job = liveJobs().sessionJobs(sessionId).find(j => j.id === target.run)
    if (job === undefined) throw new Error(`crew: no job ${target.run} in this session to open`)
    path = join(job.dir, 'brief.md')
  } else {
    path = promptPath(target.agent)
  }
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : `(not kept: ${path} does not exist; the agent started before crew kept prompts)`
  detail = { target, text, page: 0 }
  await $.sidebar.modal({ id: TAB_ID, isShown: true })
}

/**
 * The badge last set, so the tick sets it only on a change: each set rewrites the rail's state. Null until this load
 * set one: the rail still shows what an earlier load set.
 */
let badge: Badge | null = null

async function syncBadge($: EngineInterface): Promise<void> {
  const next = badgeOf(sessionViews(), claudeAgents.all(), liveLimits())
  if (badge !== null && next.count === badge.count && next.level === badge.level) return
  badge = next
  await $.sidebar.badge({ id: TAB_ID, ...next })
}

/** Reads the session's record, agents, jobs and limits; they replace what crew held only once all are read. */
async function enter($: EngineInterface, id: string): Promise<void> {
  const entered = await loadRecord(ioOf($), recordPath(cacheDir, id))
  const listed = await $.agent.list()
  await liveJobs().restore(ioOf($), agentsOf($), id)
  const read = await $.providers.limits({ session: id })
  claudeAgents.restore(entered.agents, listed)
  record = entered
  limits = read
  sessionId = id
  await syncBadge($)
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
  claudeAgents.refresh(await $.agent.list())
  limits = await $.providers.limits({ session: sessionId })
  if (openAsk !== null && openAsk.session !== sessionId) await closeAsk($, 'That conversation ended: a /clear or a resume started another.')
  if (openAsk !== null && !limits.pools.some(p => p.pool === openAsk?.pool && p.pausedAt !== null)) {
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
  const all = liveJobs()
  const now = await $.clock.now()
  await all.read(agentsOf($), sessionId, now)
  if (openTurns.size > 0) return
  for (const job of all.sessionJobs(sessionId)) {
    const text = all.poke(job, now)
    if (text !== undefined) await $.conversation.deliver({ from: 'crew', text })
  }
}

/** Reads the providers, their pools and their quota again, and draws the gauge. */
async function readQuota($: EngineInterface): Promise<void> {
  try {
    providersInfo = await $.providers.list()
    ;({ providers: catalog, groups } = await $.providers.catalog())
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
  throw new BadInput('paths must be a non-empty list of paths')
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

/** Each model picked a provider, or why it can't run now. */
async function pickFor($: EngineInterface, settings: readonly Effective[]): Promise<{ picks: Picked[]; skipped: { serves: string; why: string }[] }> {
  const picks: Picked[] = []
  const skipped: { serves: string; why: string }[] = []
  for (const s of settings) {
    const { ranked, dropped } = await $.providers.pick({ session: sessionId, serves: s.serves, ...(s.provider === undefined ? {} : { provider: s.provider }), ...(s.effort === undefined ? {} : { effort: s.effort }) })
    const best = ranked[0]
    if (best === undefined) skipped.push({ serves: s.serves, why: dropped.length === 0 ? 'no provider offers it' : dropped.map(d => `${d.key}: ${d.why}`).join('; ') })
    else picks.push({ ...s, provider: best.provider, model: best.model, key: best.key })
  }
  return { picks, skipped }
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
    activity: input => $.agents.activity(input),
    get: input => $.agents.get(input),
    list: input => $.agents.list(input),
  }
}

function providersOf($: EngineInterface): ProvidersPort {
  return {
    refusal: input => $.providers.refusal(input),
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
  if (kinds[spec.kind] === undefined) throw new Refused(`${name} runs as kind ${spec.kind}, which cc-agents does not have (${Object.keys(kinds).join(', ')}); fix it in ~/.config/crew/crew.json`)
  const choice = record.jobs[name]
  const models = modelsFor(spec, await sessionKey($), choice)
  if (models.length === 0) throw new Refused(`no model is ticked for ${name} in the crew tab; ask the person to tick one`)
  const { picks, skipped } = await pickFor($, models.map(m => effective(spec, m, choice?.pokeMin?.[m])))
  if (picks.length === 0) throw new Refused(`no model can run ${name} now: ${skipped.map(s => `${s.serves}: ${s.why}`).join('; ')}`)
  const all = liveJobs()
  const job = await all.begin(ioOf($), agentsOf($), providersOf($), alertOf($), {
    session: sessionId,
    job: name,
    brief,
    picks,
    skipped,
    kind: spec.kind,
    read,
    project: await $.session.root(),
    ...(diff === undefined ? {} : { diff }),
    system: systemPrompt(await $.fs.read(spec.prompt), rules),
  })
  for (const s of skipped) await alertOf($)(s.serves, `${job.id} runs without it: ${s.why}`)
  const finish = async () => $.conversation.deliver({ from: 'crew', text: await all.summary(ioOf($), job) })
  if (all.isDone(job)) return all.summary(ioOf($), job)
  void all.whenDone(job).then(finish)
  return `Started ${job.id} with ${job.agents.length} agent${job.agents.length === 1 ? '' : 's'}. A message says when it finished; read it with report { id: "${job.id}" }.`
}

/** The running jobs and the finished ones not read in full yet. */
async function listJobs($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'jobs', [])
  const all = liveJobs()
  const now = await $.clock.now()
  const shown = all.sessionJobs(sessionId).filter(j => !all.isDone(j) || !j.isAcked)
  if (shown.length === 0) return 'Nothing runs and nothing is unread.'
  return (await Promise.all(shown.map(j => all.line(ioOf($), j, now)))).join('\n')
}

async function readReport($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'report', ['id', 'scope', 'findings_only'])
  return liveJobs().report(ioOf($), agentsOf($), sessionId, str(f, 'id'), {
    ...(f.scope === undefined ? {} : { scope: str(f, 'scope') }),
    ...(f.findings_only === true ? { findingsOnly: true } : {}),
  })
}

async function stopJob($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  only(f, 'stop', ['id', 'agent'])
  const label = f.agent === undefined ? undefined : str(f, 'agent')
  const count = await liveJobs().stop(agentsOf($), sessionId, str(f, 'id'), label)
  return count === 0 ? 'Nothing of it was running.' : `Stopping ${count} agent${count === 1 ? '' : 's'}; the report keeps what the others find.`
}

/** The tool's work, or undefined for a tool that is none of crew's. */
function toolWork($: EngineInterface, tool: string, f: Fields): Promise<string> | undefined {
  if (!tool.startsWith(PREFIX)) return undefined
  const name = tool.slice(PREFIX.length)
  if (name === 'jobs') return listJobs($, f)
  if (name === 'report') return readReport($, f)
  if (name === 'stop') return stopJob($, f)
  const spec = crew.jobs[name]
  return spec === undefined ? undefined : startJob($, name, spec, f)
}

function fields(e: unknown): Fields {
  return e as Fields
}

function answer(work: Promise<string>) {
  return work.then(
    text => ({ result: text }),
    (err: unknown) => ({ deny: `crew: ${err instanceof Error ? err.message : String(err)}` }),
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

/** Where nobody carries the ask to the person: the terminal, and the thread for whoever carries notices there. */
async function notice($: EngineInterface, text: string): Promise<void> {
  await $.conversation.tell({ text: `crew: ${text}`, group: 'attention' })
  await $.ui.toast(`crew: ${text}`)
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
  const paused = (await $.providers.limits({ session: ask.session })).pools.find(p => p.pool === ask.pool && p.pausedAt !== null)
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
    await syncBadge($)
  }
  const pool = raised.pools.find(p => p.pool === ask.pool)
  if (pool?.pausedAt === null || pool === undefined || pool.main.limitUsd === null) return
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

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // cc-providers and cc-agents, which crew lists as dependencies, start inside next(e)
    const started = await next(e)
    const home = await $.env.get('HOME')
    if (home === undefined) throw new Error('crew: HOME is not set, so its cache folder is unknown')
    cacheDir = join(join(home, '.cache'), 'crew')
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
    const claudeDir = configDir !== undefined && configDir !== '' ? configDir : join(home, '.claude')
    rules = await Promise.all(settingsFrom(options).rules.map(async path => ({ path, text: await $.fs.read(path) })))
    const shippedPath = join($.plugin.root, 'crew.json')
    const ownPath = join(join(join(home, '.config'), 'crew'), 'crew.json')
    const own = (await $.fs.exists(ownPath)) ? parseCrewFile(await $.fs.read(ownPath), ownPath) : null
    crew = mergeCrew(parseCrewFile(await $.fs.read(shippedPath), shippedPath), own, own === null ? shippedPath : `${shippedPath} with ${ownPath} over it`)
    jobs ??= makeJobs(join(claudeDir, 'crew'), cacheDir)
    providersInfo = await $.providers.list()
    ;({ providers: catalog, groups } = await $.providers.catalog())
    sessionProvider = (await $.providers.sessionProvider()).provider
    for (const [name, spec] of Object.entries(crew.jobs)) {
      await $.tool.register({ name, description: `${spec.description}\n\n${RUNS_IN_BACKGROUND}`, inputSchema: jobSchema(spec), isDeferred: false })
    }
    await $.tool.register({ name: 'jobs', description: 'What crew runs now and what finished that you have not read in full, with how each agent is doing.', inputSchema: JOBS_SCHEMA, isDeferred: false })
    await $.tool.register({
      name: 'report',
      description: "Read what a crew job found: a report by scope (what system), each with its findings and references. By default the whole report, which marks it read; with `scope` that scope alone, with `findings_only` just the findings and their references, to keep it short or to skip scopes that don't concern you.",
      inputSchema: REPORT_SCHEMA_INPUT,
      isDeferred: false,
    })
    await $.tool.register({ name: 'stop', description: 'Give up on a running crew job or one agent of it. What the others find is kept.', inputSchema: STOP_SCHEMA, isDeferred: false })
    await $.sidebar.register(TOOL)
    await follow($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    quotaTicker?.cancel()
    quotaTicker = $.clock.every(QUOTA_MS, () => void readQuota($))
    livenessTicker?.cancel()
    livenessTicker = $.clock.every(LIVENESS_MS, () => void watchJobs($))
    $.clock.after(0, () => void readQuota($))
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    await follow($)
    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      const model = spawned.model ?? e.model ?? e.parentModel
      claudeAgents.started({
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description,
        model: spawned.model,
        key: await $.providers.modelKey({ provider: sessionProvider, ...(model === undefined ? {} : { model }) }),
        ...(e.workflow === undefined ? {} : { workflow: e.workflow.runId }),
        startedAt: await $.clock.now(),
      })
      await $.fs.write(promptPath(spawned.agentId), e.prompt)
      await keep($)
    }
    return spawned
  })

  on('agents.ended', async ($, e, next) => {
    const ended = await next(e)
    if (jobs !== null && (await jobs.ended(ioOf($), alertOf($), e.run, e.outcome)) !== undefined) {
      await syncBadge($)
      $.ui.invalidate('ui.render')
    }
    return ended
  })

  on('providers.limitReached', async ($, e, next) => {
    const reached = await next(e)
    await follow($)
    if (e.session === sessionId) {
      limits = await $.providers.limits({ session: sessionId })
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
      await liveJobs().stop(agentsOf($), sessionId, data.stop.run, typeof data.stop.key === 'string' ? data.stop.key : undefined)
    }
    if (typeof data.open?.run === 'string') await open($, { run: data.open.run })
    if (typeof data.open?.agent === 'string') await open($, { agent: data.open.agent })
    if (typeof data.open?.group === 'string') await open($, { group: data.open.group })
    if (typeof data.open?.model === 'string') await open($, { model: data.open.model })
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
    let filled: unknown = tree
    if (isDrawer) {
      const props = overviewProps({
        ...view,
        rows: room.drawer,
        now,
        opened: detail?.target ?? null,
        groups,
        jobs: sessionViews(),
        agents: claudeAgents.all(),
        record,
        limits: liveLimits(),
        gates: gates(),
        quota: quotaViews,
        crew: crew.jobs,
        sessionKey: await sessionKey($),
      })
      if (quotaError !== null) props.quota.blocks.unshift({ title: 'Quota', color: '#e06c75', rows: [], notes: [quotaError] })
      const height = Math.min(room.drawer, overviewLines(props).length)
      filled = fillSlot(filled, DRAWER_SLOT, () => Client({ key: OVERVIEW_KEY, module: './overview.ts', props, width: OVERVIEW_COLUMNS, height }))
    }
    const shownNow = shown === null ? null : shownDetail(shown, now)
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

  on('turn.start', ($, e, next) => {
    openTurns.add(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    openTurns.delete(e.turnId)
    await follow($)
    if (e.agentId === undefined) {
      record.turns += 1
      // the conversation writes the 1-hour cache, and a turn's usage doesn't split its writes by lifetime
      if (e.usage !== undefined) record.main = sum([record.main, { ...claudeTokens(e.usage), written1h: e.usage.cache_creation_input_tokens }])
      await keep($)
    } else {
      const tokens = e.usage === undefined ? undefined : claudeTokens(e.usage)
      const key = claudeAgents.keyOf(e.agentId)
      const at = await $.clock.now()
      const cost = tokens === undefined || key === undefined ? undefined : await $.providers.cost({ key, report: { total: tokens, at } })
      const turn = { isAnswer: e.reason === 'answer', usd: cost?.usd ?? 0, isEstimate: cost !== undefined && (cost.isEstimate || !cost.isPriced), at, ...(tokens === undefined ? {} : { tokens }) }
      if (claudeAgents.finished(e.agentId, turn)) await keep($)
    }
    return next(e)
  })
}
