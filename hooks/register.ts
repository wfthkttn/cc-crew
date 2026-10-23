import type { EngineInterface, Register } from 'claude-code'
import type { SidebarDrawerSlot, SidebarPopoutSlot, SidebarRowComponent } from 'sidebar'

import { ClaudeAgents } from './agents.ts'
import { wrap } from './detail.ts'
import { type ChangeSpec, changeOf } from './changes.ts'
import * as claude from './claude.ts'
import { type Provider, type Settings, isProvider, settingsFrom, withDefaults } from './config.ts'
import type { Io } from './io.ts'
import { agentRefusal, claudeModel, followUpRefusal, GATES, type Gate, reviewerModel, reviewRefusal } from './limits.ts'
import { OVERVIEW_COLUMNS, overviewLines } from './overview.ts'
import type { DetailProps, Tab, Target } from './overview-props.ts'
import { emptyRecord, loadRecord, recordPath, saveRecord, type SessionRecord } from './record.ts'
import { describeEnd, run as runChild } from './proc.ts'
import { REVIEWER_PROMPT, systemPrompt, taskText } from './prompt.ts'
import {
  type Alert,
  type ReviewerSpec,
  type Run,
  ask,
  beginClaude,
  continueOne,
  execute,
  keysFor,
  load,
  runs,
  slugOf,
  stopReviewer,
  summary,
} from './runs.ts'
import { type ReadSpec, findSecrets, folderOf, isInside, resolveRoots } from './scope.ts'
import { fillSlot, hasSlot } from './slot.ts'
import { claudeTokens } from './usage.ts'
import { type Badge, RAISE_BY, agentDetail, badgeOf, limitsOf, limitsProps, overviewProps, runDetail, spentOf } from './views.ts'

const REVIEW_DESCRIPTION = `Get independent reviews from other models, each in its own harness: Codex (GPT models, ChatGPT plan), Antigravity (Gemini models, and Claude Opus/Sonnet 5.5 by model id, Google AI Pro plan) and a Claude reviewer subagent. Use it for a second opinion on code, a change, a design or a document.

Each reviewer reads only what \`read\` allows (the project by default), secret files (.env and the like) are always blocked, the rest of the disk is closed, and nothing is written except the reports. It runs in the background by default: you get the run id at once and a message with every reviewer's result when all are done. Do not poll or wait for it.

Brief it like a colleague who just walked into the room: the reviewers know nothing of this conversation. Say what to review, what matters, what you already know or suspect is out of scope. With \`changes\`, the diff is put in front of every reviewer.

Reports land in \`report_dir\` (default \`<project>/.claude/work/reviews\`), one folder per run, \`<provider>-<model>.md\` per reviewer. A reviewer that is signed out or out of quota is reported loudly and the others carry on.

Models: a reviewer whose call names no model or effort runs the configured default for its provider. codex takes its own model names and effort low|medium|high|xhigh|max|ultra. antigravity takes ids such as gemini-4-argon-high, gemini-3.8-flash-medium, claude-opus-5-5-high, claude-sonnet-5-5-medium, gpt-oss-120b-medium, or a model plus effort. claude takes sonnet|opus|haiku; its effort is the configured one, else the session's, and a call cannot set it.`

const REVIEWER_ITEM = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: ['codex', 'antigravity', 'claude', 'claude-p'] },
    model: { type: 'string' },
    effort: { type: 'string' },
  },
  required: ['provider'],
  additionalProperties: false,
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'A short (3-5 word) description of the review' },
    prompt: { type: 'string', description: 'The self-contained brief every reviewer gets' },
    reviewers: { type: 'array', items: REVIEWER_ITEM, description: 'Who reviews; the configured default set when omitted' },
    read: {
      description: '"project" (default), "none", or a list of paths (absolute, or relative to the project)',
      anyOf: [{ type: 'string', enum: ['project', 'none'] }, { type: 'array', items: { type: 'string' } }],
    },
    web: {
      type: 'boolean',
      description:
        'Allow web search and page reads (default false). Content under review can then steer a reviewer into fetching a URL that carries what it read: secrets stay closed, the reviewed code does not.',
    },
    helpers: { type: 'boolean', description: "Let Codex and Antigravity reviewers run their own helper agents (default false)" },
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
const approvedDir = () => `${cacheDir}/approved`

const TAB_ID = 'crew'
const DRAWER_SLOT: SidebarDrawerSlot = `sidebar-drawer:${TAB_ID}`
const POPOUT_SLOT: SidebarPopoutSlot = `sidebar-popout:${TAB_ID}`
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
/** After the vault's and quota's tabs. */
const TOOL = { id: TAB_ID, icon: '👥', short: 'crew', drawerColumns: OVERVIEW_COLUMNS + DRAWER_FRAME_COLUMNS, order: 2 }
/** How often the open drawer redraws, for its clocks. */
const TICK_MS = 1000

let sessionId = ''
const claudeAgents = new ClaudeAgents()
/** The run or agent the pop-out shows, with its brief or prompt as read from `path` when it was opened. */
let detail: { target: Target; text: string; path: string } | null = null
let ticker: { cancel(): void } | null = null
let record: SessionRecord = emptyRecord()
let view: { tab: Tab; page: number } = { tab: 'running', page: 0 }

const sessionRuns = () => [...runs.values()].filter(run => run.sessionId === sessionId)
const currentLimits = () => limitsOf(settings.limits, record)
const currentSpent = () => spentOf(sessionRuns(), claudeAgents.all())

async function keep($: EngineInterface): Promise<void> {
  record.agents = claudeAgents.all()
  await saveRecord(ioOf($), recordPath(cacheDir, sessionId), record)
}

/** This session's runs from disk, so a reload or a resume still shows and counts them. */
async function loadSessionRuns($: EngineInterface): Promise<void> {
  const io = ioOf($)
  const dir = `${cacheDir}/runs`
  if (!(await io.exists(dir))) return
  for (const entry of await io.list(dir)) {
    const path = `${dir}/${entry.name}/run.json`
    if (entry.kind !== 'dir' || runs.has(entry.name) || !(await io.exists(path))) continue
    const kept = JSON.parse(await io.read(path)) as Pick<Run, 'sessionId'>
    if (kept.sessionId === sessionId) await load(io, cacheDir, entry.name)
  }
}

const promptPath = (agentId: string) => `${cacheDir}/sessions/${sessionId}/prompts/${agentId}.md`

/** Text as the pop-out's room allows, the last line saying where the rest is when it does not fit. */
export function detailProps(title: string, text: string, path: string, rows: number): DetailProps {
  const lines = wrap(text, OVERVIEW_COLUMNS)
  const room = Math.max(1, rows - 1)
  if (lines.length <= room) return { title, lines }
  const kept = lines.slice(0, room - 1)
  return { title, lines: [...kept, `… ${lines.length - kept.length} more lines in ${path}`] }
}

/** The pop-out's title and text for what it shows, from the run's or agent's state now; null once it is gone. */
function shownDetail(shown: NonNullable<typeof detail>, now: number): { title: string; text: string } | null {
  if ('run' in shown.target) {
    const run = runs.get(shown.target.run)
    return run === undefined ? null : { title: `review: ${run.description}`, text: runDetail(run, shown.text) }
  }
  const id = shown.target.agent
  const agent = claudeAgents.all().find(a => a.id === id)
  return agent === undefined ? null : { title: `${agent.type}: ${agent.description}`, text: agentDetail(agent, shown.text, now) }
}

/** Opens the run's or agent's details in the pop-out, or closes them when they are what it shows. */
async function open($: EngineInterface, target: Target): Promise<void> {
  if (detail !== null && JSON.stringify(detail.target) === JSON.stringify(target)) {
    detail = null
    await $.sidebar.popout({ id: TAB_ID, isShown: false })
    return
  }
  let path: string
  if ('run' in target) {
    const run = runs.get(target.run)
    if (run === undefined) throw new Error(`crew: no run ${target.run} in this session to open`)
    path = `${run.reportDir}/brief.md`
  } else {
    path = promptPath(target.agent)
  }
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : `(not kept: ${path} does not exist; the agent started before crew kept prompts)`
  detail = { target, text, path }
  await $.sidebar.popout({ id: TAB_ID, isShown: true })
}

/**
 * The badge last set, so the tick sets it only on a change: each set rewrites the rail's state. Null until this load
 * set one: the rail still shows what an earlier load set.
 */
let badge: Badge | null = null

async function syncBadge($: EngineInterface): Promise<void> {
  const next = badgeOf(sessionRuns(), claudeAgents.all(), limitsProps(currentLimits(), currentSpent()))
  if (badge !== null && next.count === badge.count && next.level === badge.level) return
  badge = next
  await $.sidebar.badge({ id: TAB_ID, ...next })
}

async function tick($: EngineInterface): Promise<void> {
  claudeAgents.refresh(await $.agent.list())
  await syncBadge($)
  if ((await $.sidebar.selected({})) !== TAB_ID) return
  $.ui.invalidate('ui.render')
}

const alert: Alert = async (io, provider, detail) => {
  try {
    await io.notify(`${provider}: ${detail}`)
    return undefined
  } catch (err) {
    return String(err)
  }
}

type Fields = Record<string, unknown>

class BadInput extends Error {}

function str(f: Fields, key: string): string {
  const v = f[key]
  if (typeof v !== 'string' || v.trim() === '') throw new BadInput(`${key} must be a non-empty string`)
  return v
}

function reviewersOf(f: Fields): ReviewerSpec[] {
  if (f.reviewers === undefined) return settings.reviewers.map(provider => withDefaults({ provider }, settings.defaults))
  if (!Array.isArray(f.reviewers) || f.reviewers.length === 0) throw new BadInput('reviewers must be a non-empty list')
  return f.reviewers.map((r: Fields) => {
    if (typeof r.provider !== 'string' || !isProvider(r.provider)) throw new BadInput(`unknown provider: ${String(r.provider)}`)
    const spec: ReviewerSpec = { provider: r.provider as Provider }
    if (typeof r.model === 'string') spec.model = r.model
    if (typeof r.effort === 'string') spec.effort = r.effort
    return withDefaults(spec, settings.defaults)
  })
}

function readOf(f: Fields): ReadSpec {
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
  const work = `${project}/.claude/work`
  const v = f.report_dir
  if (v === undefined) return `${work}/reviews`
  if (typeof v !== 'string') throw new BadInput('report_dir must be a path')
  const path = (v.startsWith('/') ? v : `${project}/${v}`).replace(/\/+$/, '')
  if (path.split('/').includes('..') || !isInside(path, work)) throw new BadInput(`report_dir must be under ${work}`)
  return path
}

/** Characters per `$.fs.write`: at most 4 bytes each in UTF-8, so a piece stays under the engine's 4 MiB a write. */
const WRITE_PIECE = 1024 * 1024

/**
 * Writes a file of any size: one past a piece goes in pieces, which a shell joins. Antigravity's deny list for a read
 * path in a folder as full as /nix/store runs past 4 MiB.
 */
async function writeFile($: EngineInterface, path: string, text: string): Promise<void> {
  if (text.length <= WRITE_PIECE) return $.fs.write(path, text)
  const pieces: string[] = []
  for (let at = 0; at < text.length; at += WRITE_PIECE) {
    const piece = `${path}.piece-${pieces.length}`
    await $.fs.write(piece, text.slice(at, at + WRITE_PIECE))
    pieces.push(piece)
  }
  const joined = await $.process.run(['sh', '-c', 'out="$1"; shift; cat -- "$@" > "$out" && rm -- "$@"', 'sh', path, ...pieces])
  if (joined.exitCode !== 0) throw new Error(`crew: could not join ${pieces.length} pieces into ${path} (exit ${joined.exitCode}): ${joined.stderr.trim()}`)
}

function ioOf($: EngineInterface): Io {
  return {
    stat: (path, options) => $.fs.stat(path, options),
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    write: (path, text) => writeFile($, path, text),
    exists: path => $.fs.exists(path),
    spawn: request => $.process.spawn(request),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    sleep: ms => $.clock.sleep(ms),
    agents: () => $.agent.list(),
    spawnAgent: args => $.agent.spawn(args),
    send: args => $.session.send(args),
    notify: text => $.conversation.tell({ text: `crew: ${text}`, group: 'attention' }),
  }
}

async function runId($: EngineInterface): Promise<string> {
  const d = new Date(await $.clock.now())
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const tail = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0')
  return `${stamp}-${tail}`
}

async function finish($: EngineInterface, label: string, work: () => Promise<string>): Promise<void> {
  let text: string
  try {
    text = await work()
  } catch (err) {
    text = `${label} failed: ${String(err)}`
  }
  await $.conversation.deliver({ from: 'crew', text })
}

async function startReview($: EngineInterface, f: Fields, signal: AbortSignal): Promise<string> {
  const description = str(f, 'description')
  const brief = str(f, 'prompt')
  const specs = reviewersOf(f)
  const models = specs.map(s => reviewerModel(s.provider, s.model))
  const refusal = reviewRefusal(currentLimits(), currentSpent(), specs.map(s => s.provider), models)
  if (refusal !== undefined) throw new BadInput(refusal)
  const read = readOf(f)
  const changes = changesOf(f)
  const web = f.web === true
  const helpers = f.helpers === true
  const background = f.background !== false
  const io = ioOf($)
  const project = await $.session.root()
  const base = reportBase(f, project)
  const { roots, files } = await resolveRoots(io, read, project)
  if (changes !== undefined && roots[0] === undefined) throw new BadInput('changes needs a read path holding the repository')
  const secrets = await findSecrets(io, roots, files)
  const change = changes !== undefined && roots[0] !== undefined ? await changeOf(io, folderOf(roots[0], files), changes) : undefined
  const id = await runId($)
  const runDir = `${cacheDir}/runs/${id}`
  const keys = keysFor(specs)
  const now = await $.clock.now()
  const run: Run = {
    id,
    description,
    createdAt: now,
    reportDir: `${base}/${id}-${slugOf(description)}`,
    runDir,
    roots,
    files,
    secrets,
    web,
    helpers,
    ...(change !== undefined ? { changes: change.label } : {}),
    reviewers: specs.map((s, i) => ({ ...s, key: keys[i]!, status: 'running', dir: `${runDir}/${keys[i]!}`, startedAt: now })),
    sessionId,
  }
  const task = taskText({ brief, roots, web, ...(change !== undefined ? { changes: change } : {}) })
  await $.fs.write(`${run.reportDir}/brief.md`, task)
  const begun = await beginClaude(io, run, settings, system, task)
  if (!background) {
    await execute(io, run, settings, system, task, cacheDir, alert, begun, signal)
    return summary(run)
  }
  $.clock.after(0, () =>
    void finish($, `review ${id}`, async () => {
      await execute(io, run, settings, system, task, cacheDir, alert, begun)
      return `review finished.\n${summary(run)}`
    }),
  )
  const who = run.reviewers.map(r => r.key).join(', ')
  return `Started crew review ${id} (${who}). The results arrive as a message when every reviewer is done; reports go to ${run.reportDir}.`
}

async function continueReview($: EngineInterface, f: Fields, signal: AbortSignal): Promise<string> {
  const io = ioOf($)
  const run = await load(io, cacheDir, str(f, 'run'))
  const key = str(f, 'reviewer')
  const message = str(f, 'message')
  const r = run.reviewers.find(x => x.key === key)
  if (r === undefined) throw new BadInput(`run ${run.id} has no reviewer ${key}; it has ${run.reviewers.map(x => x.key).join(', ')}`)
  if (r.status === 'running') throw new BadInput(`${key} is still running`)
  const refusal = followUpRefusal(currentLimits(), currentSpent(), r.provider, reviewerModel(r.provider, r.usedModel ?? r.model))
  if (refusal !== undefined) throw new BadInput(refusal)
  if (f.background === false) {
    await continueOne(io, run, r, settings, await ask(io, run, r, settings, system, message, signal), alert)
    return summary(run)
  }
  const asked = await ask(io, run, r, settings, system, message)
  $.clock.after(0, () =>
    void finish($, `follow-up ${run.id}/${key}`, async () => {
      await continueOne(io, run, r, settings, asked, alert)
      return `follow-up to ${key} finished.\n${summary(run)}`
    }),
  )
  return `Asked ${key} in run ${run.id}. Its answer arrives as a message.`
}

async function status($: EngineInterface, f: Fields): Promise<string> {
  const io = ioOf($)
  if (typeof f.run === 'string') return summary(await load(io, cacheDir, f.run))
  const lines = [...runs.values()].map(r => summary(r).split('\n')[0]!)
  if (lines.length === 0) lines.push('No crew reviews in this session.')
  let agyQuota: string
  try {
    const quota = await runChild(io, { argv: [settings.agyBin, '-p', '/quota'], env: { HOME: `${cacheDir}/agy-home` } }, { timeoutMs: 20_000 })
    agyQuota = quota.ended.kind === 'exited' && quota.ended.code === 0 ? quota.stdout.trim() : `unavailable (${describeEnd(quota)})`
  } catch (err) {
    agyQuota = `unavailable: ${settings.agyBin} did not run (${String(err)})`
  }
  lines.push('', 'Antigravity quota:', agyQuota)
  lines.push('Codex quota: not read yet (needs its app-server).')
  return lines.join('\n')
}

function fields(e: unknown): Fields {
  return e as Fields
}

function answer(work: Promise<string>) {
  return work.then(
    text => ({ result: text }),
    (err: unknown) => ({ deny: err instanceof BadInput ? `crew: ${err.message}` : `crew: ${String(err)}` }),
  )
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = await $.env.get('HOME')
    if (home === undefined) throw new Error('crew: HOME is not set, so its cache folder is unknown')
    cacheDir = `${home}/.cache/crew`
    const rules = await Promise.all(settings.reviewerRules.map(async path => ({ path, text: await $.fs.read(path) })))
    system = systemPrompt(rules)
    for (const spec of claude.agentSpecs(system, approvedDir(), settings.defaults.claude?.effort)) await $.agent.register(spec)
    await $.tool.register({ name: 'review', description: REVIEW_DESCRIPTION, inputSchema: REVIEW_SCHEMA, isDeferred: false })
    await $.tool.register({
      name: 'review_continue',
      description: 'Ask a reviewer of a finished crew review a follow-up, in its own conversation. Background by default: the answer arrives as a message.',
      inputSchema: CONTINUE_SCHEMA,
    })
    await $.tool.register({
      name: 'review_status',
      description: "This session's crew review runs and the Antigravity quota.",
      inputSchema: STATUS_SCHEMA,
    })
    sessionId = await $.session.id()
    record = await loadRecord(ioOf($), recordPath(cacheDir, sessionId))
    claudeAgents.restore(record.agents, await $.agent.list())
    await loadSessionRuns($)
    await $.sidebar.register(TOOL)
    await syncBadge($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    // crew's own reviewers show under their run and count against the review limits.
    if (e.subagentType.startsWith('crew:')) return next(e)
    // An agent type with a model of its own is gated on the asked or the parent's: the plugin API does not tell its type's model.
    const refusal = agentRefusal(currentLimits(), currentSpent(), claudeModel(e.model ?? e.parentModel))
    if (refusal !== undefined) return { deny: `crew: ${refusal}` }
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined) {
      claudeAgents.started({
        id: spawned.agentId,
        type: e.subagentType,
        description: e.description,
        model: spawned.model,
        ...(e.workflow === undefined ? {} : { workflow: e.workflow.runId }),
        startedAt: await $.clock.now(),
      })
      await $.fs.write(promptPath(spawned.agentId), e.prompt)
      await keep($)
    }
    return spawned
  })

  on('ui.message', { element: OVERVIEW_KEY }, async ($, e, next) => {
    const data = e.data as {
      tab?: unknown
      page?: unknown
      raise?: unknown
      toggle?: unknown
      switchLimits?: unknown
      stop?: { run?: unknown; key?: unknown }
      open?: { run?: unknown; agent?: unknown }
    }
    if (data.switchLimits === true) {
      record.isLimitsOff = !record.isLimitsOff
      await keep($)
    }
    if (data.tab === 'running' || data.tab === 'log' || data.tab === 'limits') view = { tab: data.tab, page: 0 }
    if (data.page === 1 || data.page === -1) view = { ...view, page: Math.max(0, view.page + data.page) }
    if (data.raise === 'reviewRuns') {
      record.raises = { ...record.raises, reviewRuns: record.raises.reviewRuns + RAISE_BY.reviewRuns }
      await keep($)
    }
    const raised = (data.raise as { model?: unknown } | undefined)?.model
    if (typeof raised === 'string') {
      record.raises = { ...record.raises, models: { ...record.raises.models, [raised]: (record.raises.models[raised] ?? 0) + RAISE_BY.model } }
      await keep($)
    }
    if (typeof data.toggle === 'string' && (GATES as readonly string[]).includes(data.toggle)) {
      const gate = data.toggle as Gate
      record.closed = record.closed.includes(gate) ? record.closed.filter(g => g !== gate) : [...record.closed, gate]
      await keep($)
    }
    if (typeof data.stop?.run === 'string') {
      const key = typeof data.stop.key === 'string' ? data.stop.key : undefined
      for (const r of runs.get(data.stop.run)?.reviewers ?? []) {
        if (r.status === 'running' && (key === undefined || key === r.key)) stopReviewer(data.stop.run, r.key)
      }
    }
    if (typeof data.open?.run === 'string') await open($, { run: data.open.run })
    if (typeof data.open?.agent === 'string') await open($, { agent: data.open.agent })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.message', { element: DETAIL_KEY }, async ($, e, next) => {
    if ((e.data as { close?: unknown }).close === true) {
      detail = null
      await $.sidebar.popout({ id: TAB_ID, isShown: false })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: [...ROW_COMPONENTS] }, async ($, e, next) => {
    const tree = await next(e)
    if (e.surface !== 'terminal') return tree
    const isDrawer = hasSlot(tree, DRAWER_SLOT)
    const shown = detail !== null && hasSlot(tree, POPOUT_SLOT) ? detail : null
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
        sessionRuns: sessionRuns(),
        agents: claudeAgents.all(),
        record,
        limits: settings.limits,
      })
      const height = Math.min(room.drawer, overviewLines(props).length)
      filled = fillSlot(filled, DRAWER_SLOT, () => Client({ key: OVERVIEW_KEY, module: './overview.ts', props, width: OVERVIEW_COLUMNS, height }))
    }
    const shownNow = shown === null ? null : shownDetail(shown, now)
    if (shown !== null && shownNow !== null) {
      const props = detailProps(shownNow.title, shownNow.text, shown.path, room.popout)
      filled = fillSlot(filled, POPOUT_SLOT, () => Client({ key: DETAIL_KEY, module: './detail.ts', props, width: OVERVIEW_COLUMNS, height: props.lines.length + 1 }))
    }
    return filled as typeof tree
  })

  on('agent.offer', { agent: 'crew:reviewer' }, () => ({ isOffered: claude.isOffered() }))
  on('agent.offer', { agent: 'crew:reviewer-web' }, () => ({ isOffered: claude.isOffered() }))

  on('tool.call', { tool: 'mcp__crew__review' }, ($, e, next) => answer(startReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__crew__review_continue' }, ($, e, next) => answer(continueReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__crew__review_status' }, ($, e) => answer(status($, fields(e))))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const fence = await claude.fenceFor(ioOf($), e.agentId)
    if (fence === 'not-ours') return next(e)
    if (fence === undefined) return { deny: 'crew: this reviewer has no read limits in place' }
    const refusal = await claude.readRefusal(ioOf($), fence, e.file_path)
    if (refusal !== undefined) return { deny: `crew: ${refusal}` }
    await $.fs.write(claude.approvedMark(approvedDir(), e.tool_use_id), '')
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'crew: the read guard failed' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const fence = await claude.fenceFor(ioOf($), e.agentId)
    if (fence === 'not-ours') return next(e)
    if (fence === undefined) return { deny: 'crew: this reviewer has no read limits in place' }
    const command = claude.fencedCommand(fence, e.command)
    if (command === undefined) return { deny: 'crew: this review may read nothing on disk' }
    await $.fs.write(claude.approvedMark(approvedDir(), e.tool_use_id), '')
    return next({ ...e, command, run_in_background: false })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'crew: the shell guard failed' }))

  on('tool.check', async ($, e, next) => {
    if (e.agentId === undefined || (e.tool !== 'Read' && e.tool !== 'Bash')) return next(e)
    if (!claude.fences.has(e.agentId)) return next(e)
    return { decision: 'allow', reason: 'crew: a fenced reviewer call' }
  })

  on('turn.complete', async ($, e, next) => {
    const tokens = e.usage === undefined ? undefined : claudeTokens(e.usage)
    if (e.agentId === undefined) {
      record.turns += 1
      if (tokens !== undefined) record.main = { in: record.main.in + tokens.in, cached: record.main.cached + tokens.cached, out: record.main.out + tokens.out }
      await keep($)
    } else {
      claude.settle(e.agentId, { answer: e.answer, reason: e.reason, usage: e.usage })
      if (claudeAgents.finished(e.agentId, e.reason === 'answer', tokens, await $.clock.now())) await keep($)
    }
    return next(e)
  })
}
