import type { Io } from './io.ts'

import type { FollowUp, Job, Outcome } from './job.ts'
import { describeEnd, run } from './proc.ts'
import { FINDINGS_SCHEMA, parseFindings } from './prompt.ts'
import { folderOf, isInside, isWindowsPath, join } from './scope.ts'

const SIGNED_OUT = /\b401\b|authentication_error|invalid (x-)?api.?key|not logged in|please run \/login/i
const QUOTA = /\b429\b|rate.?limit|usage limit|quota|insufficient (balance|credit)/i

/** A path as Claude Code's rules spell an absolute one: `//tmp/x`, and `//c/Users/x` for `C:\Users\x`. */
export function rulePath(path: string): string {
  if (!isWindowsPath(path)) return `/${path}`
  const posix = path.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\//.exec(posix)
  return drive === null ? `/${posix}` : `//${drive[1]!.toLowerCase()}/${posix.slice(3)}`
}

const denyFile = (path: string) => [`Read(${rulePath(path)})`]
const denyTree = (path: string) => [`Read(${rulePath(path)})`, `Read(${rulePath(path)}/**)`]

/**
 * The folders the reviewer may read: each folder root, and the folder of each file root. A file root's folder comes in
 * whole, so its other entries are returned to be denied, short of the way down to another root.
 */
export async function readDirs(io: Io, roots: readonly string[], files: readonly string[]): Promise<{ dirs: string[]; closed: string[] }> {
  const dirs = [...new Set(roots.map(r => folderOf(r, files)))]
  const closed: string[] = []
  for (const dir of dirs) {
    if (roots.some(r => !files.includes(r) && isInside(dir, r))) continue
    for (const entry of await io.list(dir)) {
      const path = join(dir, entry.name)
      if (roots.some(r => isInside(r, path))) continue
      closed.push(...(entry.kind === 'dir' ? denyTree(path) : denyFile(path)))
    }
  }
  return { dirs, closed }
}

/**
 * The reviewer's own settings, given with --settings: denied are secret files, every entry beside a file root, the
 * person's sessions, tasks and teams in Claude Code's config folder, and its credentials. Web reads are allowed only
 * with `web`, as a dontAsk run refuses what would ask.
 */
function settings(j: Omit<Job, 'task'>, closed: readonly string[], configDir: string): string {
  const deny = [
    ...j.secrets.flatMap(denyFile),
    ...closed,
    ...['projects', 'tasks', 'teams'].flatMap(d => denyTree(join(configDir, d))),
    ...denyFile(join(configDir, '.credentials.json')),
  ]
  return JSON.stringify({ permissions: { deny, allow: j.web ? ['WebFetch', 'WebSearch'] : [] } }, null, 2)
}

/**
 * The folder the child runs in, empty and its own, with every root added beside it: Read opens Claude's temp files of
 * the working folder without a rule, which in a project's folder are those of the person's sessions there. A resume
 * needs the same folder.
 */
async function workDir(io: Io, stateDir: string): Promise<string> {
  await io.write(`${stateDir}/work/.keep`, '')
  return `${stateDir}/work`
}

type Seen = { session?: string; model?: string; result?: Record<string, unknown> }

function watch(seen: Seen) {
  return (line: string) => {
    if (line.trim() === '') return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (typeof ev.session_id === 'string') seen.session = ev.session_id
      if (typeof ev.model === 'string') seen.model = ev.model
    }
    if (ev.type === 'result') seen.result = ev
  }
}

async function execute(io: Io, command: readonly string[], j: Omit<Job, 'task'>, stateDir: string, message: string, resume: string | undefined, configDir: string): Promise<Outcome> {
  const { dirs, closed } = await readDirs(io, j.roots, j.files)
  await io.write(`${j.dir}/settings.json`, settings(j, closed, configDir))
  await io.write(`${j.dir}/system.md`, j.system)
  const tools = ['Read', 'Grep', 'Glob', ...(j.web ? ['WebSearch', 'WebFetch'] : [])]
  const argv = [
    ...command,
    '-p',
    // no Bash or other code-running tools, no settings files but these, file tools confined to the working folders
    '--restricted',
    // no CLAUDE.md, plugins, hooks or MCP servers of the person's
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    tools.join(','),
    '--disallowedTools',
    'mcp__*',
    '--permission-mode',
    'dontAsk',
    ...dirs.flatMap(d => ['--add-dir', d]),
    '--settings',
    `${j.dir}/settings.json`,
    '--system-prompt-file',
    `${j.dir}/system.md`,
    '--json-schema',
    JSON.stringify(FINDINGS_SCHEMA),
    '--output-format',
    'stream-json',
    '--verbose',
    ...(j.model !== undefined ? ['--model', j.model] : []),
    ...(j.effort !== undefined ? ['--effort', j.effort] : []),
    ...(resume !== undefined ? ['--resume', resume] : []),
  ]
  const cwd = await workDir(io, stateDir)
  const seen: Seen = {}
  // the person's mods, which --safe-mode keeps from running, aren't handed on either
  const r = await run(io, { argv, cwd, input: message, env: { CLAUDE_CODE_PLUGIN_DIRS: '' } }, { timeoutMs: j.timeoutMs, signal: j.signal, onLine: watch(seen) })
  await io.write(`${j.dir}/events.jsonl`, r.stdout)
  await io.write(`${j.dir}/stderr.txt`, r.stderr)
  const res = seen.result
  const structured = res?.structured_output
  const text = structured !== undefined && structured !== null ? JSON.stringify(structured) : typeof res?.result === 'string' ? res.result : ''
  const base = { model: seen.model ?? j.model ?? 'default', usage: res?.usage, continueId: seen.session ?? resume }
  if (r.ended.kind === 'timeout') return { ...base, status: 'timeout', text, detail: `no answer within ${j.timeoutMs / 1000} s` }
  if (r.ended.kind === 'aborted') return { ...base, status: 'stopped', text }
  if (res?.subtype === 'success' && res.is_error !== true && text.trim() !== '') {
    return { ...base, status: 'ok', text, findings: parseFindings(text) }
  }
  const said = `${typeof res?.result === 'string' ? res.result : ''}\n${res?.api_error_status ?? ''}\n${r.stderr}`
  const detail = (typeof res?.result === 'string' && res.result.trim() !== '' ? res.result : `${describeEnd(r)}: ${r.stderr.trim().slice(-500)}`).slice(-500)
  if (SIGNED_OUT.test(said)) return { ...base, status: 'signed_out', text, detail: `${command[0]} was refused its credentials: ${detail}` }
  if (QUOTA.test(said)) return { ...base, status: 'quota', text, detail }
  return { ...base, status: 'failed', text, detail: res === undefined ? `no result from ${command[0]}: ${detail}` : `${String(res.subtype)}: ${detail}` }
}

/** `command`: the program and its first arguments, from reviewers.json; `configDir`: Claude Code's config folder. */
export async function review(io: Io, command: readonly string[], j: Job, configDir: string): Promise<Outcome> {
  return execute(io, command, j, j.dir, j.task, undefined, configDir)
}

export async function followUp(io: Io, command: readonly string[], f: FollowUp, configDir: string): Promise<Outcome> {
  return execute(io, command, f, f.stateDir, f.message, f.continueId, configDir)
}
