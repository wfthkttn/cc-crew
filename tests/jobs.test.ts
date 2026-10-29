import type { ProvidersReadSpec } from 'cc-providers'
import { expect, test } from 'claude-code/testing'

import { type BeginInput, labelOf, makeJobs, type Picked, Refused, titleOf } from '../hooks/jobs.ts'
import { REPORT_SCHEMA } from '../hooks/report.ts'
import { ANSWER, fakeAgents, fakeIo, fakeProviders, ok } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'
const ROOT = '/home/u/.claude/crew'
const CACHE = '/home/u/.cache/crew'
const MINUTE = 60_000

const pick = (serves: string, provider: string, model: string, over: Partial<Picked> = {}): Picked => ({
  serves,
  provider,
  model,
  key: `${provider}/${model}`,
  web: false,
  helpers: false,
  timeoutMs: 60 * MINUTE,
  pokeMs: 20 * MINUTE,
  stallMs: 10 * MINUTE,
  ...over,
})

const GEMINI = pick('google/gemini-3.8-flash', 'antigravity', 'gemini-3.8-flash')
const SOL = pick('openai/gpt-6.1-sol', 'codex', 'gpt-6.1-sol', { effort: 'medium' })

function input(over: Partial<BeginInput> = {}): BeginInput {
  return { session: 's1', job: 'review', brief: 'Look at X.\nMore on X.', picks: [GEMINI, SOL], skipped: [], kind: 'oneshot', read: ['.'], project: PROJECT, system: 'SYSTEM', ...over }
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
  return { io, agents, providers, alerts, alert, jobs: makeJobs(ROOT, CACHE) }
}

const done = (text: string) => ({ status: 'ok' as const, text, model: 'm', continueId: 'th-1' })

test('agents are lettered A to Z, then A2; a title is the brief\'s first line, cut short', () => {
  expect([0, 1, 25, 26, 52].map(labelOf)).toEqual(['A', 'B', 'Z', 'A2', 'A3'])
  expect(titleOf('  Look at X.\nMore.')).toBe('Look at X.')
  expect(titleOf('x'.repeat(100))).toHaveLength(60)
})

test("a job starts each agent through agents as its kind, grouped by the job, lettered, with crew's report schema, each with its model's own settings", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input({ picks: [GEMINI, pick('openai/gpt-6.1-sol', 'codex', 'gpt-6.1-sol', { effort: 'medium', web: true, timeoutMs: 5 * MINUTE })], skipped: [{ serves: 'zhipu/glm-5.3', why: 'closed' }] }))
  expect(job).toMatchObject({ id: 'review-1', job: 'review', title: 'Look at X.', session: 's1', dir: `${ROOT}/s1/review-1`, isAcked: false, skipped: [{ serves: 'zhipu/glm-5.3', why: 'closed' }] })
  expect(job.agents.map(a => [a.label, a.agent])).toEqual([['A', 'a1'], ['B', 'a2']])
  expect(agents.started.map(s => [s.provider, s.kind, s.group, s.label])).toEqual([['antigravity', 'oneshot', 's1/review-1', 'A'], ['codex', 'oneshot', 's1/review-1', 'B']])
  expect(agents.started[1]!.job).toMatchObject({ dir: `${CACHE}/runs/s1-review-1-B`, read: ['.'], project: PROJECT, system: 'SYSTEM', model: 'gpt-6.1-sol', effort: 'medium', web: true, schema: REPORT_SCHEMA, timeoutMs: 5 * MINUTE })
  expect(agents.started[0]!.job.task).toContain('Web: not available.')
  expect(agents.started[1]!.job.task).toContain('Web: allowed.')
  expect(io.files.get(`${ROOT}/s1/review-1/brief.md`)).toBe('Look at X.\nMore on X.')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!)).toMatchObject({ id: 'review-1', agents: [{ label: 'A', key: 'antigravity/gemini-3.8-flash' }, { label: 'B', key: 'codex/gpt-6.1-sol' }] })
  expect(jobs.isDone(job)).toBe(false)
  expect((await jobs.begin(io, agents.port, providers, alert, input())).id).toBe('review-2')
  expect((await jobs.begin(io, agents.port, providers, alert, input({ job: 'research', read: 'none' }))).id).toBe('research-1')
})

test('a diff without paths to find the repository by is refused before anything starts', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await expect(jobs.begin(io, agents.port, providers, alert, input({ read: 'none', diff: 'uncommitted' }))).rejects.toBeInstanceOf(Refused)
  expect(agents.started).toHaveLength(0)
})

test('each agent that ends leaves its answer; one signed out is told to the person; the summary names no model and says how to read it', async () => {
  const { io, agents, providers, alerts, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input())
  let isDone = false
  void jobs.whenDone(job).then(() => (isDone = true))
  const answer = done(JSON.stringify(ANSWER))
  expect(await jobs.ended(io, alert, agents.end('a1', answer), answer)).toBe(job)
  await Promise.resolve()
  expect(isDone).toBe(false)
  expect(job.agents[0]!.findings).toBe(1)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A.json`)!)).toMatchObject({ status: 'ok', model: 'm', answer: { not_read: ['vendor/'] } })
  const out = { status: 'signed_out' as const, text: '', model: 'gpt-6.1-sol', detail: 'Codex is signed out' }
  await jobs.ended(io, alert, agents.end('a2', out), out)
  await Promise.resolve()
  expect(isDone).toBe(true)
  expect(alerts).toEqual(['codex: Codex is signed out'])
  const summary = await jobs.summary(io, job)
  expect(summary).toContain('review-1 "Look at X." finished: 1 findings in Parser (1), Limits (0).')
  expect(summary).toContain('agent B: SIGNED OUT.')
  expect(summary).toContain('Read it with report { id: "review-1" }')
  expect(summary).not.toContain('gpt')
  expect(summary).not.toContain('gemini')
  expect(summary).not.toContain('codex')
  const stranger = { ...agents.end('a1', answer), group: 'someone-else' }
  expect(await jobs.ended(io, alert, stranger, answer)).toBeUndefined()
})

test('the report reads whole, by scope or as findings alone; only the whole read acks it, and none of them names a model', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input())
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

test('a whole read of a job still running shows what it has and acks nothing; an answer outside the format is shown as it came', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input())
  const answer = done('Just prose.')
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  const text = await jobs.report(io, agents.port, 's1', 'review-1', {})
  expect(text).toStartWith('review-1 is still running; this is what it has so far.')
  expect(text).toContain('## Answer not in the report format (agent A)\n\nJust prose.')
  expect(job.isAcked).toBe(false)
})

test('an agent refused at its start is kept at once, with no end to wait for', async () => {
  const { io, agents, providers, alert, jobs } = setup({ refuseStart: { codex: 'helpers spent $13.00 in the Codex pool' } })
  const job = await jobs.begin(io, agents.port, providers, alert, input({ picks: [SOL] }))
  expect(jobs.isDone(job)).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A.json`)!)).toMatchObject({ status: 'limit', detail: 'helpers spent $13.00 in the Codex pool' })
  expect(await jobs.summary(io, job)).toContain('agent A: REFUSED AT ITS LIMIT.')
  await expect(jobs.ask(io, agents.port, providers, alert, 's1', 'review-1', 'A', 'Again?')).rejects.toThrow('before its conversation began, so a follow-up has nothing to continue; start a new one instead')
  expect(agents.followed).toEqual([])
})

test('a follow-up, kept for jobs that live on, goes to a finished agent from its own session after the limit check, and keeps its answer apart', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await jobs.begin(io, agents.port, providers, alert, input({ picks: [SOL] }))
  await expect(jobs.ask(io, agents.port, providers, alert, 's1', 'review-1', 'A', 'And Y?')).rejects.toThrow('agent A is still running')
  const first = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', first), first)
  await expect(jobs.ask(io, agents.port, providers, alert, 's1', 'review-1', 'Z', 'And Y?')).rejects.toThrow('review-1 has no agent Z; it has A')
  const { run } = await jobs.ask(io, agents.port, providers, alert, 's1', 'review-1', 'A', 'And Y?')
  expect(run.status).toBe('running')
  expect(agents.followed).toEqual([{ session: 's1', id: 'a1', message: 'And Y?' }])
  let isAnswered = false
  void jobs.whenAnswered('a1').then(() => (isAnswered = true))
  const second = done('Y is fine.')
  await jobs.ended(io, alert, agents.end('a1', second), second)
  await Promise.resolve()
  expect(isAnswered).toBe(true)
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/A-followup-1.json`)!)).toMatchObject({ message: 'And Y?', text: 'Y is fine.' })
  const refusing = fakeProviders({ refuse: { codex: 'codex switched off for this session' } })
  await expect(jobs.ask(io, agents.port, refusing, alert, 's1', 'review-1', 'A', 'And Z?')).rejects.toThrow('agent A: codex switched off for this session')
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
  const job = await jobs.begin(io, port, providers, alert, input())
  expect(job.agents.map(a => [a.label, a.agent, a.findings])).toEqual([['A', 'a1', 1], ['B', 'a2', undefined]])
  expect(jobs.statusOf(job.agents[1]!)).toBe('running')
  expect(jobs.isDone(job)).toBe(false)
  await late!()
  expect(jobs.isDone(job)).toBe(true)
  expect(job.agents[1]!.findings).toBe(1)
})

test('a reload while a job started binds its agents to the runs agents kept for them', async () => {
  const { io, agents, providers, alert } = setup()
  const first = makeJobs(ROOT, CACHE)
  const job = await first.begin(io, agents.port, providers, alert, input({ picks: [SOL] }))
  const unbound = { ...job, agents: job.agents.map(({ agent: _a, ...e }) => e) }
  io.files.set(`${ROOT}/s1/review-1/job.json`, JSON.stringify(unbound))
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const reloaded = makeJobs(ROOT, CACHE)
  await reloaded.restore(io, agents.port, 's1')
  const restored = await reloaded.load(io, agents.port, 's1', 'review-1')
  expect(restored.agents[0]!.agent).toBe('a1')
  expect(reloaded.statusOf(restored.agents[0]!)).toBe('running')
  expect(JSON.parse(io.files.get(`${ROOT}/s1/review-1/job.json`)!).agents[0].agent).toBe('a1')
})

test("a job of another session is read by its full id, with its agents' runs; an unknown one says where to look", async () => {
  const { io, agents, providers, alert } = setup()
  const own = makeJobs(ROOT, CACHE)
  await own.begin(io, agents.port, providers, alert, input({ picks: [SOL] }))
  const answer = done(JSON.stringify(ANSWER))
  await own.ended(io, alert, agents.end('a1', answer), answer)
  const other = makeJobs(ROOT, CACHE)
  expect(await other.report(io, agents.port, 's2', 's1/review-1', { findingsOnly: true })).toContain('Off by one')
  await expect(other.report(io, agents.port, 's2', 'review-1', {})).rejects.toThrow('no job review-1; jobs lists this session')
})

test('liveness tells a stalled agent once, a call first and silence after; it reads each running agent and says what it is on', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input())
  const start = await io.now()
  agents.activities.set('a1', { lastAt: start, steps: 3, open: [{ tool: 'WebFetch', target: 'https://x.invalid', since: start }] })
  agents.activities.set('a2', { lastAt: start, steps: 1, open: [] })
  io.advance(5 * MINUTE)
  await jobs.read(agents.port, 's1', await io.now())
  expect(jobs.poke(job, await io.now())).toBeUndefined()
  expect(jobs.viewOf(job).agents.map(a => a.reading?.text)).toEqual(['working: WebFetch', 'working, 1 step done'])
  io.advance(6 * MINUTE)
  await jobs.read(agents.port, 's1', await io.now())
  const poke = jobs.poke(job, await io.now())!
  expect(poke).toContain('review-1 "Look at X.", running 11m:')
  expect(poke).toContain('agent A: waiting on WebFetch https://x.invalid for 11m')
  expect(poke).toContain('agent B: no output for 11m')
  expect(poke).toContain('stop { id: "review-1", agent: "<letter>" }')
  expect(poke).not.toContain('gemini')
  expect(jobs.viewOf(job).agents.map(a => a.reading?.isStalled)).toEqual([true, true])
  io.advance(MINUTE)
  await jobs.read(agents.port, 's1', await io.now())
  expect(jobs.poke(job, await io.now())).toBeUndefined()
})

test('an agent that ends badly is told while the others run; a job past its shortest poke is told as a status; a finished job pokes no more', async () => {
  const { io, agents, providers, alert, jobs } = setup()
  const job = await jobs.begin(io, agents.port, providers, alert, input({ picks: [GEMINI, pick('openai/gpt-6.1-sol', 'codex', 'gpt-6.1-sol', { pokeMs: 15 * MINUTE })] }))
  agents.activities.set('a1', { lastAt: await io.now(), steps: 0, open: [] })
  const failed = { status: 'failed' as const, text: '', model: 'm', detail: 'boom' }
  await jobs.ended(io, alert, agents.end('a2', failed), failed)
  expect(jobs.poke(job, await io.now())).toContain('agent B: FAILED')
  io.advance(14 * MINUTE)
  expect(jobs.poke(job, await io.now())).toBeUndefined()
  io.advance(6 * MINUTE)
  agents.activities.set('a1', { lastAt: await io.now(), steps: 9, open: [] })
  await jobs.read(agents.port, 's1', await io.now())
  expect(jobs.poke(job, await io.now())).toContain('agent A: working, 9 steps done')
  const answer = done(JSON.stringify(ANSWER))
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  io.advance(60 * MINUTE)
  expect(jobs.poke(job, await io.now())).toBeUndefined()
})

test('a diff is read in the first path the call names, though the paths resolve sorted', async () => {
  const io = fakeIo({
    run: argv => {
      if (argv[2] !== '/r/zeta') throw new Error(`git ran in ${argv[2]}`)
      const args = argv.slice(3).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok('/r/zeta\n')
      if (args === 'diff HEAD --name-only -- /r/zeta') return ok('a.ts\n')
      if (args === 'ls-files --others --exclude-standard -- /r/zeta') return ok('')
      if (args === 'diff HEAD -- a.ts') return ok('+a\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const providers = { ...fakeProviders(), roots: async ({ read }: { read: ProvidersReadSpec }) => ({ roots: [...(read as string[])].sort(), files: [] }) }
  const agents = fakeAgents()
  const job = await makeJobs(ROOT, CACHE).begin(io, agents.port, providers, async () => undefined, input({ picks: [SOL], read: ['/r/zeta', '/r/alpha'], diff: 'uncommitted' }))
  expect(job.roots).toEqual(['/r/alpha', '/r/zeta'])
  expect(job.diff).toBe('The uncommitted changes (staged and unstaged) in `/r/zeta`')
})

test("a diff leaves out the files whose names providers marks secret", async () => {
  const io = fakeIo({
    run: argv => {
      const args = argv.slice(3).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok(`${PROJECT}\n`)
      if (args === `diff HEAD --name-only -- ${PROJECT}`) return ok('main.ts\n.env\n')
      if (args === `ls-files --others --exclude-standard -- ${PROJECT}`) return ok('new.ts\nkey.pem\n')
      if (args === 'diff HEAD -- main.ts') return ok('+fix\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const agents = fakeAgents()
  const job = await makeJobs(ROOT, CACHE).begin(io, agents.port, fakeProviders(), async () => undefined, input({ picks: [SOL], diff: 'uncommitted' }))
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
      const args = argv.slice(3).join(' ')
      if (args === 'rev-parse --show-toplevel') return ok('/r\n')
      if (argv[2] !== '/r') throw new Error(`git ran in ${argv[2]} after the top was found`)
      if (args === `diff HEAD --name-only -- ${allowed}`) return ok('src/allowed.ts\n')
      if (args === `ls-files --others --exclude-standard -- ${allowed}`) return ok('')
      if (args === 'diff HEAD -- src/allowed.ts') return ok('+ok\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const providers = fakeProviders({ roots: { roots: [allowed], files: [allowed] } })
  const agents = fakeAgents()
  const job = await makeJobs(ROOT, CACHE).begin(io, agents.port, providers, async () => undefined, input({ picks: [SOL], read: [allowed], diff: 'uncommitted' }))
  expect(job.diff).toBe('The uncommitted changes (staged and unstaged) in `/r`')
  expect(agents.started[0]!.job.task).toContain('```diff\n+ok\n\n```')
})

test("a reload finds the session's jobs on disk with their agents' runs; stop reaches only agents still running, and says when it names none", async () => {
  const { io, agents, providers, alert, jobs } = setup()
  await jobs.begin(io, agents.port, providers, alert, input())
  const answer = done('')
  await jobs.ended(io, alert, agents.end('a1', answer), answer)
  io.dirs.add(`${ROOT}/s1`)
  io.dirs.add(`${ROOT}/s1/review-1`)
  const again = makeJobs(ROOT, CACHE)
  await again.restore(io, agents.port, 's1')
  expect(again.sessionJobs('s1').map(j => j.id)).toEqual(['review-1'])
  expect(again.sessionJobs('s2')).toEqual([])
  expect(again.viewOf(again.sessionJobs('s1')[0]!).agents.map(a => a.status)).toEqual(['ok', 'running'])
  await expect(again.stop(agents.port, 's1', 'review-1', 'Q')).rejects.toThrow('review-1 has no agent Q; it has A, B')
  expect(await again.stop(agents.port, 's1', 'review-1', 'A')).toBe(0)
  expect(await again.stop(agents.port, 's1', 'review-1')).toBe(1)
  expect(agents.stopped).toEqual(['a2'])
  await expect(again.stop(agents.port, 's1', 'review-9')).rejects.toThrow('no job review-9 in this session')
})
