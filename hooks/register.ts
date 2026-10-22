import type { EngineInterface, Register } from 'claude-code'

import { type ChangeSpec, changeOf } from './changes.ts'
import * as claude from './claude.ts'
import { type Provider, type Settings, isProvider, settingsFrom } from './config.ts'
import type { Io } from './io.ts'
import { describeEnd, run as runChild } from './proc.ts'
import { REVIEWER_PROMPT, systemPrompt, taskText } from './prompt.ts'
import { type Alert, type ReviewerSpec, type Run, continueOne, execute, keysFor, load, runs, slugOf, summary } from './runs.ts'
import { type ReadSpec, findSecrets, isInside, resolveRoots } from './scope.ts'

const REVIEW_DESCRIPTION = `Get independent reviews from other models, each in its own harness: Codex (GPT models, ChatGPT plan), Antigravity (Gemini models, and Claude Opus/Sonnet 5.5 by model id, Google AI Pro plan) and a Claude reviewer subagent. Use it for a second opinion on code, a change, a design or a document.

Each reviewer reads only what \`read\` allows (the project by default), secret files (.env and the like) are always blocked, the rest of the disk is closed, and nothing is written except the reports. It runs in the background by default: you get the run id at once and a message with every reviewer's result when all are done. Do not poll or wait for it.

Brief it like a colleague who just walked into the room: the reviewers know nothing of this conversation. Say what to review, what matters, what you already know or suspect is out of scope. With \`changes\`, the diff is put in front of every reviewer.

Reports land in \`report_dir\` (default \`<project>/.claude/work/reviews\`), one folder per run, \`<provider>-<model>.md\` per reviewer. A reviewer that is signed out or out of quota is reported loudly and the others carry on.

Models: codex takes its own model names (default: Codex's default) and effort low|medium|high|xhigh. antigravity takes ids such as gemini-4-argon-high, gemini-3.8-flash-medium, claude-opus-5-5-high, claude-sonnet-5-5-medium, gpt-oss-120b-medium, or a model plus effort. claude takes sonnet|opus|haiku; its effort is the session's.`

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
    web: { type: 'boolean', description: 'Allow web search and page reads (default false)' },
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
  if (f.reviewers === undefined) return settings.reviewers.map(provider => ({ provider }))
  if (!Array.isArray(f.reviewers) || f.reviewers.length === 0) throw new BadInput('reviewers must be a non-empty list')
  return f.reviewers.map((r: Fields) => {
    if (typeof r.provider !== 'string' || !isProvider(r.provider)) throw new BadInput(`unknown provider: ${String(r.provider)}`)
    const spec: ReviewerSpec = { provider: r.provider as Provider }
    if (typeof r.model === 'string') spec.model = r.model
    if (typeof r.effort === 'string') spec.effort = r.effort
    return spec
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

function ioOf($: EngineInterface): Io {
  return {
    stat: (path, options) => $.fs.stat(path, options),
    list: path => $.fs.list(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    spawn: request => $.process.spawn(request),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    sleep: ms => $.clock.sleep(ms),
    agents: () => $.agent.list(),
    spawnAgent: args => $.agent.spawn(args),
    send: args => $.session.send(args),
    notify: async text => {
      await $.courier.thread({ key: 'crew', title: 'crew: reviewers' })
      await $.courier.enable({ thread: 'crew' })
      await $.courier.post({ thread: 'crew', text, group: 'attention' })
    },
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
    text = `crew ${label} failed: ${String(err)}`
  }
  await $.prompt.submit({ text })
}

async function startReview($: EngineInterface, f: Fields, signal: AbortSignal): Promise<string> {
  const description = str(f, 'description')
  const brief = str(f, 'prompt')
  const specs = reviewersOf(f)
  const read = readOf(f)
  const changes = changesOf(f)
  const web = f.web === true
  const helpers = f.helpers === true
  const background = f.background !== false
  const io = ioOf($)
  const project = await $.session.root()
  const base = reportBase(f, project)
  const roots = await resolveRoots(io, read, project)
  if (changes !== undefined && roots[0] === undefined) throw new BadInput('changes needs a read path holding the repository')
  const secrets = await findSecrets(io, roots)
  const change = changes !== undefined && roots[0] !== undefined ? await changeOf(io, roots[0], changes) : undefined
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
    secrets,
    web,
    helpers,
    ...(change !== undefined ? { changes: change.label } : {}),
    reviewers: specs.map((s, i) => ({ ...s, key: keys[i]!, status: 'running', dir: `${runDir}/${keys[i]!}`, startedAt: now })),
  }
  const task = taskText({ brief, roots, web, ...(change !== undefined ? { changes: change } : {}) })
  await $.fs.write(`${run.reportDir}/brief.md`, task)
  if (!background) {
    await execute(io, run, settings, system, task, cacheDir, alert, signal)
    return summary(run)
  }
  $.clock.after(0, () =>
    void finish($, `review ${id}`, async () => {
      await execute(io, run, settings, system, task, cacheDir, alert)
      return `crew review finished.\n${summary(run)}`
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
  if (f.background === false) {
    await continueOne(io, run, r, settings, system, message, alert, signal)
    return summary(run)
  }
  $.clock.after(0, () =>
    void finish($, `follow-up ${run.id}/${key}`, async () => {
      await continueOne(io, run, r, settings, system, message, alert)
      return `crew follow-up to ${key} finished.\n${summary(run)}`
    }),
  )
  return `Asked ${key} in run ${run.id}. Its answer arrives as a message.`
}

async function status($: EngineInterface, f: Fields): Promise<string> {
  const io = ioOf($)
  if (typeof f.run === 'string') return summary(await load(io, cacheDir, f.run))
  const lines = [...runs.values()].map(r => summary(r).split('\n')[0]!)
  if (lines.length === 0) lines.push('No crew reviews in this session.')
  const quota = await runChild(io, { argv: [settings.agyBin, '-p', '/quota'], env: { HOME: `${cacheDir}/agy-home` } }, { timeoutMs: 20_000 })
  lines.push('', 'Antigravity quota:', quota.ended.kind === 'exited' && quota.ended.code === 0 ? quota.stdout.trim() : `unavailable (${describeEnd(quota)})`)
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
    for (const spec of claude.agentSpecs(system)) await $.agent.register(spec)
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
    return started
  })

  on('agent.offer', { agent: 'crew:reviewer' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'crew:reviewer-web' }, () => ({ isOffered: false }))

  on('tool.call', { tool: 'mcp__crew__review' }, ($, e, next) => answer(startReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__crew__review_continue' }, ($, e, next) => answer(continueReview($, fields(e), next.signal)))
  on('tool.call', { tool: 'mcp__crew__review_status' }, ($, e) => answer(status($, fields(e))))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const fence = await claude.fenceFor(ioOf($), e.agentId)
    if (fence === 'not-ours') return next(e)
    if (fence === undefined) return { deny: 'crew: this reviewer has no read limits in place' }
    const refusal = await claude.readRefusal(ioOf($), fence, e.file_path)
    return refusal !== undefined ? { deny: `crew: ${refusal}` } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'crew: the read guard failed' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const fence = await claude.fenceFor(ioOf($), e.agentId)
    if (fence === 'not-ours') return next(e)
    if (fence === undefined) return { deny: 'crew: this reviewer has no read limits in place' }
    const command = claude.fencedCommand(fence, e.command)
    if (command === undefined) return { deny: 'crew: this review may read nothing on disk' }
    return next({ ...e, command, run_in_background: false })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'crew: the shell guard failed' }))

  on('tool.check', async ($, e, next) => {
    if (e.agentId === undefined || (e.tool !== 'Read' && e.tool !== 'Bash')) return next(e)
    if (!claude.fences.has(e.agentId)) return next(e)
    return { decision: 'allow', reason: 'crew: a fenced reviewer call' }
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) claude.settle(e.agentId, { answer: e.answer, reason: e.reason, usage: e.usage })
    return next(e)
  })
}
