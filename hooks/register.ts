import type { EngineInterface, Register } from 'claude-code'
import type { SidebarDrawerSlot, SidebarModalSlot, SidebarRowComponent } from 'cc-sidebar'
import type { ProvidersGroup, ProvidersInfo, ProvidersLimitReached, ProvidersLimits } from 'cc-providers'

import { ClaudeAgents } from './agents.ts'
import type { ChangeSpec } from './changes.ts'
import { type Choice, type Settings, settingsFrom, withDefaults } from './config.ts'
import { wrap } from './detail.ts'
import type { Io } from './io.ts'
import { OVERVIEW_COLUMNS, overviewLines } from './overview.ts'
import type { DetailProps, Role, Tab, Target } from './overview-props.ts'
import { isAbsolute, isInside, isWindowsPath, join, namesOf } from './paths.ts'
import { REVIEWER_PROMPT, systemPrompt } from './prompt.ts'
import { gaugeColumns, quotaProps, type QuotaView } from './quota.ts'
import { emptyRecord, loadRecord, recordPath, saveRecord, type SessionRecord } from './record.ts'
import { type Alert, type AgentsPort, makeReviews, type ProvidersPort, Refused, type Reviews, type ReviewerSpec } from './reviews.ts'
import { fillSlot, hasSlot } from './slot.ts'
import { claudeTokens, sum, usd } from './usage.ts'
import { type Badge, RAISES_USD, agentDetail, badgeOf, itemsOf, overviewProps, runDetail, usageDetail } from './views.ts'

const REVIEW_DESCRIPTION = `Get independent reviews from other models, each in its own harness, run headless through cc-providers. Use it for a second opinion on code, a change, a design or a document.

Each reviewer reads only what \`read\` allows (the project by default), secret files (.env and the like) are always blocked, the rest of the disk is closed, and nothing is written except the reports. It runs in the background by default: you get the run id at once and a message with every reviewer's result when all are done. Do not poll or wait for it.

Brief it like a colleague who just walked into the room: the reviewers know nothing of this conversation. Say what to review, what matters, what you already know or suspect is out of scope. With \`changes\`, the diff is put in front of every reviewer.

Reports land in \`report_dir\` (default \`<project>/.claude/work/reviews\`), one folder per run, \`<provider>-<model>.md\` per reviewer. A reviewer that is signed out, out of quota or past its limit is reported loudly and the others carry on. A reviewer's cache stays warm for five minutes after it answers, so a follow-up within them is cheap; the summary says until when.`

const MODEL_NOTES: Record<string, string> = {
  codex: 'codex takes its own model names and effort low|medium|high|xhigh|max|ultra',
  antigravity: 'antigravity takes ids such as gemini-4-argon-high, gemini-3.8-flash-medium, claude-opus-5-5-high, claude-sonnet-5-5-medium, gpt-oss-120b-medium, or a model plus effort',
  claude: 'claude takes sonnet|opus|haiku and effort low|medium|high|xhigh|max, and runs on Claude whatever backend this session uses',
}

function reviewDescription(reviewable: readonly ProvidersInfo[]): string {
  const names = reviewable.map(p => (MODEL_NOTES[p.id] !== undefined ? `${MODEL_NOTES[p.id]}` : `${p.id} (${p.name}) runs its own models, a call's model and effort passed on`))
  return `${REVIEW_DESCRIPTION}\n\nReviewers: ${reviewable.map(p => p.id).join(', ')}. A reviewer whose call names no model or effort runs the configured default for its provider. ${names.join('. ')}.`
}

function reviewSchema(providers: readonly string[]) {
  const item = {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: [...providers] },
      model: { type: 'string' },
      effort: { type: 'string' },
    },
    required: ['provider'],
    additionalProperties: false,
  }
  return { ...REVIEW_SCHEMA, properties: { ...REVIEW_SCHEMA.properties, reviewers: { type: 'array', items: item, description: 'Who reviews; the configured default set when omitted' } } }
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'A short (3-5 word) description of the review' },
    prompt: { type: 'string', description: 'The self-contained brief every reviewer gets' },
    read: {
      description: '"project" (default), "none", or a list of paths (absolute, or relative to the project)',
      anyOf: [{ type: 'string', enum: ['project', 'none'] }, { type: 'array', items: { type: 'string' } }],
    },
    web: {
      type: 'boolean',
      description:
        'Allow web search and page reads (default false). Content under review can then steer a reviewer into fetching a URL that carries what it read: secrets stay closed, the reviewed code does not.',
    },
    helpers: { type: 'boolean', description: 'Let Codex and Antigravity reviewers run their own helper agents (default false)' },
    changes: {
      description: 'Review a change: "uncommitted", { "base": "<branch>" } or { "commit": "<sha>" } in the first read path',
      anyOf: [
        { type: 'string', enum: ['uncommitted'] },
        { type: 'object', properties: { base: { type: 'string' } }, required: ['base'], additionalProperties: false },
        { type: 'object', properties: { commit: { type: 'string' } }, required: ['commit'], additionalProperties: false },
      ],
    },
    report_dir: { type: 'string', description: 'Where the run folder goes, under <project>/.claude/work/' },
    background: { type: 'boolean', description: 'Return at once and deliver the results as a message (default true)' },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
}

const CONTINUE_SCHEMA = {
  type: 'object',
  properties: {
    run: { type: 'string', description: 'The run id' },
    reviewer: { type: 'string', description: 'The reviewer key from the run summary, e.g. codex-default' },
    message: { type: 'string', description: 'The follow-up; the reviewer still knows only its own conversation' },
    background: { type: 'boolean', description: 'Return at once and deliver the answer as a message (default true)' },
  },
  required: ['run', 'reviewer', 'message'],
  additionalProperties: false,
}

const STATUS_SCHEMA = {
  type: 'object',
  properties: { run: { type: 'string', description: 'One run; all of this session when omitted' } },
  additionalProperties: false,
}

let settings: Settings
let system = REVIEWER_PROMPT
let cacheDir = ''

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
/** Made at the first session start of this load: reviews running across a `/clear` still end into it. */
let reviews: Reviews | null = null
const claudeAgents = new ClaudeAgents()
/** What the modal shows: a review or agent with its brief or prompt as read when it was opened, or a pool or model worked out on each draw; the page it is at. */
let detail: { target: Target; text: string; page: number } | null = null
let ticker: { cancel(): void } | null = null
let quotaTicker: { cancel(): void } | null = null
let record: SessionRecord = emptyRecord()
let view: { tab: Tab; page: number } = { tab: 'running', page: 0 }
/** Set at session start and read again with the quota. */
let providersInfo: ProvidersInfo[] = []
let groups: ProvidersGroup[] = []
let quotaViews: QuotaView[] = []
/** Why the last quota read failed, shown on the Quota tab. */
let quotaError: string | null = null
/** The provider the session runs on; its subagents' models are keyed under it. */
let sessionProvider = ''
/** Set at session start and read again every tick. */
let limits: ProvidersLimits | null = null
type Ask = { session: string; key: string; pool: string }
/** The Telegram ask about a paused pool, open until answered, the pause ends or the session moves on. */
let openAsk: Ask | null = null
/** Puts up one ask at a time, so the ask a newer one replaces is always cancelled. */
let asking: Promise<unknown> = Promise.resolve()
let following: Promise<void> = Promise.resolve()

function liveReviews(): Reviews {
  if (reviews === null) throw new Error('crew: reviews are used before session start')
  return reviews
}

function liveLimits(): ProvidersLimits {
  if (limits === null) throw new Error('crew: limits are used before session start')
  return limits
}

const sessionViews = () => liveReviews().sessionReviews(sessionId).map(r => liveReviews().viewOf(r))
const reviewable = () => providersInfo.filter(p => p.styles.some(s => s.startsWith('cli:')))
const gates = () => [...providersInfo.map(p => p.id), 'agents']

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

/** The pop-out's title and text for what it shows, from the review's, agent's or model's state now; null once it is gone. */
function shownDetail(shown: NonNullable<typeof detail>, now: number): { title: string; text: string } | null {
  const target = shown.target
  if ('group' in target || 'model' in target) {
    const items = itemsOf(groups, sessionViews(), claudeAgents.all())
    const title = 'model' in target ? target.model : (groups.find(g => g.id === target.group)?.name ?? target.group)
    return { title, text: usageDetail(groups, items, liveLimits(), target, now) }
  }
  if ('run' in target) {
    const review = liveReviews().sessionReviews(sessionId).find(r => r.id === target.run)
    return review === undefined ? null : { title: `review: ${review.description}`, text: runDetail(liveReviews().viewOf(review), shown.text) }
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
    const review = liveReviews().sessionReviews(sessionId).find(r => r.id === target.run)
    if (review === undefined) throw new Error(`crew: no review ${target.run} in this session to open`)
    path = `${review.reportDir}/brief.md`
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

/** Reads the session's record, agents, reviews and limits; they replace what crew held only once all are read. */
async function enter($: EngineInterface, id: string): Promise<void> {
  const entered = await loadRecord(ioOf($), recordPath(cacheDir, id))
  const listed = await $.agent.list()
  await liveReviews().restore(ioOf($), agentsOf($), id)
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
  if (openAsk !== null && openAsk.session !== sessionId) {
    const ask = openAsk
    openAsk = null
    await $.courier.cancel({ key: ask.key, reason: 'That conversation ended: a /clear or a resume started another.' })
  }
  if (openAsk !== null && !limits.pools.some(p => p.pool === openAsk?.pool && p.pausedAt !== null)) {
    const ask = openAsk
    openAsk = null
    await $.courier.cancel({ key: ask.key, reason: 'The pause ended: its limit was raised or the limits were switched off.' })
  }
  await syncBadge($)
  if ((await $.sidebar.selected({})) !== TAB_ID) return
  $.ui.invalidate('ui.render')
}

/** Reads the providers, their pools and their quota again, and draws the gauge. */
async function readQuota($: EngineInterface): Promise<void> {
  try {
    providersInfo = await $.providers.list()
    groups = (await $.providers.catalog()).groups
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

/** A reviewer named in a call or in the default list, its provider's defaults filled in. */
function specOf(provider: string, own: Choice, where: string): ReviewerSpec {
  const known = reviewable().map(p => p.id)
  if (!known.includes(provider)) throw new BadInput(`unknown reviewer ${provider} ${where} (known: ${known.join(', ')}; others are providers in ~/.config/providers/providers.json with a cli: endpoint)`)
  return withDefaults({ provider, ...own }, settings.defaults)
}

function reviewersOf(f: Fields): ReviewerSpec[] {
  if (f.reviewers === undefined) return settings.reviewers.map(provider => specOf(provider, {}, 'in the default reviewers setting'))
  if (!Array.isArray(f.reviewers) || f.reviewers.length === 0) throw new BadInput('reviewers must be a non-empty list')
  return f.reviewers.map((r: Fields) => {
    if (typeof r.provider !== 'string') throw new BadInput(`a reviewer's provider must be a string, not ${String(r.provider)}`)
    const own: Choice = {}
    if (typeof r.model === 'string') own.model = r.model
    if (typeof r.effort === 'string') own.effort = r.effort
    return specOf(r.provider, own, 'in the call')
  })
}

function readOf(f: Fields): 'project' | 'none' | string[] {
  const v = f.read ?? 'project'
  if (v === 'project' || v === 'none') return v
  if (Array.isArray(v) && v.length > 0 && v.every(p => typeof p === 'string')) return v as string[]
  throw new BadInput('read must be "project", "none" or a non-empty list of paths')
}

function changesOf(f: Fields): ChangeSpec | undefined {
  const v = f.changes
  if (v === undefined) return undefined
  if (v === 'uncommitted') return v
  if (typeof v === 'object' && v !== null) {
    const o = v as Fields
    if (typeof o.base === 'string') return { base: o.base }
    if (typeof o.commit === 'string') return { commit: o.commit }
  }
  throw new BadInput('changes must be "uncommitted", { base } or { commit }')
}

function reportBase(f: Fields, project: string): string {
  const work = join(join(project, '.claude'), 'work')
  const v = f.report_dir
  if (v === undefined) return join(work, 'reviews')
  if (typeof v !== 'string') throw new BadInput('report_dir must be a path')
  const given = isAbsolute(v) ? v : join(project, v)
  const path = isWindowsPath(given) ? given.replace(/[\\/]+$/, '') : given.replace(/\/+$/, '')
  if (namesOf(path).includes('..') || !isInside(path, work)) throw new BadInput(`report_dir must be under ${work}`)
  return path
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
    get: input => $.agents.get(input),
    list: input => $.agents.list(input),
  }
}

function providersOf($: EngineInterface): ProvidersPort {
  return {
    modelKey: input => $.providers.modelKey(input),
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

async function startReview($: EngineInterface, f: Fields, signal: AbortSignal): Promise<string> {
  await follow($)
  const description = str(f, 'description')
  const brief = str(f, 'prompt')
  const specs = reviewersOf(f)
  const read = readOf(f)
  const changes = changesOf(f)
  const project = await $.session.root()
  const all = liveReviews()
  const agents = agentsOf($)
  const review = await all.begin(ioOf($), agents, providersOf($), alertOf($), {
    session: sessionId,
    description,
    brief,
    specs,
    read,
    project,
    reportBase: reportBase(f, project),
    ...(changes === undefined ? {} : { changes }),
    web: f.web === true,
    helpers: f.helpers === true,
    system,
    timeoutMs: settings.timeoutMs,
  })
  if (f.background === false) {
    signal.addEventListener('abort', () => void all.stop(agents, review.id))
    await all.whenDone(review.id)
    return all.summary(review)
  }
  if (all.isDone(review)) return all.summary(review)
  void all.whenDone(review.id).then(() => $.conversation.deliver({ from: 'crew', text: `review finished.\n${all.summary(review)}` }))
  const who = review.reviewers.map(r => r.key).join(', ')
  return `Started crew review ${review.id} (${who}). The results arrive as a message when every reviewer is done; reports go to ${review.reportDir}.`
}

async function continueReview($: EngineInterface, f: Fields, signal: AbortSignal): Promise<string> {
  await follow($)
  const key = str(f, 'reviewer')
  const all = liveReviews()
  const agents = agentsOf($)
  const { review, run } = await all.ask(ioOf($), agents, providersOf($), alertOf($), sessionId, str(f, 'run'), key, str(f, 'message'))
  if (run.isRefused === true) throw new Refused(`${key}: ${run.detail ?? run.status}`)
  if (f.background === false) {
    signal.addEventListener('abort', () => void agents.stop({ id: run.id }))
    await all.whenAnswered(run.id)
    return all.summary(review)
  }
  void all.whenAnswered(run.id).then(() => $.conversation.deliver({ from: 'crew', text: `follow-up to ${key} finished.\n${all.summary(review)}` }))
  return `Asked ${key} in run ${review.id}. Its answer arrives as a message.`
}

async function status($: EngineInterface, f: Fields): Promise<string> {
  await follow($)
  const all = liveReviews()
  if (typeof f.run === 'string') return all.summary(await all.load(ioOf($), agentsOf($), f.run))
  const lines = all.sessionReviews(sessionId).map(r => all.summary(r).split('\n')[0]!)
  if (lines.length === 0) lines.push('No crew reviews in this session.')
  const ids = reviewable().map(p => p.id)
  const views = await Promise.all(providersInfo.filter(p => ids.includes(p.id)).map(async info => ({ info, slots: await $.providers.quota({ provider: info.id, session: sessionId }) })))
  for (const block of quotaProps(views, await $.clock.now()).blocks) {
    lines.push('', `${block.title} quota:`, ...block.rows.map(r => `- ${r.pool === '' ? '' : `${r.pool} `}${r.window}: ${r.left} left, resets ${r.resets}`), ...block.notes.map(n => `- ${n}`))
  }
  return lines.join('\n')
}

function fields(e: unknown): Fields {
  return e as Fields
}

function answer(work: Promise<string>) {
  return work.then(
    text => ({ result: text }),
    (err: unknown) => ({ deny: err instanceof BadInput || err instanceof Refused ? `crew: ${err.message}` : `crew: ${String(err)}` }),
  )
}

/** What a Telegram ask came to: the label pressed, or why none was. */
type Asked = { picked: string } | { picked: undefined; why: 'not enabled' | 'closed' | 'courier not loaded' }

const isCourierMissing = (err: unknown) => err instanceof TypeError && err.message.includes('$.courier')

/** Shows `text` with one button per label in the session's thread and waits for a press. A failure other than a missing courier rejects. */
async function askChoice($: EngineInterface, ask: Ask, text: string, labels: string[]): Promise<Asked> {
  const key = ask.key
  try {
    const put = asking.then(async () => {
      if (openAsk !== null) await $.courier.cancel({ key: openAsk.key, reason: 'Replaced by a newer ask.' })
      openAsk = null
      await $.courier.ask({ key, thread: `cc:${ask.session}`, questions: [{ id: 'action', text, options: labels.map(label => ({ label })) }] })
      const delivered = await $.courier.deliver({ key, group: 'attention' })
      if (delivered.state !== 'held') openAsk = ask
      return delivered
    })
    // its failure is this caller's; the next ask still goes up
    asking = put.catch(() => undefined)
    let shown = await put
    if (shown.state === 'held') {
      await $.courier.cancel({ key, reason: 'The thread is not enabled.' })
      return { picked: undefined, why: 'not enabled' }
    }
    while (shown.state === 'delivered' && openAsk?.key === key) shown = await $.courier.wait({ key, known: 'delivered' })
    if (shown.state !== 'answered' || openAsk?.key !== key) return { picked: undefined, why: 'closed' }
    openAsk = null
    const picked = shown.answers['action']?.selected[0]
    if (picked === undefined || !labels.includes(picked)) throw new Error(`the answer ${JSON.stringify(picked)} is none of ${labels.join(', ')}`)
    return { picked }
  } catch (err) {
    if (isCourierMissing(err)) return { picked: undefined, why: 'courier not loaded' }
    throw err
  }
}

const KEEP_PAUSED = 'Keep paused'

/**
 * Asks the person on Telegram whether to let the paused conversation go on, and raises its limit by what they press;
 * asks again while a raise leaves it paused. Without Telegram the terminal and the thread get a notice instead.
 */
async function askRaise($: EngineInterface, session: string, reached: Pick<ProvidersLimitReached, 'pool' | 'name' | 'spentUsd' | 'limitUsd' | 'at'>): Promise<void> {
  const text = `Paused: this conversation spent ${usd(reached.spentUsd)} in the ${reached.name} pool at API prices, past its limit of ${usd(reached.limitUsd)}. It goes on in turns you start; a raise lets it go on by itself.`
  const labels = [...RAISES_USD.map(n => `+$${n}`), KEEP_PAUSED]
  const asked = await askChoice($, { session, key: `crew-limit:${session}:${reached.pool}:${reached.at}`, pool: reached.pool }, text, labels)
  if (asked.picked === undefined) {
    if (asked.why === 'closed') return
    await $.conversation.tell({ text: `crew: ${text}`, group: 'attention' })
    await $.ui.toast(`crew: ${text}`)
    return
  }
  if (asked.picked === KEEP_PAUSED) return
  // a raise in the tab can land before the press does
  const now = await $.providers.limits({ session })
  if (!now.pools.some(p => p.pool === reached.pool && p.pausedAt !== null)) return
  const raised = await $.providers.raise({ session, pool: reached.pool, role: 'main', usd: Number(asked.picked.slice(2)) })
  if (session === sessionId) {
    limits = raised
    await syncBadge($)
  }
  const pool = raised.pools.find(p => p.pool === reached.pool)
  if (pool?.pausedAt === null || pool === undefined || pool.main.limitUsd === null) return
  await askRaise($, session, { pool: reached.pool, name: pool.name, spentUsd: pool.main.spentUsd, limitUsd: pool.main.limitUsd, at: await $.clock.now() })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    // cc-providers and cc-agents, which crew lists as dependencies, start inside next(e)
    const started = await next(e)
    const home = await $.env.get('HOME')
    if (home === undefined) throw new Error('crew: HOME is not set, so its cache folder is unknown')
    cacheDir = join(join(home, '.cache'), 'crew')
    settings = settingsFrom(options)
    const rules = await Promise.all(settings.reviewerRules.map(async path => ({ path, text: await $.fs.read(path) })))
    system = systemPrompt(rules)
    reviews ??= makeReviews(cacheDir)
    providersInfo = await $.providers.list()
    groups = (await $.providers.catalog()).groups
    sessionProvider = (await $.providers.sessionProvider()).provider
    await $.tool.register({ name: 'review', description: reviewDescription(reviewable()), inputSchema: reviewSchema(reviewable().map(p => p.id)), isDeferred: false })
    await $.tool.register({
      name: 'review_continue',
      description: 'Ask a reviewer of a finished crew review a follow-up, in its own conversation. Background by default: the answer arrives as a message.',
      inputSchema: CONTINUE_SCHEMA,
    })
    await $.tool.register({
      name: 'review_status',
      description: "This session's crew reviews and the quota of each reviewer's provider.",
      inputSchema: STATUS_SCHEMA,
    })
    await $.sidebar.register(TOOL)
    await follow($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    quotaTicker?.cancel()
    quotaTicker = $.clock.every(QUOTA_MS, () => void readQuota($))
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
    if (reviews !== null && (await reviews.ended(ioOf($), alertOf($), e.run, e.outcome)) !== undefined) {
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
      // a noun call is cut at 10 s; the ask waits on the person
      $.clock.after(0, () =>
        void askRaise($, e.session, e).catch(async (err: unknown) => {
          const why = `crew: asking about the pause in ${e.name} failed: ${err instanceof Error ? err.message : String(err)}`
          $.ui.log(why, { to: 'debug' })
          await $.ui.toast(why)
        }),
      )
    }
    return reached
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
    }
    await follow($)
    if (data.switchLimits === true) limits = await $.providers.switchLimits({ session: sessionId, isOff: liveLimits().isOn })
    if (data.tab === 'running' || data.tab === 'usage' || data.tab === 'log' || data.tab === 'limits' || data.tab === 'quota') view = { tab: data.tab, page: 0 }
    if (data.page === 1 || data.page === -1) view = { ...view, page: Math.max(0, view.page + data.page) }
    const raise = data.raise
    if (typeof raise?.pool === 'string' && (raise.role === 'main' || raise.role === 'helpers') && (RAISES_USD as readonly unknown[]).includes(raise.usd)) {
      limits = await $.providers.raise({ session: sessionId, pool: raise.pool, role: raise.role as Role, usd: raise.usd as number })
    }
    if (typeof data.toggle === 'string' && gates().includes(data.toggle)) {
      limits = await $.providers.close({ session: sessionId, gate: data.toggle, isClosed: !liveLimits().closed.includes(data.toggle) })
    }
    if (typeof data.stop?.run === 'string') {
      await liveReviews().stop(agentsOf($), data.stop.run, typeof data.stop.key === 'string' ? data.stop.key : undefined)
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
        reviews: sessionViews(),
        agents: claudeAgents.all(),
        record,
        limits: liveLimits(),
        gates: gates(),
        quota: quotaViews,
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

  on('tool.call', { tool: 'mcp__cc-crew__review' }, ($, e, next) => answer(startReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__cc-crew__review_continue' }, ($, e, next) => answer(continueReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__cc-crew__review_status' }, ($, e) => answer(status($, fields(e))))

  on('turn.complete', async ($, e, next) => {
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
