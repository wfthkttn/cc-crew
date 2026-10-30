import type { ProvidersReadSpec } from 'cc-providers'
import { expect, test } from 'claude-code/testing'

import { type Effective } from '../hooks/config.ts'
import { type BeginInput, labelOf, makeJobs, Refused, titleOf } from '../hooks/jobs.ts'
import { REPORT_SCHEMA } from '../hooks/report.ts'
import { ANSWER, fakeAgents, fakeIo, fakeProviders, ok } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'
const ROOT = '/home/u/.claude/crew'
const MINUTE = 60_000

const model = (serves: string, over: Partial<Effective> = {}): Effective => ({ serves, web: false, helpers: false, timeoutMs: 60 * MINUTE, pokeMs: 20 * MINUTE, stallMs: 10 * MINUTE, ...over })

const GEMINI = model('google/gemini-3.8-flash')
const SOL = model('openai/gpt-6.1-sol', { effort: 'medium' })

function input(over: Partial<BeginInput> = {}): BeginInput {
  return { session: 's1', job: 'review', brief: 'Look at X.\nMore on X.', models: [GEMINI, SOL], skipped: [], kind: 'oneshot', profile: 'read-only', prefer: ['quota', 'api'], read: ['.'], project: PROJECT, system: 'SYSTEM', ...over }
}

function setup(o: { refuseStart?: Record<string, string> } = {}) {
  const io = fakeIo({ run: () => ok() })
  const agents = fakeAgents(o.refuseStart === undefined ? {} : { refuse: o.refuseStart })
  const providers = fakeProviders()
  const alerts: string[] = []
  const alert = async (provider: string, detail: string) => {
    alerts.push(`${provider}: ${detail}`)
    return undefined
  }
  return { io, agents, providers, alerts, alert, jobs: makeJobs(ROOT) }
}

const done = (text: string) => ({ status: 'ok' as const, text, model: 'm', continueId: 'th-1' })
const NO_ALERT = async () => undefined

test('agents are lettered A to Z, then A2; a title is the brief\'s first line, cut short', () => {
  expect([0, 1, 25, 26, 52].map(labelOf)).toEqual(['A', 'B', 'Z', 'A2', 'A3'])
  expect(titleOf('  Look at X.\nMore.')).toBe('Look at X.')
  expect(titleOf('x'.repeat(100))).toHaveLength(60)
})

test("a job asks agents to place each model as its kind and profile, by the job's preference, grouped by the job, lettered, with crew's report schema, each with its model's own settings", async () => {
  const { io, agents, providers, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [GEMINI, model('openai/gpt-6.1-sol', { provider: 'codex', effort: 'medium', web: true, timeoutMs: 5 * MINUTE })], skipped: [{ serves: 'zhipu/glm-5.3', why: 'closed' }] }))
  expect(job).toMatchObject({ id: 'review-1', job: 'review', title: 'Look at X.', session: 's1', dir: `${ROOT}/s1/review-1`, isAcked: false, skipped: [{ serves: 'zhipu/glm-5.3', why: 'closed' }] })
  expect(job.agents.map(a => [a.label, a.agent])).toEqual([['A', 'a1'], ['B', 'a2']])
  expect(agents.started.map(s => [s.serves, s.provider, s.effort, s.kind, s.profile, s.prefer, s.group, s.label])).toEqual([
    ['google/gemini-3.8-flash', undefined, undefined, 'oneshot', 'read-only', ['quota', 'api'], 's1/review-1', 'A'],
    ['openai/gpt-6.1-sol', 'codex', 'medium', 'oneshot', 'read-only', ['quota', 'api'], 's1/review-1', 'B'],
  ])
  expect(agents.started[1]!.job).toMatchObject({ read: ['.'], project: PROJECT, system: 'SYSTEM', web: true, schema: REPORT_SCHEMA, timeoutMs: 5 * MINUTE })
  expect(Object.keys(agents.started[1]!.job)).not.toContain('dir')
  expect(agents.started[0]!.job.task).toContain('Web: not available.')
  expect(agents.started[1]!.job.task).toContain('Web: allowed.')
  expect(io.files.get(`${ROOT}/s1/review-1/brief.md`)).toBe('Look at X.\nMore on X.')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!)).toMatchObject({ id: 'review-1', agents: [{ label: 'A', agent: 'a1' }, { label: 'B', agent: 'a2' }] })
  expect(jobs.isDone(job)).toBe(false)
  expect((await jobs.begin(io, agents.port, providers, input())).id).toBe('review-2')
  expect((await jobs.begin(io, agents.port, providers, input({ job: 'research', read: 'none' }))).id).toBe('research-1')
})

test('a diff without paths to find the repository by is refused before anything starts', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await expect(jobs.begin(io, agents.port, providers, input({ read: 'none', diff: 'uncommitted' }))).rejects.toBeInstanceOf(Refused)
  expect(agents.started).toHaveLength(0)
})

test('each agent that ends leaves its answer; one signed out is told to the person; the summary names no model and says how to read it', async () => {
  const { io, agents, providers, alerts, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input())
  const answer = done(JSON.stringify(ANSWER))
  expect(await jobs.ended(io, alert, agents.end('a1', answer), answer)).toBe(job)
  expect(jobs.isDone(job)).toBe(false)
  expect(job.agents[0]!.findings).toBe(1)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A.json`)!)).toMatchObject({ status: 'ok', model: 'm', answer: { not_read: ['vendor/'] } })
  const out = { status: 'signed_out' as const, text: '', model: 'gpt-6.1-sol', detail: 'Codex is signed out' }
  await jobs.ended(io, alert, agents.end('a2', out), out)
  expect(jobs.isDone(job)).toBe(true)
  expect(alerts).toEqual(['codex: Codex is signed out'])
  const summary = await jobs.summary(io, job, 's1')
  expect(summary).toContain('review-1 "Look at X." finished: 1 findings in Parser (1), Limits (0).')
  expect(summary).toContain('Only 1 of 2 agents gave a usable answer')
  expect(summary).toContain('agent B: SIGNED OUT: Codex is signed out')
  expect(summary).toContain('Read it with report { id: "review-1" }')
  expect(summary).not.toContain('gpt')
  expect(summary).not.toContain('gemini')
  const stranger = { ...agents.end('a1', answer), group: 'someone-else' }
  expect(await jobs.ended(io, alert, stranger, answer)).toBeUndefined()
})

test('the report reads whole, by scope or as findings alone; only the whole read acks it, and none of them names a model', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input())
  const answer = done(JSON.stringify(ANSWER))
  const second = done(JSON.stringify({ scopes: [{ ...ANSWER.scopes[0], report: 'Agrees.', findings: [{ title: 'Second view', priority: 0, confidence: 1, body: 'b', evidence: '', references: [] }] }], not_read: [] }))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  await jobs.ended(io, alert, agents.end('a2', second), second)
  const findings = await jobs.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })
  expect(findings).toContain('## Parser\n\n- [P0] Second view (confidence 1)')
  expect(findings).toContain('- [P1] Off by one (confidence 0.8)\n  Loop skips the last item.\n  Evidence: n = 0 returns nothing.\n  References: main.ts:3')
  expect(findings).not.toContain('Read the loop')
  expect(job.isAcked).toBe(false)
  const scope = await jobs.report(io, agents.port, 's1', 'review-1', { scope: 'parser' })
  expect(scope).toContain('Read the loop; the rest holds.')
  expect(scope).toContain('Agrees.')
  expect(scope).not.toContain('Sound.')
  expect(job.isAcked).toBe(false)
  await expect(jobs.report(io, agents.port, 's1', 'review-1', { scope: 'Nope' })).rejects.toThrow('review-1 has no scope "Nope"; it has Parser, Limits')
  const whole = await jobs.report(io, agents.port, 's1', 'review-1', {})
  expect(whole).toContain('## Limits\n\nSound.')
  expect(whole).toContain('## Not read\n\n- vendor/')
  expect(whole).not.toContain('gpt')
  expect(whole).not.toContain('gemini')
  expect(job.isAcked).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).isAcked).toBe(true)
  expect(await jobs.line(io, job, 0)).toBe('review-1 done, read, "Look at X.": 2 findings in Parser (2), Limits (0)')
})

test('every read of a job still running says so and acks nothing, findings alone with nothing to show included; an answer outside the format is shown as it came', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input())
  const still = 'review-1 is still running, 0 of 2 agents finished'
  expect(await jobs.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })).toStartWith(still)
  expect(await jobs.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })).not.toContain('No findings')
  const answer = done('Just prose.')
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  const text = await jobs.report(io, agents.port, 's1', 'review-1', {})
  expect(text).toStartWith('review-1 is still running, 1 of 2 agents finished; this is what it has so far.')
  expect(text).toContain('agent A answered outside the format, so its findings are not counted')
  expect(text).toContain('## Answer not in the report format (agent A)\n\nJust prose.')
  expect(job.isAcked).toBe(false)
})

test('no agent with a usable answer never reads as a clean result, in the message, the list or any report', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input())
  const failed = { status: 'failed' as const, text: '', model: 'm', detail: 'the harness died' }
  const prose = done('It looks wrong to me.')
  await jobs.ended(io, alert, agents.end('a1', failed), failed)
  await jobs.ended(io, alert, agents.end('a2', prose), prose)
  const summary = await jobs.summary(io, job, 's1')
  expect(summary).toContain('finished: no usable answer.')
  expect(summary).toContain('No agent gave a usable answer, so this job established nothing. Do not read it as a clean result.')
  expect(summary).toContain('agent A: FAILED: the harness died')
  expect(summary).toContain('agent B answered outside the format')
  expect(summary).not.toContain('0 findings')
  const line = await jobs.line(io, job, 0)
  expect(line).toContain('done, unread, "Look at X.": no usable answer')
  expect(line).toContain('agent A: FAILED: the harness died')
  const findings = await jobs.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })
  expect(findings).toContain('No agent gave a usable answer')
  expect(findings).not.toContain('No findings')
})

test('agents that answered with no findings read as a clean result, with no caveat', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify({ scopes: [{ scope: 'Parser', report: 'Sound.', findings: [], references: [] }], not_read: [] }))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  expect(await jobs.summary(io, job, 's1')).toStartWith('review-1 "Look at X." finished: 0 findings in Parser (0).\nRead it with')
  expect(await jobs.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })).toBe('No findings.')
})

test("a job another conversation started is named by its full id, which report and stop take; an id can't leave the reports folder", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  expect(await jobs.stop(io, agents.port, 's2', 's1/review-1')).toEqual({ stopping: 1, unreachable: 0 })
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  expect(await jobs.summary(io, job, 's2')).toContain('Read it with report { id: "s1/review-1" }')
  expect(await jobs.report(io, agents.port, 's2', 's1/review-1', { findingsOnly: true })).toContain('Off by one')
  await expect(jobs.report(io, agents.port, 's2', '../../etc', {})).rejects.toThrow('no job ../../etc')
  await expect(jobs.report(io, agents.port, 's2', '../review-1', {})).rejects.toThrow('no job ../review-1')
})

test('an end is told once, and one that could not be told is told at the next try', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const told: string[] = []
  const tell = async (text: string) => void told.push(text)
  await jobs.announce(io, job, 's1', tell)
  expect(told).toEqual([])
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  await expect(jobs.announce(io, job, 's1', async () => Promise.reject(new Error('no conversation')))).rejects.toThrow('no conversation')
  await jobs.announce(io, job, 's1', tell)
  await jobs.announce(io, job, 's1', tell)
  expect(told).toHaveLength(1)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).isAnnounced).toBe(true)
})

test('a save while the telling is out does not mark the job told: a delivery that fails leaves it untold on disk', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  const failing = jobs.announce(io, job, 's1', async () => {
    await jobs.report(io, agents.port, 's1', 'review-1', {})
    throw new Error('no conversation')
  })
  await expect(failing).rejects.toThrow('no conversation')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).isAnnounced).toBeUndefined()
  expect(job.isAnnounced).toBeUndefined()
})

test('a job told once a save failed is not told again', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  const told: string[] = []
  const tell = async (text: string) => void told.push(text)
  const full = { ...io, write: async (path: string, text: string) => (path.endsWith('job.json') ? Promise.reject(new Error('disk full')) : io.write(path, text)) }
  await expect(jobs.announce(full, job, 's1', tell)).rejects.toThrow('disk full')
  expect(jobs.needsTelling(job)).toBe(true)
  await jobs.announce(io, job, 's1', tell)
  expect(told).toHaveLength(1)
  expect(jobs.needsTelling(job)).toBe(false)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).isAnnounced).toBe(true)
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  await reloaded.restore(io, agents.port, NO_ALERT, 's1')
  await reloaded.announce(io, reloaded.sessionJobs('s1')[0]!, 's1', tell)
  expect(told).toHaveLength(1)
})

test('two tellings at once tell once', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  const told: string[] = []
  const tell = async (text: string) => void told.push(text)
  await Promise.all([jobs.announce(io, job, 's1', tell), jobs.announce(io, job, 's1', tell)])
  expect(told).toHaveLength(1)
})

test('a full read an end lands in the middle of does not ack: what it showed lacks that answer', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  const ending = {
    ...io,
    exists: async (path: string) => {
      const found = await io.exists(path)
      if (path.endsWith('/A.json')) await jobs.ended(io, alert, agents.end('a1', answer), answer)
      return found
    },
  }
  await jobs.report(ending, agents.port, 's1', 'review-1', {})
  expect(jobs.isDone(job)).toBe(true)
  expect(job.isAcked).toBe(false)
  await jobs.report(io, agents.port, 's1', 'review-1', {})
  expect(job.isAcked).toBe(true)
})

test('an end caught up at a restore tells the person too, once, also when its `ended` arrives after', async () => {
  const { io, agents, providers, alerts, alert } = setup()
  const first = makeJobs(ROOT)
  await first.begin(io, agents.port, providers, input({ models: [SOL] }))
  const quota = { status: 'quota' as const, text: '', model: 'gpt-6.1-sol', detail: 'none left' }
  const run = agents.end('a1', quota)
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  await reloaded.restore(io, agents.port, alert, 's1')
  expect(alerts).toEqual(['codex: none left'])
  await reloaded.ended(io, alert, run, quota)
  expect(alerts).toEqual(['codex: none left'])
  const later = makeJobs(ROOT)
  await later.restore(io, agents.port, alert, 's1')
  expect(alerts).toEqual(['codex: none left'])
})

test('an end another session read first still tells the person when its own session comes back', async () => {
  const { io, agents, providers, alerts, alert } = setup()
  await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL] }))
  agents.end('a1', { status: 'quota', text: '', model: 'gpt-6.1-sol', detail: 'none left' })
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const other = makeJobs(ROOT)
  await other.load(io, agents.port, 's2', 's1/review-1')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).agents[0].kept).toBe(0)
  expect(alerts).toEqual([])
  const resumed = makeJobs(ROOT)
  await resumed.restore(io, agents.port, alert, 's1')
  expect(alerts).toEqual(['codex: none left'])
  await makeJobs(ROOT).restore(io, agents.port, alert, 's1')
  expect(alerts).toEqual(['codex: none left'])
})

test('an end landing while a restore lists the runs stands over the older list', async () => {
  const { io, agents, providers, alert } = setup()
  await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL] }))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  const answer = done(JSON.stringify(ANSWER))
  const late = {
    ...agents.port,
    list: async () => {
      const listed = await agents.port.list({ session: 's1' })
      await reloaded.ended(io, alert, agents.end('a1', answer), answer)
      return listed
    },
  }
  await reloaded.restore(io, late, NO_ALERT, 's1')
  const job = reloaded.sessionJobs('s1')[0]!
  expect(reloaded.statusOf(job.agents[0]!)).toBe('ok')
  expect(reloaded.isDone(job)).toBe(true)
})

test('a retry that moved on while a restore lists the runs stands over the older list', async () => {
  const { io, agents, providers, alert } = setup()
  await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL] }))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  const first = agents.runs.get('a1')!
  const retried = { ...first, current: 'a1.r1', attempts: [{ kind: 'start' as const, key: first.key, status: 'left_roots' as const, at: 1 }] }
  const late = {
    ...agents.port,
    list: async () => {
      reloaded.changed(retried)
      return [first]
    },
  }
  await reloaded.restore(io, late, alert, 's1')
  expect(reloaded.runOf('a1')).toMatchObject({ current: 'a1.r1' })
})

test('an end whose outcome was not kept still tells the person, from its record', async () => {
  const { io, agents, providers, alerts, alert } = setup()
  await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL] }))
  agents.runs.set('a1', { ...agents.runs.get('a1')!, status: 'quota', detail: 'none left' })
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  await makeJobs(ROOT).restore(io, agents.port, alert, 's1')
  expect(alerts).toEqual(['codex: none left'])
})

test('an agent refused at its start is kept at once from what agents kept of it; the `ended` that follows keeps it no twice and still tells the person', async () => {
  const { io, agents, providers, alert, alerts, jobs } = setup({ refuseStart: { codex: 'helpers spent $13.00 in the Codex pool' } })
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  expect(jobs.isDone(job)).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A.json`)!)).toMatchObject({ status: 'limit', detail: 'helpers spent $13.00 in the Codex pool' })
  expect(await jobs.summary(io, job, 's1')).toContain('agent A: REFUSED AT ITS LIMIT: helpers spent $13.00 in the Codex pool')
  io.files.delete(`${ROOT}/s1/review-1/A.json`)
  const quota = { status: 'quota' as const, text: '', model: 'gpt-6.1-sol', detail: 'none left' }
  await jobs.ended(io, alert, agents.runs.get('a1')!, quota)
  expect(io.files.has(`${ROOT}/s1/review-1/A.json`)).toBe(false)
  expect(alerts).toEqual(['codex: none left'])
  await expect(jobs.ask(io, agents.port, 's1', 'review-1', 'A', 'Again?')).rejects.toThrow('before its conversation began, so a follow-up has nothing to continue; start a new one instead')
  expect(agents.followed).toEqual([])
})

test('every provider ranked refusing with nothing kept still ends the agent, with the reason its record gives', async () => {
  const { io, agents, providers, jobs } = setup({ refuseStart: { codex: 'over' } })
  const port = { ...agents.port, outcome: async () => null }
  const job = await jobs.begin(io, port, providers, input({ models: [SOL] }))
  expect(jobs.isDone(job)).toBe(true)
  expect(io.files.has(`${ROOT}/s1/review-1/A.json`)).toBe(false)
  expect(await jobs.summary(io, job, 's1')).toContain('agent A: REFUSED AT ITS LIMIT: over')
})

test('a run cc-agents says moved is read as it stands; one no job of crew has is left out', async () => {
  const { io, agents, providers, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const moved = { ...agents.runs.get('a1')!, followUps: 1, current: 'a1.f1' }
  jobs.changed(moved)
  expect(jobs.runOf('a1')).toEqual(moved)
  expect(jobs.statusOf(job.agents[0]!)).toBe('running')
  jobs.changed({ ...moved, id: 'b1', group: 'someone-else' })
  expect(jobs.runOf('b1')).toBeUndefined()
})

test('a run heard of before its start answers is bound to its agent', async () => {
  const { io, agents, providers, jobs } = setup()
  const port = {
    ...agents.port,
    start: async (i: Parameters<typeof agents.port.start>[0]) => {
      const run = await agents.port.start(i)
      jobs.changed({ ...run, followUps: 3 })
      return run
    },
  }
  const job = await jobs.begin(io, port, providers, input({ models: [SOL] }))
  expect(job.agents[0]!.agent).toBe('a1')
  expect(jobs.runOf('a1')!.followUps).toBe(3)
})

test('an end nobody here took is kept at a restore from what agents kept, and read as done', async () => {
  const { io, agents, providers } = setup()
  const first = makeJobs(ROOT)
  const job = await first.begin(io, agents.port, providers, input({ models: [SOL] }))
  agents.end('a1', done(JSON.stringify(ANSWER)))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  await reloaded.restore(io, agents.port, NO_ALERT, 's1')
  const restored = reloaded.sessionJobs('s1')[0]!
  expect(restored.id).toBe(job.id)
  expect(reloaded.isDone(restored)).toBe(true)
  expect(restored.agents[0]).toMatchObject({ findings: 1, kept: 0 })
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).agents[0].kept).toBe(0)
  expect(await reloaded.report(io, agents.port, 's1', 'review-1', { findingsOnly: true })).toContain('Off by one')
})

test('a job of another session that ended with nobody to take it is read as it ended', async () => {
  const { io, agents, providers } = setup()
  await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL] }))
  agents.end('a1', done(JSON.stringify(ANSWER)))
  expect(await makeJobs(ROOT).report(io, agents.port, 's2', 's1/review-1', { findingsOnly: true })).toContain('Off by one')
})

test('a follow-up, kept for jobs that live on, goes to a finished agent from its own session, and keeps its answer apart', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  await expect(jobs.ask(io, agents.port, 's1', 'review-1', 'A', 'And Y?')).rejects.toThrow('agent A is still running')
  const first = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', first), first)
  await expect(jobs.ask(io, agents.port, 's1', 'review-1', 'Z', 'And Y?')).rejects.toThrow('review-1 has no agent Z; it has A')
  const { run } = await jobs.ask(io, agents.port, 's1', 'review-1', 'A', 'And Y?')
  expect(run.status).toBe('running')
  expect(agents.followed).toEqual([{ session: 's1', id: 'a1', message: 'And Y?' }])
  let isAnswered = false
  void jobs.whenAnswered('a1').then(() => (isAnswered = true))
  const second = done('Y is fine.')
  await jobs.ended(io, alert, agents.end('a1', second), second)
  await Promise.resolve()
  expect(isAnswered).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A-followup-1.json`)!)).toMatchObject({ message: 'And Y?', text: 'Y is fine.' })
})

test('a follow-up refused keeps its refusal apart, with its message', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const first = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', first), first)
  const refused = { status: 'limit' as const, text: '', model: 'm', detail: 'over' }
  const port = {
    ...agents.port,
    followUp: async (i: Parameters<typeof agents.port.followUp>[0]) => {
      await agents.port.followUp(i)
      return agents.end('a1', refused, { isRefused: true })
    },
  }
  const { job, run } = await jobs.ask(io, port, 's1', 'review-1', 'A', 'And Z?')
  expect(run.status).toBe('limit')
  expect(jobs.isDone(job)).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A-followup-1.json`)!)).toMatchObject({ status: 'limit', message: 'And Z?', detail: 'over' })
})

test("an agent whose end comes before its start's answer keeps its answer; one ended in its answer waits for its end", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const answer = done(JSON.stringify(ANSWER))
  let late: (() => Promise<unknown>) | undefined
  const port = {
    ...agents.port,
    start: async (i: Parameters<typeof agents.port.start>[0]) => {
      const run = await agents.port.start(i)
      const ended = agents.end(run.id, answer)
      if (i.label === 'A') await jobs.ended(io, alert, ended, answer)
      else late = () => jobs.ended(io, alert, ended, answer)
      return ended
    },
  }
  const job = await jobs.begin(io, port, providers, input())
  expect(job.agents.map(a => [a.label, a.agent, a.findings])).toEqual([['A', 'a1', 1], ['B', 'a2', undefined]])
  expect(jobs.statusOf(job.agents[1]!)).toBe('running')
  expect(jobs.isDone(job)).toBe(false)
  await late!()
  expect(jobs.isDone(job)).toBe(true)
  expect(job.agents[1]!.findings).toBe(1)
})

test('a reload while a job started binds its agents to the runs agents kept for them', async () => {
  const { io, agents, providers, alert } = setup()
  const first = makeJobs(ROOT)
  const job = await first.begin(io, agents.port, providers, input({ models: [SOL] }))
  const unbound = { ...job, agents: job.agents.map(({ agent: _a, ...e }) => e) }
  io.files.set(`${ROOT}/s1/review-1/job.json`, JSON.stringify(unbound))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT)
  await reloaded.restore(io, agents.port, NO_ALERT, 's1')
  const restored = await reloaded.load(io, agents.port, 's1', 'review-1')
  expect(restored.agents[0]!.agent).toBe('a1')
  expect(reloaded.statusOf(restored.agents[0]!)).toBe('running')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).agents[0].agent).toBe('a1')
})

test("a job of another session is read by its full id, with its agents' runs; an unknown one says where to look", async () => {
  const { io, agents, providers, alert } = setup()
  const own = makeJobs(ROOT)
  await own.begin(io, agents.port, providers, input({ models: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  await own.ended(io, alert, agents.end('a1', answer), answer)
  const other = makeJobs(ROOT)
  expect(await other.report(io, agents.port, 's2', 's1/review-1', { findingsOnly: true })).toContain('Off by one')
  await expect(other.report(io, agents.port, 's2', 'review-1', {})).rejects.toThrow('no job review-1; jobs lists this session')
})

test('liveness asks agents with each model\'s limit, tells a stalled agent once, and says what it is on', async () => {
  const { io, agents, providers, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input())
  const asked: unknown[] = []
  const port = { ...agents.port, health: async (i: { id: string; stallMs: number }) => (asked.push(i), agents.port.health(i)) }
  agents.healths.set('a1', { state: 'working', steps: 3, tool: 'WebFetch' })
  agents.healths.set('a2', { state: 'working', steps: 1 })
  io.advance(5 * MINUTE)
  await jobs.read(port, 's1')
  expect(asked).toEqual([{ id: 'a1', stallMs: 10 * MINUTE }, { id: 'a2', stallMs: 10 * MINUTE }])
  expect(jobs.poke(job, await io.now())).toBeUndefined()
  expect(jobs.viewOf(job).agents.map(a => a.reading?.text)).toEqual(['working: WebFetch', 'working, 1 step done'])
  io.advance(6 * MINUTE)
  agents.healths.set('a1', { state: 'stalled', on: { tool: 'WebFetch', target: 'https://x.invalid' }, forMs: 11 * MINUTE, mark: 'open:1' })
  agents.healths.set('a2', { state: 'stalled', forMs: 11 * MINUTE, mark: 'silent:1' })
  await jobs.read(agents.port, 's1')
  const poke = jobs.poke(job, await io.now())!
  expect(poke).toContain('review-1 "Look at X.", running 11m:')
  expect(poke).toContain('agent A: waiting on WebFetch https://x.invalid for 11m')
  expect(poke).toContain('agent B: no output for 11m')
  expect(poke).toContain('stop { id: "review-1", agent: "<letter>" }')
  expect(poke).not.toContain('there is nothing to do')
  expect(poke).not.toContain('gemini')
  expect(jobs.viewOf(job).agents.map(a => a.reading?.isStalled)).toEqual([true, true])
  io.advance(MINUTE)
  await jobs.read(agents.port, 's1')
  expect(jobs.poke(job, await io.now())).toBeUndefined()
})

test('an agent that ends badly is told while the others run; a job past its shortest poke is told as a status; a finished job pokes no more', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [GEMINI, model('openai/gpt-6.1-sol', { pokeMs: 15 * MINUTE })] }))
  agents.healths.set('a1', { state: 'working', steps: 0 })
  const failed = { status: 'failed' as const, text: '', model: 'm', detail: 'boom' }
  await jobs.ended(io, alert, agents.end('a2', failed), failed)
  expect(jobs.poke(job, await io.now())).toContain('agent B: FAILED')
  io.advance(14 * MINUTE)
  expect(jobs.poke(job, await io.now())).toBeUndefined()
  io.advance(6 * MINUTE)
  agents.healths.set('a1', { state: 'working', steps: 9 })
  await jobs.read(agents.port, 's1')
  const status = jobs.poke(job, await io.now())!
  expect(status).toContain('agent A: working, 9 steps done')
  expect(status).toContain('agent B: FAILED: boom')
  expect(status).toContain('Leave it, or give up on one')
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  io.advance(60 * MINUTE)
  expect(jobs.poke(job, await io.now())).toBeUndefined()
})

test('a status poke over healthy agents says there is nothing to do and offers no stop', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  io.advance(21 * MINUTE)
  agents.healths.set('a1', { state: 'working', steps: 4 })
  await jobs.read(agents.port, 's1')
  const poke = jobs.poke(job, await io.now())!
  expect(poke).toContain('It is working: there is nothing to do.')
  expect(poke).not.toContain('stop')
})

test('a diff with nothing in it is refused, saying what to do instead', async () => {
  const io = fakeIo({
    run: argv => {
      const args = argv.slice(5).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok(`${PROJECT}\n`)
      return ok('')
    },
  })
  const agents = fakeAgents()
  await expect(makeJobs(ROOT).begin(io, agents.port, fakeProviders(), input({ models: [SOL], diff: 'uncommitted' }))).rejects.toThrow('there is no change under these paths')
  expect(agents.started).toEqual([])
})

test('a diff is read in the first path the call names, though the paths resolve sorted', async () => {
  const io = fakeIo({
    run: argv => {
      if (argv[2] !== '/r/zeta') throw new Error(`git ran in ${argv[2]}`)
      const args = argv.slice(5).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok('/r/zeta\n')
      if (args === 'rev-parse --verify -q HEAD') return ok('abc\n')
      if (args === 'diff HEAD --no-renames --name-only -z -- /r/zeta') return ok('a.ts\0')
      if (args === 'ls-files -z --others --exclude-standard -- /r/zeta') return ok('')
      if (args === 'diff HEAD --no-renames -- a.ts') return ok('+a\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const providers = { ...fakeProviders(), roots: async ({ read }: { read: ProvidersReadSpec }) => ({ roots: [...(read as string[])].sort(), files: [] }) }
  const agents = fakeAgents()
  const job = await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL], read: ['/r/zeta', '/r/alpha'], diff: 'uncommitted' }))
  expect(job.roots).toEqual(['/r/alpha', '/r/zeta'])
  expect(job.diff).toBe('The uncommitted changes (staged and unstaged) in `/r/zeta`')
})

test("a diff leaves out the files whose names providers marks secret", async () => {
  const io = fakeIo({
    run: argv => {
      const args = argv.slice(5).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok(`${PROJECT}\n`)
      if (args === 'rev-parse --verify -q HEAD') return ok('abc\n')
      if (args === `diff HEAD --no-renames --name-only -z -- ${PROJECT}`) return ok('main.ts\0.env\0')
      if (args === `ls-files -z --others --exclude-standard -- ${PROJECT}`) return ok('new.ts\0key.pem\0')
      if (args === 'diff HEAD --no-renames -- main.ts') return ok('+fix\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const agents = fakeAgents()
  const job = await makeJobs(ROOT).begin(io, agents.port, fakeProviders(), input({ models: [SOL], diff: 'uncommitted' }))
  expect(job.diff).toBe(`The uncommitted changes (staged and unstaged) in \`${PROJECT}\` (1 secret file left out of the diff)`)
  const task = agents.started[0]!.job.task
  expect(task).toContain('- new.ts')
  expect(task).not.toContain('key.pem')
  expect(task).toContain('```diff\n+fix\n\n```')
})

test("a diff is kept to the paths: a file path shows that file's change, not its folder's or the repository's", async () => {
  const allowed = '/r/src/allowed.ts'
  const io = fakeIo({
    run: argv => {
      const args = argv.slice(5).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok('/r\n')
      if (argv[2] !== '/r') throw new Error(`git ran in ${argv[2]} after the top was found`)
      if (args === 'rev-parse --verify -q HEAD') return ok('abc\n')
      if (args === `diff HEAD --no-renames --name-only -z -- ${allowed}`) return ok('src/allowed.ts\0')
      if (args === `ls-files -z --others --exclude-standard -- ${allowed}`) return ok('')
      if (args === 'diff HEAD --no-renames -- src/allowed.ts') return ok('+ok\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const providers = fakeProviders({ roots: { roots: [allowed], files: [allowed] } })
  const agents = fakeAgents()
  const job = await makeJobs(ROOT).begin(io, agents.port, providers, input({ models: [SOL], read: [allowed], diff: 'uncommitted' }))
  expect(job.diff).toBe('The uncommitted changes (staged and unstaged) in `/r`')
  expect(agents.started[0]!.job.task).toContain('```diff\n+ok\n\n```')
})

test("a reload finds the session's jobs on disk with their agents' runs; stop reaches only agents still running, and says when it names none", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await jobs.begin(io, agents.port, providers, input())
  const answer = done('')
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const again = makeJobs(ROOT)
  await again.restore(io, agents.port, NO_ALERT, 's1')
  expect(again.sessionJobs('s1').map(j => j.id)).toEqual(['review-1'])
  expect(again.sessionJobs('s2')).toEqual([])
  expect(again.viewOf(again.sessionJobs('s1')[0]!).agents.map(a => a.status)).toEqual(['ok', 'running'])
  await expect(again.stop(io, agents.port, 's1', 'review-1', 'Q')).rejects.toThrow('review-1 has no agent Q; it has A, B')
  expect(await again.stop(io, agents.port, 's1', 'review-1', 'A')).toEqual({ stopping: 0, unreachable: 0 })
  expect(await again.stop(io, agents.port, 's1', 'review-1')).toEqual({ stopping: 1, unreachable: 0 })
  expect(agents.stopped).toEqual(['a2'])
  await expect(again.stop(io, agents.port, 's1', 'review-9')).rejects.toThrow('no job review-9; jobs lists')
})

test('stop counts what really stops, apart from an agent that reads as running with nothing here to stop', async () => {
  const io = fakeIo()
  const agents = fakeAgents({ unreachable: ['a2'] })
  const jobs = makeJobs(ROOT)
  await jobs.begin(io, agents.port, fakeProviders(), input())
  expect(await jobs.stop(io, agents.port, 's1', 'review-1')).toEqual({ stopping: 1, unreachable: 1 })
})

test('two calls at once get ids of their own and folders of their own', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const [a, b] = await Promise.all([jobs.begin(io, agents.port, providers, input()), jobs.begin(io, agents.port, providers, input())])
  expect([a.id, b.id].sort()).toEqual(['review-1', 'review-2'])
  expect(a.dir).not.toBe(b.dir)
})

test('a job reads as done only once its last answer is kept, so a full read at that moment does not ack it short', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  let release: () => void = () => {}
  const write = io.write
  io.write = async (path, text) => {
    if (path.endsWith('/A.json')) await new Promise<void>(r => (release = r))
    return write(path, text)
  }
  const answer = done(JSON.stringify(ANSWER))
  const ending = jobs.ended(io, alert, agents.end('a1', answer), answer)
  await Promise.resolve()
  expect(jobs.isDone(job)).toBe(false)
  await jobs.report(io, agents.port, 's1', 'review-1', {})
  expect(job.isAcked).toBe(false)
  release()
  await ending
  expect(jobs.isDone(job)).toBe(true)
  expect(job.agents[0]!.findings).toBe(1)
})

test('an answer that can not be kept fails that agent with the reason, and the job still ends', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  const write = io.write
  io.write = async (path, text) => {
    if (path.endsWith('/A.json')) throw new Error('past the 4 MiB a write takes')
    return write(path, text)
  }
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  expect(jobs.isDone(job)).toBe(true)
  const summary = await jobs.summary(io, job, 's1')
  expect(summary).toContain('finished: no usable answer.')
  expect(summary).toContain('agent A: FAILED: its answer could not be kept: past the 4 MiB a write takes')
})

test('an answer half written reads as not there yet while its agent runs, and as an error once it finished', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  io.files.set(`${ROOT}/s1/review-1/A.json`, '{"status":"ok","ans')
  expect(await jobs.report(io, agents.port, 's1', 'review-1', {})).toStartWith('review-1 is still running')
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  io.files.set(`${ROOT}/s1/review-1/A.json`, '{"status":"ok","ans')
  await expect(jobs.report(io, agents.port, 's1', 'review-1', {})).rejects.toThrow(`crew: ${ROOT}/s1/review-1/A.json does not parse`)
  expect(job.isAcked).toBe(false)
})

test("a start that throws fails its agent with the reason, and the others run on", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const port = { ...agents.port, start: async (i: Parameters<typeof agents.port.start>[0]) => (i.label === 'A' ? Promise.reject(new Error('agents: no kind oneshot')) : agents.port.start(i)) }
  const job = await jobs.begin(io, port, providers, input())
  expect(job.agents[0]!.error).toBe('agents did not take it: agents: no kind oneshot')
  expect(jobs.statusOf(job.agents[0]!)).toBe('failed')
  expect(jobs.statusOf(job.agents[1]!)).toBe('running')
  expect(jobs.isDone(job)).toBe(false)
  expect(await jobs.report(io, agents.port, 's1', 'review-1', {})).toContain('agent A: FAILED: agents did not take it')
})

test('a start a reload cut short ends its agent as failed, where the job came from disk; one still starting here is left alone', async () => {
  const { io, agents, providers, alert } = setup()
  const first = makeJobs(ROOT)
  const job = await first.begin(io, agents.port, providers, input({ models: [SOL] }))
  const never = { ...job, agents: job.agents.map(({ agent: _a, ...e }) => e) }
  io.files.set(`${ROOT}/s1/review-1/job.json`, JSON.stringify(never))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const empty = { ...agents.port, list: async () => [] }
  const reloaded = makeJobs(ROOT)
  await reloaded.restore(io, empty, NO_ALERT, 's1')
  const restored = await reloaded.load(io, empty, 's1', 'review-1')
  expect(restored.agents[0]!.error).toBe('its start was cut short by a reload')
  expect(reloaded.isDone(restored)).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).agents[0].error).toBe('its start was cut short by a reload')

  let release: () => void = () => {}
  const slow = { ...agents.port, list: async () => [], start: async (i: Parameters<typeof agents.port.start>[0]) => (await new Promise<void>(r => (release = r)), agents.port.start(i)) }
  const here = makeJobs(ROOT)
  const starting = here.begin(io, slow, providers, input({ session: 's3', models: [SOL] }))
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await here.restore(io, slow, NO_ALERT, 's3')
  const held = here.sessionJobs('s3')[0]!
  expect(held.agents[0]!.error).toBeUndefined()
  release()
  await starting
  expect(here.statusOf(held.agents[0]!)).toBe('running')
})

const CHANGE_REPO = '/r'

/** Git answering by its arguments; a call it does not name is the test's failure. */
function gitIo(answers: Record<string, ReturnType<typeof ok>>) {
  return fakeIo({
    run: argv => {
      const args = argv.slice(5).join(' ')
      const answer = answers[args]
      if (answer === undefined) throw new Error(`unexpected git ${args}`)
      return answer
    },
  })
}

const changeInput = (diff: BeginInput['diff']) => input({ models: [SOL], read: [CHANGE_REPO], diff })
const inRepo = fakeProviders({ roots: { roots: [CHANGE_REPO], files: [] } })
const TOP = { 'rev-parse --show-toplevel': ok(`${CHANGE_REPO}\n`) }

test('a base diff is taken from where the branch left it; a commit diff from that commit', async () => {
  const base = gitIo({
    ...TOP,
    'merge-base HEAD main': ok('abcdef0123456789\n'),
    [`diff abcdef0123456789 --no-renames --name-only -z -- ${CHANGE_REPO}`]: ok('a.ts\0'),
    'diff abcdef0123456789 --no-renames -- a.ts': ok('+a\n'),
  })
  const onBase = await makeJobs(ROOT).begin(base, fakeAgents().port, inRepo, changeInput({ base: 'main' }))
  expect(onBase.diff).toBe('The changes on this branch of `/r` since it left `main` (merge base abcdef012345)')
  const commit = gitIo({
    ...TOP,
    'show -s --format=%h %s c0ffee': ok('c0ffee Fix it\n'),
    [`show --no-renames --name-only -z --format= c0ffee -- ${CHANGE_REPO}`]: ok('b.ts\0'),
    'show --format=%H %s%n%n%b c0ffee --no-renames -- b.ts': ok('+b\n'),
  })
  const onCommit = await makeJobs(ROOT).begin(commit, fakeAgents().port, inRepo, changeInput({ commit: 'c0ffee' }))
  expect(onCommit.diff).toBe('Commit c0ffee Fix it in `/r`')
})

test('a repository with no commits has its uncommitted changes read against nothing', async () => {
  const io = gitIo({
    ...TOP,
    'rev-parse --verify -q HEAD': ok('', '', 1),
    'hash-object -t tree /dev/null': ok('4b825dc\n'),
    [`diff 4b825dc --no-renames --name-only -z -- ${CHANGE_REPO}`]: ok('a.ts\0'),
    [`ls-files -z --others --exclude-standard -- ${CHANGE_REPO}`]: ok(''),
    'diff 4b825dc --no-renames -- a.ts': ok('+a\n'),
  })
  const agents = fakeAgents()
  await makeJobs(ROOT).begin(io, agents.port, inRepo, changeInput('uncommitted'))
  expect(agents.started[0]!.job.task).toContain('```diff\n+a\n\n```')
})

test('a name git would have quoted comes through whole, and a renamed file shows both its names', async () => {
  const io = gitIo({
    ...TOP,
    'rev-parse --verify -q HEAD': ok('abc\n'),
    [`diff HEAD --no-renames --name-only -z -- ${CHANGE_REPO}`]: ok('old name.ts\0новый.ts\0'),
    [`ls-files -z --others --exclude-standard -- ${CHANGE_REPO}`]: ok(''),
    'diff HEAD --no-renames -- old name.ts новый.ts': ok('-a\n+a\n'),
  })
  const agents = fakeAgents()
  await makeJobs(ROOT).begin(io, agents.port, inRepo, changeInput('uncommitted'))
  expect(agents.started[0]!.job.task).toContain('-a\n+a')
})

test('a diff git fails on, or one too long to brief, is refused with the reason, and nothing starts', async () => {
  const agents = fakeAgents()
  const failing = gitIo({ ...TOP, 'merge-base HEAD nosuch': ok('', 'fatal: Not a valid object name nosuch', 128) })
  await expect(makeJobs(ROOT).begin(failing, agents.port, inRepo, changeInput({ base: 'nosuch' }))).rejects.toThrow('crew: git merge-base HEAD nosuch failed in /r: fatal: Not a valid object name nosuch')
  const long = gitIo({
    ...TOP,
    'rev-parse --verify -q HEAD': ok('abc\n'),
    [`diff HEAD --no-renames --name-only -z -- ${CHANGE_REPO}`]: ok('a.ts\0'),
    [`ls-files -z --others --exclude-standard -- ${CHANGE_REPO}`]: ok(''),
    'diff HEAD --no-renames -- a.ts': ok('x'.repeat(401 * 1024)),
  })
  await expect(makeJobs(ROOT).begin(long, agents.port, inRepo, changeInput('uncommitted'))).rejects.toThrow('crew: the diff is 401 KiB, over 400 KiB; review a narrower change')
  expect(agents.started).toEqual([])
})

test('a stall that comes again after the agent moved on is told again, once', async () => {
  const { io, agents, providers, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, input({ models: [SOL] }))
  agents.healths.set('a1', { state: 'stalled', forMs: 11 * MINUTE, mark: 'silent:1' })
  io.advance(11 * MINUTE)
  await jobs.read(agents.port, 's1')
  expect(jobs.poke(job, await io.now())).toContain('no output for 11m')
  agents.healths.set('a1', { state: 'stalled', forMs: 11 * MINUTE, mark: 'silent:2' })
  io.advance(MINUTE)
  await jobs.read(agents.port, 's1')
  expect(jobs.poke(job, await io.now())).toContain('no output for 11m')
  io.advance(MINUTE)
  await jobs.read(agents.port, 's1')
  expect(jobs.poke(job, await io.now())).toBeUndefined()
})
