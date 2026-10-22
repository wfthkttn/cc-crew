import type {
  AgentInfo,
  AgentSpawnArgs,
  AgentSpawnResult,
  FsEntry,
  HookStream,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  SessionSendArgs,
  SessionSendResult,
} from 'claude-code'

import type { Io } from '../hooks/io.ts'

/** What a fake child writes and how it ends; `hang` keeps it running until killed. */
export type Script = { stdout?: string[]; stderr?: string[]; code?: number; hang?: boolean; writes?: Record<string, string> }

export type Fake = Io & {
  files: Map<string, string>
  dirs: Set<string>
  spawned: ProcessSpawnRequest[]
  killed: number
  notified: string[]
  agentSpawns: AgentSpawnArgs[]
  sent: SessionSendArgs[]
  /** Runs every timer due by `ms` from now. */
  advance: (ms: number) => void
}

type Options = {
  files?: Record<string, string>
  dirs?: string[]
  spawn?: (r: ProcessSpawnRequest, n: number) => Script
  run?: (argv: readonly string[]) => ProcessRunResult
  agents?: AgentInfo[]
  spawnAgent?: (a: AgentSpawnArgs) => AgentSpawnResult
  notifyFails?: string
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

function stream(fake: Fake, s: Script): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  const chunks: ProcessSpawnChunk[] = [
    ...(s.stdout ?? []).map(text => ({ stream: 'stdout' as const, text })),
    ...(s.stderr ?? []).map(text => ({ stream: 'stderr' as const, text })),
  ]
  let closed = false
  let release: () => void = () => {}
  const end: ProcessSpawnResult = { code: s.code ?? 0, signal: null }
  const it = {
    async next(): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> {
      if (closed) return { done: true, value: { code: null, signal: 'SIGTERM' } }
      const chunk = chunks.shift()
      if (chunk !== undefined) return { done: false, value: chunk }
      if (s.hang === true) await new Promise<void>(r => (release = r))
      if (closed) return { done: true, value: { code: null, signal: 'SIGTERM' } }
      for (const [path, text] of Object.entries(s.writes ?? {})) fake.files.set(path, text)
      return { done: true, value: end }
    },
    async return(): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> {
      closed = true
      fake.killed++
      release()
      return { done: true, value: { code: null, signal: 'SIGTERM' } }
    },
    async throw(err: unknown): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> {
      throw err
    },
    [Symbol.asyncIterator]() {
      return it
    },
    result: Promise.resolve(end),
  }
  return it as unknown as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

export function fakeIo(o: Options = {}): Fake {
  let clock = 1_000_000
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  const fake: Fake = {
    files: new Map(Object.entries(o.files ?? {})),
    dirs: new Set(o.dirs ?? []),
    spawned: [],
    killed: 0,
    notified: [],
    agentSpawns: [],
    sent: [],
    advance(ms) {
      clock += ms
      for (const t of timers) {
        if (t.live && t.at <= clock) {
          t.live = false
          t.fn()
        }
      }
    },
    async stat(given) {
      const parts: string[] = []
      for (const part of given.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') parts.pop()
        else parts.push(part)
      }
      const path = '/' + parts.join('/')
      const isDir = fake.dirs.has(path)
      if (!isDir && !fake.files.has(path)) throw new Error(`ENOENT: ${given}`)
      return { kind: isDir ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false, realPath: path }
    },
    async list(path) {
      if (!fake.dirs.has(path)) throw new Error(`ENOENT: ${path}`)
      const prefix = path === '/' ? '/' : path + '/'
      const seen = new Map<string, FsEntry['kind']>()
      for (const d of fake.dirs) if (d !== path && parentOf(d) === path) seen.set(d.slice(prefix.length), 'dir')
      for (const f of fake.files.keys()) if (parentOf(f) === path) seen.set(f.slice(prefix.length), 'file')
      return [...seen].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
    },
    async read(path) {
      const text = fake.files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    async write(path, text) {
      fake.files.set(path, text)
    },
    async exists(path) {
      return fake.files.has(path) || fake.dirs.has(path)
    },
    spawn(request) {
      fake.spawned.push(request)
      return stream(fake, o.spawn?.(request, fake.spawned.length - 1) ?? {})
    },
    async run(argv) {
      if (o.run === undefined) throw new Error(`no run handler for ${argv.join(' ')}`)
      return o.run(argv)
    },
    async now() {
      return clock
    },
    after(ms, fn) {
      const t = { at: clock + ms, fn, live: true }
      timers.push(t)
      return { cancel: () => (t.live = false) }
    },
    async sleep(ms) {
      clock += ms
    },
    async agents() {
      return o.agents ?? []
    },
    async spawnAgent(a) {
      fake.agentSpawns.push(a)
      if (o.spawnAgent === undefined) throw new Error('no spawnAgent handler')
      return o.spawnAgent(a)
    },
    async send(a): Promise<SessionSendResult> {
      fake.sent.push(a)
      return { isDelivered: true }
    },
    async notify(text) {
      if (o.notifyFails !== undefined) throw new Error(o.notifyFails)
      fake.notified.push(text)
    },
  }
  return fake
}

export const ok = (stdout = '', stderr = '', exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})
