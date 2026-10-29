import type { ProvidersReadSpec } from 'cc-providers'
import { expect, test } from 'claude-code/testing'

import { FINDINGS_SCHEMA } from '../hooks/prompt.ts'
import { type BeginInput, makeReviews, Refused } from '../hooks/reviews.ts'
import { FINDINGS, fakeAgents, fakeIo, fakeProviders, ok } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'
const CACHE = '/home/u/.cache/crew'

function input(over: Partial<BeginInput> = {}): BeginInput {
  return {
    session: 's1',
    description: 'Check X',
    brief: 'Look at X.',
    specs: [{ provider: 'codex', effort: 'medium' }, { provider: 'claude', model: 'opus' }, { provider: 'codex', effort: 'medium' }],
    read: 'project',
    project: PROJECT,
    reportBase: `${PROJECT}/.claude/work/reviews`,
    web: false,
    helpers: false,
    system: 'SYSTEM',
    timeoutMs: 60_000,
    ...over,
  }
}

function setup(o: { refuseStart?: Record<string, string>; refuse?: Record<string, string> } = {}) {
  const io = fakeIo({ run: () => ok() })
  const agents = fakeAgents(o.refuseStart === undefined ? {} : { refuse: o.refuseStart })
  const providers = fakeProviders(o.refuse === undefined ? {} : { refuse: o.refuse })
  const alerts: string[] = []
  const alert = async (provider: string, detail: string) => {
    alerts.push(`${provider}: ${detail}`)
    return undefined
  }
  return { io, agents, providers, alerts, alert, reviews: makeReviews(CACHE) }
}

test("a review starts each reviewer through agents, grouped by the review and labelled by its key, with crew's findings schema and the hour-long cache", async () => {
  const { io, agents, providers, alert, reviews } = setup()
  const review = await reviews.begin(io, agents.port, providers, alert, input())
  expect(review.reviewers.map(r => [r.key, r.agent])).toEqual([['codex-default', 'a1'], ['claude-opus', 'a2'], ['codex-default-2', 'a3']])
  expect(agents.started.map(s => [s.provider, s.group, s.label])).toEqual([['codex', review.id, 'codex-default'], ['claude', review.id, 'claude-opus'], ['codex', review.id, 'codex-default-2']])
  expect(agents.started[1]!.job).toMatchObject({ dir: `${CACHE}/runs/${review.id}/claude-opus`, read: 'project', project: PROJECT, system: 'SYSTEM', model: 'opus', schema: FINDINGS_SCHEMA, cacheTtl: '1h', timeoutMs: 60_000 })
  expect(agents.started[0]!.job.task).toContain(`You may read: \`${PROJECT}\`. Web: not available.`)
  expect(review.reportDir).toBe(`${PROJECT}/.claude/work/reviews/${review.id}-check-x`)
  expect(io.files.get(`${review.reportDir}/brief.md`)).toContain('## Brief\n\nLook at X.')
  expect(JSON.parse(io.files.get(`${CACHE}/reviews/${review.id}.json`)!)).toMatchObject({ id: review.id, session: 's1' })
  expect(io.files.has(`${review.reportDir}/run.json`)).toBe(true)
  expect(reviews.isDone(review)).toBe(false)
})

test('a review whose reviewer may not start is refused whole, before anything starts', async () => {
  const { io, agents, providers, alert, reviews } = setup({ refuse: { claude: 'helpers spent $13.00 in the Claude pool' } })
  await expect(reviews.begin(io, agents.port, providers, alert, input())).rejects.toThrow('claude: helpers spent $13.00 in the Claude pool')
  expect(agents.started).toHaveLength(0)
  await expect(reviews.begin(io, agents.port, providers, alert, input({ read: 'none', changes: 'uncommitted', specs: [{ provider: 'codex' }] }))).rejects.toBeInstanceOf(Refused)
})

test('each reviewer that ends gets its report and findings; one signed out is told to the person; the review is done when none runs', async () => {
  const { io, agents, providers, alerts, alert, reviews } = setup()
  const review = await reviews.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'codex' }, { provider: 'claude', model: 'opus' }] }))
  let isDone = false
  void reviews.whenDone(review.id).then(() => (isDone = true))
  const first = agents.end('a1', { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol', continueId: 'th-1' }, { costUsd: 0.42, cacheUntil: new Date(2026, 9, 29, 22, 5).getTime() })
  expect(await reviews.ended(io, alert, first, { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol' })).toBe(review)
  await Promise.resolve()
  expect(isDone).toBe(false)
  expect(io.files.get(`${review.reportDir}/codex-default.md`)).toContain('### [P1] Off by one')
  const second = agents.end('a2', { status: 'signed_out', text: '', model: 'opus', detail: 'claude was refused its credentials' })
  await reviews.ended(io, alert, second, { status: 'signed_out', text: '', model: 'opus', detail: 'claude was refused its credentials' })
  await Promise.resolve()
  expect(isDone).toBe(true)
  expect(alerts).toEqual(['claude: claude was refused its credentials'])
  const summary = reviews.summary(review)
  expect(summary).toContain(`crew review ${review.id} "Check X": 2 reviewers, 1 ok, 1 signed_out.`)
  expect(summary).toContain(`- codex-default (gpt-6.1-sol): 1 findings · $0.42 · cache warm until 22:05 → ${review.reportDir}/codex-default.md`)
  expect(summary).toContain('- claude-opus (opus): SIGNED OUT: claude was refused its credentials')
  expect(await reviews.ended(io, alert, { ...first, group: 'someone-else' }, { status: 'ok', text: '', model: 'm' })).toBeUndefined()
})

test('a reviewer refused at its start is reported at once, with no end to wait for', async () => {
  const { io, agents, providers, alert, reviews } = setup({ refuseStart: { claude: 'helpers spent $13.00 in the Claude pool' } })
  const review = await reviews.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'claude', model: 'opus' }] }))
  expect(reviews.isDone(review)).toBe(true)
  expect(io.files.get(`${review.reportDir}/claude-opus.md`)).toContain('status: limit (helpers spent $13.00 in the Claude pool)')
  expect(reviews.summary(review)).toContain('- claude-opus (opus): REFUSED AT ITS LIMIT: helpers spent $13.00 in the Claude pool')
})

test('a follow-up goes to a finished reviewer from its own session, after the limit check; its report carries the question', async () => {
  const { io, agents, providers, alert, reviews } = setup()
  const review = await reviews.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'codex' }] }))
  await expect(reviews.ask(io, agents.port, providers, alert, 's1', review.id, 'codex-default', 'And Y?')).rejects.toThrow('codex-default is still running')
  await reviews.ended(io, alert, agents.end('a1', { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol', continueId: 'th-1' }), { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol' })
  await expect(reviews.ask(io, agents.port, providers, alert, 's1', review.id, 'nobody', 'And Y?')).rejects.toThrow('has no reviewer nobody; it has codex-default')
  const { run } = await reviews.ask(io, agents.port, providers, alert, 's1', review.id, 'codex-default', 'And Y?')
  expect(run.status).toBe('running')
  expect(agents.followed).toEqual([{ session: 's1', id: 'a1', message: 'And Y?' }])
  let isAnswered = false
  void reviews.whenAnswered('a1').then(() => (isAnswered = true))
  const answered = agents.end('a1', { status: 'ok', text: 'Y is fine.', model: 'gpt-6.1-sol' })
  await reviews.ended(io, alert, answered, { status: 'ok', text: 'Y is fine.', model: 'gpt-6.1-sol' })
  await Promise.resolve()
  expect(isAnswered).toBe(true)
  const report = io.files.get(`${review.reportDir}/codex-default-followup-1.md`)!
  expect(report).toContain('## Follow-up asked\n\nAnd Y?')
  expect(report).toContain('## Answer (not in the findings format)\n\nY is fine.')
  const refusing = fakeProviders({ refuse: { codex: 'codex switched off for this session' } })
  await expect(reviews.ask(io, agents.port, refusing, alert, 's1', review.id, 'codex-default', 'And Z?')).rejects.toThrow('codex: codex switched off for this session')
})

test("a reviewer whose end comes before its start's answer keeps its report; one ended in its answer waits for its end", async () => {
  const { io, agents, providers, alert, reviews } = setup()
  const done = { status: 'ok' as const, text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol', continueId: 'th-1' }
  let late: (() => Promise<unknown>) | undefined
  const port = {
    ...agents.port,
    start: async (i: Parameters<typeof agents.port.start>[0]) => {
      const run = await agents.port.start(i)
      const ended = agents.end(run.id, done)
      // the first reviewer's end arrives before its answer, the second's after it
      if (i.label === 'codex-default') await reviews.ended(io, alert, ended, done)
      else late = () => reviews.ended(io, alert, ended, done)
      return ended
    },
  }
  const review = await reviews.begin(io, port, providers, alert, input({ specs: [{ provider: 'codex' }, { provider: 'claude', model: 'opus' }] }))
  expect(review.reviewers.map(r => [r.key, r.agent, r.findings])).toEqual([['codex-default', 'a1', 1], ['claude-opus', 'a2', undefined]])
  expect(io.files.get(`${review.reportDir}/codex-default.md`)).toContain('### [P1] Off by one')
  expect(reviews.statusOf(review.reviewers[1]!)).toBe('running')
  expect(reviews.isDone(review)).toBe(false)
  await late!()
  expect(reviews.isDone(review)).toBe(true)
  expect(io.files.get(`${review.reportDir}/claude-opus.md`)).toContain('### [P1] Off by one')
})

test('a reload while a review started binds its reviewers to the runs agents kept for them', async () => {
  const { io, agents, providers, alert } = setup()
  const first = makeReviews(CACHE)
  const review = await first.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'codex' }] }))
  // as the review was written before its reviewers' starts answered
  const unbound = { ...review, reviewers: review.reviewers.map(({ agent: _a, ...e }) => e) }
  io.files.set(`${CACHE}/reviews/${review.id}.json`, JSON.stringify(unbound))
  const reloaded = makeReviews(CACHE)
  await reloaded.restore(io, agents.port, 's1')
  const restored = await reloaded.load(io, agents.port, review.id)
  expect(restored.reviewers[0]!.agent).toBe('a1')
  expect(reloaded.statusOf(restored.reviewers[0]!)).toBe('running')
  expect(JSON.parse(io.files.get(`${CACHE}/reviews/${review.id}.json`)!).reviewers[0].agent).toBe('a1')
})

test("a review from another session is read with its reviewers' runs; an unparsed follow-up leaves no findings count", async () => {
  const { io, agents, providers, alert } = setup()
  const own = makeReviews(CACHE)
  const review = await own.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'codex' }] }))
  await own.ended(io, alert, agents.end('a1', { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol', continueId: 'th-1' }), { status: 'ok', text: JSON.stringify(FINDINGS), model: 'gpt-6.1-sol' })
  const other = makeReviews(CACHE)
  const read = await other.load(io, agents.port, review.id)
  expect(other.summary(read)).toContain('- codex-default (gpt-6.1-sol): 1 findings')
  await own.ask(io, agents.port, providers, alert, 's1', review.id, 'codex-default', 'And Y?')
  await own.ended(io, alert, agents.end('a1', { status: 'ok', text: 'Y is fine.', model: 'gpt-6.1-sol' }), { status: 'ok', text: 'Y is fine.', model: 'gpt-6.1-sol' })
  expect(own.summary(review)).toContain(`- codex-default (gpt-6.1-sol): unparsed findings → ${review.reportDir}/codex-default-followup-1.md`)
})

test('a change is read in the first read path the call names, though the paths resolve sorted', async () => {
  const io = fakeIo({
    run: argv => {
      if (argv[2] !== '/r/zeta') throw new Error(`git ran in ${argv[2]}`)
      const args = argv.slice(3).join(' ')
      if (args === 'diff HEAD --name-only') return ok('a.ts\n')
      if (args === 'ls-files --others --exclude-standard') return ok('')
      if (args === 'diff HEAD -- a.ts') return ok('+a\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const providers = { ...fakeProviders(), roots: async ({ read }: { read: ProvidersReadSpec }) => ({ roots: [...(read as string[])].sort(), files: [] }) }
  const agents = fakeAgents()
  const review = await makeReviews(CACHE).begin(io, agents.port, providers, async () => undefined, input({ specs: [{ provider: 'codex' }], read: ['/r/zeta', '/r/alpha'], changes: 'uncommitted' }))
  expect(review.roots).toEqual(['/r/alpha', '/r/zeta'])
  expect(review.changes).toBe('The uncommitted changes (staged and unstaged) in `/r/zeta`')
})

test("a change's diff leaves out the files whose names providers marks secret", async () => {
  const io = fakeIo({
    run: argv => {
      const args = argv.slice(3).join(' ')
      if (args === 'diff HEAD --name-only') return ok('main.ts\n.env\n')
      if (args === 'ls-files --others --exclude-standard') return ok('new.ts\nkey.pem\n')
      if (args === 'diff HEAD -- main.ts') return ok('+fix\n')
      throw new Error(`unexpected git ${args}`)
    },
  })
  const agents = fakeAgents()
  const reviews = makeReviews(CACHE)
  const review = await reviews.begin(io, agents.port, fakeProviders(), async () => undefined, input({ specs: [{ provider: 'codex' }], changes: 'uncommitted' }))
  expect(review.changes).toBe(`The uncommitted changes (staged and unstaged) in \`${PROJECT}\` (1 secret file left out of the diff)`)
  const task = agents.started[0]!.job.task
  expect(task).toContain('- new.ts')
  expect(task).not.toContain('key.pem')
  expect(task).toContain('```diff\n+fix\n\n```')
})

test("a reload finds the session's reviews on disk with their reviewers' runs; stop reaches only reviewers still running", async () => {
  const { io, agents, providers, alert, reviews } = setup()
  const review = await reviews.begin(io, agents.port, providers, alert, input({ specs: [{ provider: 'codex' }, { provider: 'claude' }] }))
  await reviews.ended(io, alert, agents.end('a1', { status: 'ok', text: '', model: 'gpt-6.1-sol' }), { status: 'ok', text: '', model: 'gpt-6.1-sol' })
  const again = makeReviews(CACHE)
  await again.restore(io, agents.port, 's1')
  expect(again.sessionReviews('s1').map(r => r.id)).toEqual([review.id])
  expect(again.sessionReviews('s2')).toEqual([])
  expect(again.viewOf(again.sessionReviews('s1')[0]!).reviewers.map(r => r.status)).toEqual(['ok', 'running'])
  await again.stop(agents.port, review.id)
  expect(agents.stopped).toEqual(['a2'])
})
