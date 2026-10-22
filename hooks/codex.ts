import type { Io } from './io.ts'

import type { FollowUp, Job, Outcome, Preflight } from './job.ts'
import { describeEnd, run } from './proc.ts'
import { FINDINGS_SCHEMA, parseFindings } from './prompt.ts'

const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/*.env', '**/*.pem', '**/*.key']

const toml = (s: string) => JSON.stringify(s)

/**
 * The permission profile: system tools and the read roots readable, secrets denied, nothing
 * writable. With no `:root` entry the sandbox starts from an empty filesystem.
 */
export function profile(roots: readonly string[], secrets: readonly string[]): string {
  const entries = [`${toml(':minimal')}=${toml('read')}`]
  if (roots.length > 0) {
    const scoped = [`${toml('.')}=${toml('read')}`, ...SECRET_GLOBS.map(g => `${toml(g)}=${toml('deny')}`)]
    entries.push(`${toml(':workspace_roots')}={${scoped.join(', ')}}`)
  }
  for (const r of roots.slice(1)) entries.push(`${toml(r)}=${toml('read')}`)
  for (const s of secrets) entries.push(`${toml(s)}=${toml('deny')}`)
  return `{${entries.join(', ')}}`
}

function options(bin: string, j: Omit<Job, 'task'>, cwd: string): string[] {
  return [
    bin,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-C',
    cwd,
    '-c',
    'default_permissions="crew"',
    '-c',
    `permissions.crew.filesystem=${profile(j.roots, j.secrets)}`,
    '-c',
    'approval_policy="never"',
    '-c',
    `web_search=${toml(j.web ? 'live' : 'disabled')}`,
    '-c',
    `developer_instructions=${toml(j.system)}`,
    '-c',
    'project_doc_max_bytes=0',
    ...(j.model !== undefined ? ['-m', j.model] : []),
    ...(j.effort !== undefined ? ['-c', `model_reasoning_effort=${toml(j.effort)}`] : []),
    ...(j.helpers ? [] : ['--disable', 'multi_agent']),
    '--output-schema',
    `${j.dir}/schema.json`,
    '-o',
    `${j.dir}/answer.txt`,
  ]
}

export async function preflight(io: Io, bin: string): Promise<Preflight> {
  let r
  try {
    r = await io.run([bin, 'login', 'status'], { timeoutMs: 20_000 })
  } catch (err) {
    return { ok: false, status: 'failed', detail: `codex did not run: ${String(err)}` }
  }
  if (r.exitCode === 0) return { ok: true }
  const said = (r.stdout + r.stderr).trim()
  if (/not logged in/i.test(said)) {
    return { ok: false, status: 'signed_out', detail: 'Codex is signed out: run `codex login --device-auth`' }
  }
  return { ok: false, status: 'failed', detail: `codex login status: exit ${r.exitCode}: ${said.slice(-500)}` }
}

type Seen = { thread?: string; last: string; usage?: unknown; failure?: string; signedOut: boolean; quota: boolean }

function watch(seen: Seen) {
  return (line: string) => {
    if (line.trim() === '') return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    const message = (x: unknown) => (typeof x === 'string' ? x : '')
    switch (ev.type) {
      case 'thread.started':
        seen.thread = message(ev.thread_id)
        break
      case 'item.completed': {
        const item = ev.item as Record<string, unknown> | undefined
        if (item?.type === 'agent_message') seen.last = message(item.text)
        break
      }
      case 'turn.completed':
        seen.usage = ev.usage
        break
      case 'turn.failed':
        seen.failure = message((ev.error as Record<string, unknown> | undefined)?.message)
        break
      case 'error': {
        const text = message(ev.message)
        seen.failure = text
        if (/401 Unauthorized|refresh token|log out and sign in|not logged in/i.test(text)) seen.signedOut = true
        if (/usage limit|rate limit|quota/i.test(text)) seen.quota = true
        break
      }
    }
    if (seen.failure !== undefined && /usage limit/i.test(seen.failure)) seen.quota = true
  }
}

async function execute(io: Io, argv: string[], cwd: string, input: string, j: Omit<Job, 'task'>): Promise<Outcome> {
  await io.write(`${j.dir}/schema.json`, JSON.stringify(FINDINGS_SCHEMA, null, 2))
  const seen: Seen = { last: '', signedOut: false, quota: false }
  const model = j.model ?? 'default'
  const r = await run(io, { argv, cwd, input }, { timeoutMs: j.timeoutMs, signal: j.signal, onLine: watch(seen) })
  await io.write(`${j.dir}/events.jsonl`, r.stdout)
  await io.write(`${j.dir}/stderr.txt`, r.stderr)
  const base = { model, usage: seen.usage, continueId: seen.thread }
  if (r.ended.kind === 'timeout') return { ...base, status: 'timeout', text: seen.last, detail: `no answer within ${j.timeoutMs / 1000} s` }
  if (r.ended.kind === 'aborted') return { ...base, status: 'stopped', text: seen.last }
  const text = (await io.exists(`${j.dir}/answer.txt`)) ? await io.read(`${j.dir}/answer.txt`) : seen.last
  if (r.ended.code === 0 && text.trim() !== '') {
    return { ...base, status: 'ok', text, findings: parseFindings(text) }
  }
  const detail = seen.failure ?? `${describeEnd(r)}: ${r.stderr.trim().slice(-500)}`
  if (seen.signedOut) return { ...base, status: 'signed_out', text, detail: `Codex is signed out (${detail}): run \`codex login --device-auth\`` }
  if (seen.quota) return { ...base, status: 'quota', text, detail }
  return { ...base, status: 'failed', text, detail }
}

async function workDir(io: Io, roots: readonly string[], dir: string): Promise<string> {
  if (roots[0] !== undefined) return roots[0]
  await io.write(`${dir}/empty/.keep`, '')
  return `${dir}/empty`
}

export async function review(io: Io, bin: string, j: Job): Promise<Outcome> {
  const cwd = await workDir(io, j.roots, j.dir)
  return execute(io, [...options(bin, j, cwd), '-'], cwd, j.task, j)
}

export async function followUp(io: Io, bin: string, f: FollowUp): Promise<Outcome> {
  const cwd = await workDir(io, f.roots, f.dir)
  return execute(io, [...options(bin, f, cwd), 'resume', f.continueId, '-'], cwd, f.message, f)
}
