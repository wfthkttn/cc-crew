import type { Io } from './io.ts'

import * as agy from './antigravity.ts'
import * as claudeP from './claude-p.ts'
import * as codex from './codex.ts'
import type { Kind, Provider, Settings } from './config.ts'
import type { FollowUp, Job, Outcome, Preflight, Status } from './job.ts'
import { sum } from './limits.ts'
import { renderFindings } from './prompt.ts'
import { type Tokens, tokensOf } from './usage.ts'

/** `command`: a reviewer from reviewers.json, the command it was started with; follow-ups reuse it. */
export type ReviewerSpec = { provider: Provider; model?: string; effort?: string; command?: string[] }

export function kindOf(r: ReviewerSpec): Kind {
  if (r.provider === 'claude' || r.command !== undefined) return 'claude-p'
  if (r.provider === 'codex' || r.provider === 'antigravity') return r.provider
  throw new Error(`crew: reviewer ${r.provider} has no command and is no built-in`)
}

/** The Claude reviewer runs the `claude_bin` setting; the others, the command their reviewers.json entry gave. */
function commandOf(r: ReviewerSpec, s: Settings): string[] {
  if (r.provider === 'claude') return [s.claudeBin]
  if (r.command === undefined) throw new Error(`crew: reviewer ${r.provider} has no command`)
  return r.command
}

export type ReviewerState = ReviewerSpec & {
  /** Unique within the run: `<provider>-<model>`, numbered on a repeat. */
  key: string
  status: Status | 'running'
  usedModel?: string
  detail?: string
  continueId?: string
  /** The folder its harness state lives in; follow-ups reuse it. */
  dir: string
  report?: string
  findings?: number
  /** What its turns spent, follow-ups included, as its provider reported each. */
  tokens?: Tokens
  startedAt: number
  endedAt?: number
}

export type Run = {
  id: string
  description: string
  createdAt: number
  /** Where the reports go: `<report dir>/<slug>`. */
  reportDir: string
  /** Raw harness output and state. */
  runDir: string
  roots: string[]
  /** The roots that are files; absent in runs from before a file could be a read path. */
  files?: string[]
  secrets: string[]
  web: boolean
  helpers: boolean
  changes?: string
  reviewers: ReviewerState[]
  courier?: string
  /** The session that started it; absent in runs from before runs knew theirs. */
  sessionId?: string
}

export const runs = new Map<string, Run>()

/** How to stop each reviewer still running in this load, by `<run id>/<key>`. */
const stops = new Map<string, () => void>()

const stopKey = (run: Run, r: ReviewerState) => `${run.id}/${r.key}`

/** A signal that fires on `outer` or on the reviewer's stop, which this registers until `disarm`. */
function arming(run: Run, r: ReviewerState, outer?: AbortSignal): AbortSignal {
  const controller = new AbortController()
  if (outer?.aborted) controller.abort()
  outer?.addEventListener('abort', () => controller.abort())
  stops.set(stopKey(run, r), () => controller.abort())
  return controller.signal
}

function disarm(run: Run, r: ReviewerState): void {
  stops.delete(stopKey(run, r))
}

/** Stops a running reviewer: its child process is killed. */
export function stopReviewer(runId: string, key: string): boolean {
  const stop = stops.get(`${runId}/${key}`)
  if (stop === undefined) return false
  stop()
  return true
}

export function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug === '' ? 'review' : slug
}

export function keysFor(specs: readonly ReviewerSpec[]): string[] {
  const used = new Map<string, number>()
  return specs.map(s => {
    const base = `${s.provider}-${slugOf(s.model ?? 'default')}`
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}

export async function save(io: Io, run: Run): Promise<void> {
  const text = JSON.stringify(run, null, 2)
  await io.write(`${run.runDir}/run.json`, text)
  await io.write(`${run.reportDir}/run.json`, text)
}

/**
 * A run this module holds, or one read from disk. Reviewers still marked running on disk were
 * cut off when an earlier load of crew ended (a reload, the session's end): they are marked
 * stopped, as nothing is left to finish them.
 */
export async function load(io: Io, cacheDir: string, id: string): Promise<Run> {
  const known = runs.get(id)
  if (known !== undefined) return known
  const path = `${cacheDir}/runs/${id}/run.json`
  if (!(await io.exists(path))) throw new Error(`crew: no review run ${id}`)
  const run = JSON.parse(await io.read(path)) as Run
  const cut = run.reviewers.filter(r => r.status === 'running')
  for (const r of cut) {
    r.status = 'stopped'
    r.detail = 'cut off: crew reloaded or the session ended before it finished'
  }
  if (cut.length > 0) await save(io, run)
  runs.set(id, run)
  return run
}

async function preflight(io: Io, s: Settings, kind: Kind, cacheDir: string): Promise<Preflight> {
  switch (kind) {
    case 'codex':
      return codex.preflight(io, s.codexBin)
    case 'antigravity':
      return agy.preflight(io, s.agyBin, `${cacheDir}/agy-home`)
    case 'claude-p':
      return { ok: true }
  }
}

function job(run: Run, r: ReviewerState, system: string, task: string, s: Settings, signal?: AbortSignal): Job {
  return {
    dir: r.dir,
    roots: run.roots,
    files: run.files ?? [],
    secrets: run.secrets,
    system,
    task,
    web: run.web,
    helpers: run.helpers,
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.effort !== undefined ? { effort: r.effort } : {}),
    timeoutMs: s.timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  }
}

function header(run: Run, r: ReviewerState, o: Outcome, asked?: string): string {
  const lines = [
    `# ${run.description}: ${r.provider} (${o.model})`,
    '',
    `- Run: ${run.id}, status: ${o.status}${o.detail !== undefined ? ` (${o.detail})` : ''}`,
    `- Effort: ${r.effort ?? 'default'}; read: ${run.roots.length > 0 ? run.roots.join(', ') : 'nothing'}; web: ${run.web ? 'on' : 'off'}`,
  ]
  if (run.changes !== undefined) lines.push(`- Change: ${run.changes}`)
  if (asked !== undefined) lines.push('', `## Follow-up asked`, '', asked)
  return lines.join('\n')
}

async function report(io: Io, run: Run, r: ReviewerState, o: Outcome, name: string, asked?: string): Promise<string> {
  const body = o.findings !== undefined ? renderFindings(o.findings) : o.text.trim() !== '' ? `## Answer (not in the findings format)\n\n${o.text}` : ''
  const path = `${run.reportDir}/${name}.md`
  await io.write(path, `${header(run, r, o, asked)}\n\n${body}\n`)
  return path
}

function apply(r: ReviewerState, o: Outcome, endedAt: number): void {
  r.status = o.status
  r.usedModel = o.model
  r.endedAt = endedAt
  if (o.detail !== undefined) r.detail = o.detail
  if (o.continueId !== undefined) r.continueId = o.continueId
  if (o.findings !== undefined) r.findings = o.findings.findings.length
  const tokens = tokensOf(kindOf(r), o.usage)
  if (tokens !== undefined) r.tokens = r.tokens === undefined ? tokens : sum([r.tokens, tokens])
}

/** Tells the person a provider needs them; answers why the message failed, or undefined. */
export type Alert = (io: Io, provider: Provider, detail: string) => Promise<string | undefined>

async function runOne(
  io: Io,
  run: Run,
  r: ReviewerState,
  s: Settings,
  system: string,
  task: string,
  cacheDir: string,
  alert: Alert,
  signal?: AbortSignal,
): Promise<void> {
  let o: Outcome
  const kind = kindOf(r)
  const stopped = arming(run, r, signal)
  const pre = await preflight(io, s, kind, cacheDir)
  if (!pre.ok) {
    o = { status: pre.status, text: '', model: r.model ?? 'default', detail: pre.detail }
  } else {
    const j = job(run, r, system, task, s, stopped)
    try {
      switch (kind) {
        case 'codex':
          o = await codex.review(io, s.codexBin, j)
          break
        case 'antigravity':
          o = await agy.review(io, s.agyBin, j)
          break
        case 'claude-p':
          o = await claudeP.review(io, commandOf(r, s), j, s.claudeConfigDir, r.provider === 'claude')
          break
      }
    } catch (err) {
      o = { status: 'failed', text: '', model: r.model ?? 'default', detail: String(err) }
    }
  }
  disarm(run, r)
  apply(r, o, await io.now())
  r.report = await report(io, run, r, o, r.key)
  if (o.status === 'signed_out' || o.status === 'quota') {
    const failed = await alert(io, r.provider, o.detail ?? o.status)
    if (failed !== undefined) run.courier = failed
  }
}

export async function execute(
  io: Io,
  run: Run,
  s: Settings,
  system: string,
  task: string,
  cacheDir: string,
  alert: Alert,
  signal?: AbortSignal,
): Promise<void> {
  runs.set(run.id, run)
  await save(io, run)
  await Promise.all(run.reviewers.map(r => runOne(io, run, r, s, system, task, cacheDir, alert, signal)))
  await save(io, run)
}

export type Asked = { f: FollowUp; n: string }

/** Marks the reviewer running and readies its follow-up. */
export async function ask(
  io: Io,
  run: Run,
  r: ReviewerState,
  s: Settings,
  system: string,
  message: string,
  signal?: AbortSignal,
): Promise<Asked> {
  if (r.continueId === undefined) throw new Error(`crew: ${r.key} in run ${run.id} has no conversation to continue`)
  const n = (await io.now()).toString(36)
  const f: FollowUp = {
    ...job(run, r, system, '', s, signal),
    dir: `${r.dir}/followup-${n}`,
    continueId: r.continueId,
    message,
    stateDir: r.dir,
  }
  r.status = 'running'
  r.startedAt = await io.now()
  await save(io, run)
  return { f: { ...f, signal: arming(run, r, signal) }, n }
}

export async function continueOne(io: Io, run: Run, r: ReviewerState, s: Settings, asked: Asked, alert: Alert): Promise<void> {
  const { f, n } = asked
  const message = f.message
  let o: Outcome
  try {
    switch (kindOf(r)) {
      case 'codex':
        o = await codex.followUp(io, s.codexBin, f)
        break
      case 'antigravity':
        o = await agy.followUp(io, s.agyBin, f)
        break
      case 'claude-p':
        o = await claudeP.followUp(io, commandOf(r, s), f, s.claudeConfigDir, r.provider === 'claude')
        break
    }
  } catch (err) {
    o = { status: 'failed', text: '', model: r.usedModel ?? 'default', detail: String(err) }
  }
  disarm(run, r)
  apply(r, o, await io.now())
  r.report = await report(io, run, r, o, `${r.key}-followup-${n}`, message)
  if (o.status === 'signed_out' || o.status === 'quota') {
    const failed = await alert(io, r.provider, o.detail ?? o.status)
    if (failed !== undefined) run.courier = failed
  }
  await save(io, run)
}

const LOUD: Partial<Record<Status | 'running', string>> = {
  signed_out: 'SIGNED OUT',
  quota: 'OUT OF QUOTA',
  failed: 'FAILED',
  timeout: 'TIMED OUT',
  stopped: 'STOPPED',
  left_roots: 'LEFT ITS READ PATHS',
}

/** What the caller reads when the run ends: one line per reviewer, then the report paths. */
export function summary(run: Run): string {
  const counts = new Map<string, number>()
  for (const r of run.reviewers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(', ')
  const lines = [`crew review ${run.id} "${run.description}": ${run.reviewers.length} reviewers, ${tally}.`]
  for (const r of run.reviewers) {
    const loud = LOUD[r.status]
    const what = loud !== undefined ? `${loud}: ${r.detail ?? ''}` : r.status === 'ok' ? `${r.findings ?? 'unparsed'} findings` : r.status
    lines.push(`- ${r.key} (${r.usedModel ?? r.model ?? 'default'}): ${what}${r.report !== undefined ? ` → ${r.report}` : ''}`)
  }
  if (run.courier !== undefined) lines.push(`Courier alert failed: ${run.courier}`)
  lines.push(`Continue a reviewer with review_continue { run: "${run.id}", reviewer: "<key>", message }.`)
  return lines.join('\n')
}
