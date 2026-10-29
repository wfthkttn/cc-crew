import type { FsEntry, ProcessRunResult } from 'claude-code'
import type { AgentsJob, AgentsOutcome, AgentsRun } from 'cc-agents'

import type { Io } from '../hooks/io.ts'
import type { AgentsPort, ProvidersPort } from '../hooks/reviews.ts'

export type Fake = Io & { files: Map<string, string>; dirs: Set<string>; ran: string[][]; advance: (ms: number) => void }

type Options = { files?: Record<string, string>; dirs?: string[]; run?: (argv: readonly string[]) => ProcessRunResult }

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function fakeIo(o: Options = {}): Fake {
  let clock = new Date(2026, 9, 29, 21, 0).getTime()
  const fake: Fake = {
    files: new Map(Object.entries(o.files ?? {})),
    dirs: new Set(o.dirs ?? []),
    ran: [],
    advance(ms) {
      clock += ms
    },
    async list(path) {
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
      return fake.files.has(path) || fake.dirs.has(path) || [...fake.files.keys()].some(f => f.startsWith(path + '/'))
    },
    async run(argv) {
      fake.ran.push([...argv])
      if (o.run === undefined) throw new Error(`no run handler for ${argv.join(' ')}`)
      return o.run(argv)
    },
    async now() {
      return clock
    },
  }
  return fake
}

export const FINDINGS = {
  summary: 'One bug.',
  findings: [
    {
      title: 'Off by one',
      priority: 1,
      confidence: 0.8,
      file: 'main.ts',
      line_start: 3,
      line_end: 4,
      scenario: 'n = 0',
      body: 'Loop skips the last item.',
      pre_existing: false,
    },
  ],
  checked: ['main.ts'],
  not_read: [],
}

export const ok = (stdout = '', stderr = '', exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

type Started = { session: string; provider: string; job: AgentsJob; group: string; label: string }

/** `$.agents` as crew calls it: each start is kept running until the test ends it; `refuse` answers a provider's start ended at its limit. */
export function fakeAgents(o: { refuse?: Record<string, string> } = {}) {
  const runs = new Map<string, AgentsRun>()
  const started: Started[] = []
  const followed: { session: string; id: string; message: string }[] = []
  const stopped: string[] = []
  const port: AgentsPort = {
    async start(input) {
      started.push(input)
      const id = `a${runs.size + 1}`
      const refused = o.refuse?.[input.provider]
      const run: AgentsRun = {
        id,
        session: input.session,
        group: input.group,
        label: input.label,
        provider: input.provider,
        key: `${input.provider}/${input.job.model ?? 'default'}`,
        job: input.job,
        status: refused === undefined ? 'running' : 'limit',
        costUsd: 0,
        isCostEstimate: false,
        followUps: 0,
        startedAt: 0,
        ...(refused === undefined ? { current: id } : { detail: refused, endedAt: 0 }),
      }
      runs.set(id, run)
      return run
    },
    async followUp(input) {
      followed.push(input)
      const run = runs.get(input.id)!
      if (run.session !== input.session) throw new Error(`agents: run ${input.id} belongs to session ${run.session}`)
      const going: AgentsRun = { ...run, status: 'running', followUps: run.followUps + 1, current: `${run.id}.f${run.followUps + 1}` }
      runs.set(run.id, going)
      return going
    },
    async stop({ id }) {
      stopped.push(id)
      return { isStopping: true }
    },
    async get({ id }) {
      const run = runs.get(id)
      if (run === undefined) throw new Error(`agents: no run ${id}`)
      return run
    },
    async list({ session }) {
      return [...runs.values()].filter(r => r.session === session)
    },
  }
  /** The run as `agents.ended` carries it once it ended with `outcome`. */
  function end(id: string, outcome: AgentsOutcome, extra: Partial<AgentsRun> = {}): AgentsRun {
    const { current: _c, ...rest } = runs.get(id)!
    const run: AgentsRun = {
      ...rest,
      status: outcome.status,
      usedModel: outcome.model,
      endedAt: 60_000,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...(outcome.continueId === undefined ? {} : { continueId: outcome.continueId }),
      ...extra,
    }
    runs.set(id, run)
    return run
  }
  return { port, runs, started, followed, stopped, end }
}

/** `$.providers` as crew calls it before a review: the project as the root, refusals by provider, secrets by name. */
export function fakeProviders(o: { refuse?: Record<string, string>; roots?: { roots: string[]; files: string[] } } = {}): ProvidersPort & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    modelKey: async ({ provider, model }) => `${provider}/${model ?? 'default'}`,
    refusal: async ({ key }) => {
      asked.push(key)
      return { refusal: o.refuse?.[key.slice(0, key.indexOf('/'))] ?? null }
    },
    roots: async ({ read, project }) => o.roots ?? { roots: read === 'none' ? [] : [project], files: [] },
    secretPaths: async ({ paths }) => ({ secret: paths.filter(p => /\/\.env(\.[^/]*)?$|\.pem$/.test(p)) }),
  }
}
