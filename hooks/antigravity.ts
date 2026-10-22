import type { Io } from './io.ts'

import type { FollowUp, Job, Outcome, Preflight } from './job.ts'
import { describeEnd, run } from './proc.ts'
import { FINDINGS_SCHEMA, parseFindings } from './prompt.ts'
import { siblingsOf } from './scope.ts'

export const AGENT = 'crew-reviewer'

const SIGNED_OUT = /Authentication required|authentication failed|Authentication expired|not logged in/i
const QUOTA = /quota|credits balance|RESOURCE_EXHAUSTED|rate limit|usage limit/i

type Paths = { home: string; work: string }

const paths = (stateDir: string): Paths => ({ home: `${stateDir}/home`, work: `${stateDir}/work` })

function agentFile(system: string, web: boolean, helpers: boolean): string {
  const tools = ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'finish']
  if (web) tools.push('search_web', 'read_url_content')
  if (helpers) tools.push('invoke_subagent')
  return [
    '---',
    `name: ${AGENT}`,
    'description: Read-only reviewer run by crew',
    `tools: [${tools.join(', ')}]`,
    'excludeDefaultComponents: true',
    'inheritCustomizations: false',
    '---',
    '# Reviewer',
    '',
    system,
    '',
  ].join('\n')
}

/**
 * Deny rules beat allow rules here, so the disk is closed by denying every path beside the
 * way down to the read roots and to the reviewer's own working folder.
 */
async function settings(io: Io, j: Omit<Job, 'task'>, p: Paths): Promise<string> {
  const siblings = await siblingsOf(io, [...j.roots, p.work])
  const deny = ['write_file(*)', ...j.secrets.map(s => `read_file(${s})`), ...siblings.map(s => `read_file(${s})`)]
  if (!j.web) deny.push('read_url(*)')
  return JSON.stringify({ permissions: { deny } }, null, 2)
}

async function prepare(io: Io, j: Omit<Job, 'task'>, p: Paths): Promise<void> {
  await io.write(`${p.home}/.gemini/antigravity-cli/settings.json`, await settings(io, j, p))
  await io.write(`${p.work}/.agents/agents/${AGENT}/agent.md`, agentFile(j.system, j.web, j.helpers))
}

export async function preflight(io: Io, bin: string, home: string): Promise<Preflight> {
  let r
  try {
    r = await run(io, { argv: [bin, '-p', '/quota'], env: { HOME: home } }, { timeoutMs: 20_000 })
  } catch (err) {
    return { ok: false, status: 'failed', detail: `agy did not run: ${String(err)}` }
  }
  const said = r.stdout + r.stderr
  if (SIGNED_OUT.test(said)) {
    return { ok: false, status: 'signed_out', detail: 'Antigravity is signed out: run `agy` once in a terminal and sign in' }
  }
  if (r.ended.kind === 'exited' && r.ended.code === 0 && /Limit/.test(r.stdout)) return { ok: true }
  return { ok: false, status: 'failed', detail: `agy -p /quota: ${describeEnd(r)}: ${said.trim().slice(-500)}` }
}

type Seen = { conversation?: string; result?: Record<string, unknown>; toolErrors: number }

function watch(seen: Seen) {
  return (line: string) => {
    if (line.trim() === '') return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.event === 'init' && typeof ev.conversation_id === 'string') seen.conversation = ev.conversation_id
    if (ev.event === 'result') seen.result = ev.result as Record<string, unknown>
    if (ev.event === 'step_update') {
      const s = ev.step_update as Record<string, unknown> | undefined
      if (s?.state === 'ERROR' && s.step_type === 'tool') seen.toolErrors++
    }
  }
}

async function execute(
  io: Io,
  bin: string,
  j: Omit<Job, 'task'>,
  p: Paths,
  message: string,
  conversation: string | undefined,
): Promise<Outcome> {
  await io.write(`${j.dir}/schema.json`, JSON.stringify(FINDINGS_SCHEMA, null, 2))
  const argv = [
    bin,
    '-p',
    message,
    ...(conversation !== undefined ? ['--conversation', conversation] : ['--agent', AGENT]),
    '--output-format',
    'stream-json',
    '--json-schema',
    `${j.dir}/schema.json`,
    ...j.roots.flatMap(r => ['--add-dir', r]),
    ...(j.model !== undefined ? ['--model', j.model] : []),
    ...(j.effort !== undefined ? ['--effort', j.effort] : []),
  ]
  const seen: Seen = { toolErrors: 0 }
  const r = await run(io, { argv, cwd: p.work, env: { HOME: p.home } }, { timeoutMs: j.timeoutMs, signal: j.signal, onLine: watch(seen) })
  await io.write(`${j.dir}/events.jsonl`, r.stdout)
  await io.write(`${j.dir}/stderr.txt`, r.stderr)
  const res = seen.result
  const text = typeof res?.response === 'string' ? res.response : ''
  const base = { model: j.model ?? 'default', usage: res?.usage, continueId: seen.conversation ?? (res?.conversation_id as string | undefined) }
  if (r.ended.kind === 'timeout') return { ...base, status: 'timeout', text, detail: `no answer within ${j.timeoutMs / 1000} s` }
  if (r.ended.kind === 'aborted') return { ...base, status: 'stopped', text }
  const error = typeof res?.error === 'string' ? res.error : ''
  const said = `${error}\n${r.stderr}`
  if (SIGNED_OUT.test(said)) {
    return { ...base, status: 'signed_out', text, detail: 'Antigravity is signed out: run `agy` once in a terminal and sign in' }
  }
  const denied = Array.isArray(res?.denied_actions) ? res.denied_actions : []
  if (res?.status === 'SUCCESS' && text.trim() === '' && denied.length > 0) {
    return { ...base, status: 'left_roots', text, detail: `it reached outside its read paths and the run ended: ${JSON.stringify(denied)}` }
  }
  if (res?.status === 'SUCCESS' && text.trim() !== '') {
    return { ...base, status: 'ok', text, findings: parseFindings(text) }
  }
  const detail = error !== '' ? error : `${describeEnd(r)}: ${r.stderr.trim().slice(-500)}`
  if (QUOTA.test(said)) return { ...base, status: 'quota', text, detail }
  return { ...base, status: 'failed', text, detail }
}

const RETRY_NOTE =
  'Your previous attempt at this brief ended because it reached for a path outside the ones you may read. Read only inside them; do not list or open their parent folders.'

export async function review(io: Io, bin: string, j: Job): Promise<Outcome> {
  const p = paths(j.dir)
  await prepare(io, j, p)
  const first = await execute(io, bin, j, p, j.task, undefined)
  if (first.status !== 'left_roots') return first
  const retry = await execute(io, bin, { ...j, dir: `${j.dir}/retry` }, p, `${RETRY_NOTE}\n\n${j.task}`, undefined)
  return retry.status === 'left_roots' ? { ...retry, detail: `twice: ${retry.detail}` } : retry
}

export async function followUp(io: Io, bin: string, f: FollowUp): Promise<Outcome> {
  const p = paths(f.stateDir)
  await prepare(io, f, p)
  return execute(io, bin, f, p, f.message, f.continueId)
}
