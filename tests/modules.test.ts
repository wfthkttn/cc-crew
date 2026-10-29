import { expect, test } from 'claude-code/testing'

import { effective, mergeCrew, modelsFor, parseCrewFile, settingsFrom } from '../hooks/config.ts'
import { readingOf } from '../hooks/liveness.ts'
import { systemPrompt, taskText } from '../hooks/prompt.ts'
import { fullReport, merge, parseAnswer, scopeList, scopeReport } from '../hooks/report.ts'
import { ANSWER } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'

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
  expect(() => mergeCrew({ jobs: { x: { kind: 'oneshot' } } }, null, '/w')).toThrow('crew: /w: job x needs description, prompt, web, helpers, paths, diff, timeoutMin, pokeMin, stallMin, models, default')
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
})

const MIN = 60_000

test('an agent reads as working until one call or its silence passes the stall limit, the oldest call told first; a run gone reads as ending', () => {
  const at = 1000 * MIN
  const open = (minutesAgo: number, target = '') => ({ tool: 'WebFetch', target, since: at - minutesAgo * MIN })
  expect(readingOf({ lastAt: at, steps: 2, open: [] }, 10 * MIN, at)).toEqual({ text: 'working, 2 steps done', isStalled: false, mark: '' })
  expect(readingOf({ lastAt: at, steps: 0, open: [open(3)] }, 10 * MIN, at)).toEqual({ text: 'working: WebFetch', isStalled: false, mark: '' })
  expect(readingOf({ lastAt: at, steps: 0, open: [open(1), open(12, 'https://a')] }, 10 * MIN, at)).toEqual({ text: 'waiting on WebFetch https://a for 12m', isStalled: true, mark: `open:WebFetch:${at - 12 * MIN}` })
  expect(readingOf({ lastAt: at - 11 * MIN, steps: 4, open: [] }, 10 * MIN, at)).toEqual({ text: 'no output for 11m', isStalled: true, mark: `silent:${at - 11 * MIN}` })
  expect(readingOf(null, 10 * MIN, at)).toEqual({ text: 'ending', isStalled: false, mark: '' })
})
