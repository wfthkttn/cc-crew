import { expect, test } from 'claude-code/testing'

import { checkJobs, effective, mergeCrew, modelsFor, parseCrewFile, settingsFrom } from '../hooks/config.ts'
import { readingOf } from '../hooks/liveness.ts'
import { systemPrompt, taskText, toolDescription } from '../hooks/prompt.ts'
import { fullReport, merge, parseAnswer, scopeList, scopeReport } from '../hooks/report.ts'
import { ANSWER } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'

test("a job's tool says what its agents may do by the job's own profile", () => {
  expect(toolDescription('Do it.', false).startsWith('Do it.\n\n')).toBe(true)
  expect(toolDescription('Do it.', false)).toContain('and they change nothing.')
  expect(toolDescription('Do it.', true)).toContain('and they may change those paths.')
  expect(toolDescription('Do it.', true)).not.toContain('change nothing')
  expect(toolDescription('Do it.', undefined)).toContain('cc-agents has no such profile, so a call is refused.')
})

test('an answer is read from bare JSON or JSON inside prose; anything else is no answer', () => {
  expect(parseAnswer(JSON.stringify(ANSWER))?.scopes).toHaveLength(2)
  expect(parseAnswer('Here:\n```json\n' + JSON.stringify(ANSWER) + '\n```')?.not_read).toEqual(['vendor/'])
  expect(parseAnswer('no json here')).toBeUndefined()
  expect(parseAnswer('{"scopes":[{"scope":"x"}]}')).toBeUndefined()
  expect(parseAnswer('{"summary":"the old shape","findings":[]}')).toBeUndefined()
})

test('scopes of one name join across agents, spelling and case aside; findings are kept as each agent gave them', () => {
  const a = parseAnswer(JSON.stringify(ANSWER))!
  const b = { scopes: [{ scope: ' parser', report: 'Agrees.', findings: a.scopes[0]!.findings, references: [] }], not_read: ['vendor/', 'dist/'] }
  const m = merge([{ agent: 'A', answer: a }, { agent: 'B', answer: b }, { agent: 'C', text: '  ' }])
  expect(m.scopes.map(s => [s.scope, s.takes.map(t => t.agent)])).toEqual([['Parser', ['A', 'B']], ['Limits', ['A']]])
  expect(m.notRead).toEqual(['vendor/', 'dist/'])
  expect(m.unformatted).toEqual([])
  expect(scopeList(m)).toBe('Parser (2), Limits (0)')
  expect(scopeReport(m, 'PARSER')).toContain('Agrees.')
  expect(scopeReport(m, 'nope')).toBeUndefined()
  expect(fullReport(merge([]))).toBe('The report is empty: no agent left an answer.')
})

test("the job's prompt comes first, the shared report format next, the person's rules last; the task states the access", () => {
  const s = systemPrompt('You review.\n', [{ path: '/r.md', text: 'Cite file:line.' }])
  expect(s).toStartWith('You review.\n\nAnswer with one JSON object')
  expect(s).toEndWith('## Rules from the person you work for\n\n### /r.md\n\nCite file:line.')
  expect(systemPrompt('You review.', [])).not.toContain('Rules from')
  expect(taskText({ brief: 'Look at X', roots: [PROJECT], web: false })).toContain(`You may read: \`${PROJECT}\`. Web: not available.`)
  expect(taskText({ brief: 'Look at X', roots: [], web: true })).toContain('You may read: nothing on disk. Web: allowed.')
})

test('the settings give the rule files', () => {
  expect(settingsFrom({ reviewer_rules: ['/r.md'] })).toEqual({ rules: ['/r.md'] })
})

const SHIPPED = JSON.stringify({
  jobs: {
    review: {
      description: 'Review.',
      prompt: 'prompts/review.md',
      kind: 'oneshot',
      profile: 'read-only',
      prefer: ['quota', 'unread'],
      web: false,
      helpers: false,
      paths: 'required',
      diff: true,
      timeoutMin: 60,
      pokeMin: 20,
      stallMin: 10,
      models: { 'v/fast': {}, 'v/deep': { effort: 'high', web: true, timeoutMin: 90, pokeMin: 40, stallMin: 30, provider: 'p' } },
      default: ['v/fast'],
      bySessionModel: { 'claude/opus': ['v/deep', 'v/fast'] },
    },
  },
})

test("a prompt is found from its crew file's folder; a machine's own file changes a job field by field and adds models and jobs", () => {
  const own = parseCrewFile(JSON.stringify({ jobs: { review: { default: ['v/new'], models: { 'v/new': {} } } } }), '/own/crew.json')
  const crew = mergeCrew(parseCrewFile(SHIPPED, '/ship/crew.json'), own, '/w')
  const review = crew.jobs['review']!
  expect(review.prompt).toBe('/ship/prompts/review.md')
  expect(review.default).toEqual(['v/new'])
  expect(Object.keys(review.models)).toEqual(['v/fast', 'v/deep', 'v/new'])
  expect(review.kind).toBe('oneshot')
})

test('a crew file that leaves a job short, runs a model it does not list, or takes a shared tool\'s name is refused, naming the file', () => {
  const shipped = parseCrewFile(SHIPPED, '/crew.json')
  expect(() => mergeCrew({ jobs: { x: { kind: 'oneshot' } } }, null, '/w')).toThrow('crew: /w: job x needs description, prompt, profile, prefer, web, helpers, paths, diff, timeoutMin, pokeMin, stallMin, models, default')
  expect(() => mergeCrew(shipped, { jobs: { review: { default: ['v/ghost'] } } }, '/w')).toThrow('crew: /w: job review runs v/ghost, none of its models (v/fast, v/deep)')
  expect(() => mergeCrew(shipped, { jobs: { review: { default: [] } } }, '/w')).toThrow('crew: /w: job review needs a model in default')
  expect(() => parseCrewFile('{ "jobs": { "report": {} } }', '/c.json')).toThrow('crew: /c.json: job report: a job\'s name is its tool\'s, lower case, and none of jobs, report, stop')
  expect(() => parseCrewFile('{ "jobs": { "x": { "paths": "maybe" } } }', '/c.json')).toThrow('crew: /c.json: job x: paths must be "required" or "optional"')
  expect(() => parseCrewFile('{ "jobs": { "x": { "models": { "v/m": { "pokeMin": 0 } } } } }', '/c.json')).toThrow("crew: /c.json: job x's model v/m has a pokeMin that is no positive number of minutes")
  expect(() => parseCrewFile('{', '/c.json')).toThrow('crew: /c.json: not JSON')
  expect(() => parseCrewFile('{}', '/c.json')).toThrow('crew: /c.json: must be an object with jobs, by name')
})

test("a model's settings stand over the job's and the tab's poke over both; the tab's ticks stand over the session model's list and the default", () => {
  const job = mergeCrew(parseCrewFile(SHIPPED, '/crew.json'), null, '/w').jobs['review']!
  expect(effective(job, 'v/fast', undefined)).toEqual({ serves: 'v/fast', web: false, helpers: false, timeoutMs: 3_600_000, pokeMs: 1_200_000, stallMs: 600_000 })
  expect(effective(job, 'v/deep', undefined)).toEqual({ serves: 'v/deep', provider: 'p', effort: 'high', web: true, helpers: false, timeoutMs: 5_400_000, pokeMs: 2_400_000, stallMs: 1_800_000 })
  expect(effective(job, 'v/deep', 5).pokeMs).toBe(300_000)
  expect(() => effective(job, 'v/ghost', undefined)).toThrow("v/ghost is none of the job's models")
  expect(modelsFor(job, 'claude/haiku', undefined)).toEqual(['v/fast'])
  expect(modelsFor(job, 'claude/opus', undefined)).toEqual(['v/deep', 'v/fast'])
  expect(modelsFor(job, 'claude/opus', { ticked: [] })).toEqual([])
  expect(modelsFor(job, 'claude/opus', { ticked: ['v/gone', 'v/fast'] })).toEqual(['v/fast'])
})

test('the check of the jobs finds a kind, a profile or a prompt that does not line up; each stops its job', () => {
  const { review } = mergeCrew(parseCrewFile(SHIPPED, '/crew.json'), null, '/w').jobs
  const facts = { kinds: ['oneshot'], profiles: ['read-only'], missingPrompts: new Set<string>() }
  expect(checkJobs({ review: review! }, facts)).toEqual([])
  expect(checkJobs({ review: { ...review!, kind: 'nosuch', profile: 'root' } }, { ...facts, missingPrompts: new Set([review!.prompt]) })).toEqual([
    { job: 'review', text: 'it runs as kind nosuch, and cc-agents has oneshot', isBlocking: true },
    { job: 'review', text: 'it runs as profile root, and cc-agents has read-only', isBlocking: true },
    { job: 'review', text: `its prompt ${review!.prompt} does not exist`, isBlocking: true },
  ])
})

test('a job must say how it prefers its models', () => {
  const job = JSON.stringify({ jobs: { review: { prefer: [] } } })
  expect(() => parseCrewFile(job, '/crew.json')).toThrow('crew: /crew.json: job review: prefer must be a list of tiers, in the order to try them')
})

test('crew words how cc-agents says an agent stands', () => {
  expect(readingOf(null)).toEqual({ text: 'ending', isStalled: false, mark: '' })
  expect(readingOf({ state: 'ending' })).toEqual({ text: 'ending', isStalled: false, mark: '' })
  expect(readingOf({ state: 'working', steps: 2 })).toEqual({ text: 'working, 2 steps done', isStalled: false, mark: '' })
  expect(readingOf({ state: 'working', steps: 1 }).text).toBe('working, 1 step done')
  expect(readingOf({ state: 'working', steps: 0, tool: 'WebFetch' })).toEqual({ text: 'working: WebFetch', isStalled: false, mark: '' })
  expect(readingOf({ state: 'stalled', on: { tool: 'WebFetch', target: 'https://a' }, forMs: 720_000, mark: 'm1' })).toEqual({ text: 'waiting on WebFetch https://a for 12m', isStalled: true, mark: 'm1' })
  expect(readingOf({ state: 'stalled', on: { tool: 'list_dir', target: '' }, forMs: 720_000, mark: 'm2' }).text).toBe('waiting on list_dir for 12m')
  expect(readingOf({ state: 'stalled', forMs: 660_000, mark: 'm3' })).toEqual({ text: 'no output for 11m', isStalled: true, mark: 'm3' })
})

test("config merging: a machine's job joins the shipped ones, its prompt found from its own file, and a model both name is the machine's whole", () => {
  const own = parseCrewFile(
    JSON.stringify({
      jobs: {
        audit: { description: 'Audit.', prompt: 'mine/audit.md', kind: 'oneshot', profile: 'read-only', prefer: ['quota'], web: false, helpers: false, paths: 'required', diff: false, timeoutMin: 5, pokeMin: 5, stallMin: 5, models: { 'v/fast': {} }, default: ['v/fast'] },
        review: { models: { 'v/deep': { effort: 'low' } }, bySessionModel: { 'claude/haiku': ['v/fast'] } },
      },
    }),
    '/own/crew.json',
  )
  const crew = mergeCrew(parseCrewFile(SHIPPED, '/ship/crew.json'), own, '/w')
  expect(Object.keys(crew.jobs)).toEqual(['review', 'audit'])
  expect(crew.jobs['audit']!.prompt).toBe('/own/mine/audit.md')
  expect(crew.jobs['review']!.prompt).toBe('/ship/prompts/review.md')
  expect(crew.jobs['review']!.models['v/deep']).toEqual({ effort: 'low' })
  expect(crew.jobs['review']!.models['v/fast']).toEqual({})
  expect(modelsFor(crew.jobs['review']!, 'claude/haiku', undefined)).toEqual(['v/fast'])
  // a job's fields are replaced whole, so the machine's list stands in for the shipped one
  expect(modelsFor(crew.jobs['review']!, 'claude/opus', undefined)).toEqual(['v/fast'])
})

test('an answer whose findings are not findings is no answer, so it is shown as it came rather than half counted', () => {
  const scope = (findings: unknown) => JSON.stringify({ scopes: [{ scope: 'x', report: 'r', findings, references: [] }], not_read: [] })
  expect(parseAnswer(scope('none'))).toBeUndefined()
  expect(parseAnswer(scope([{ title: 1 }]))).toBeUndefined()
  expect(parseAnswer(scope([{ title: 't' }]))).toBeUndefined()
})
