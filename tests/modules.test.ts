import { expect, test } from 'claude-code/testing'

import { settingsFrom, withDefaults } from '../hooks/config.ts'
import { parseFindings, renderFindings, systemPrompt, taskText } from '../hooks/prompt.ts'
import { keysFor, slugOf } from '../hooks/reviews.ts'
import { FINDINGS } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'

test('findings are read from bare JSON or JSON inside prose, and rendered by priority', () => {
  expect(parseFindings(JSON.stringify(FINDINGS))?.summary).toBe('One bug.')
  expect(parseFindings('Here:\n```json\n' + JSON.stringify(FINDINGS) + '\n```')?.findings).toHaveLength(1)
  expect(parseFindings('no json here')).toBeUndefined()
  expect(renderFindings(FINDINGS)).toContain('### [P1] Off by one — `main.ts:3-4`')
})

test('the rule files follow the shared prompt; the task states the access', () => {
  expect(systemPrompt([{ path: '/r.md', text: 'Cite file:line.' }])).toContain('### /r.md\n\nCite file:line.')
  const t = taskText({ brief: 'Look at X', roots: [PROJECT], web: false })
  expect(t).toContain(`You may read: \`${PROJECT}\`. Web: not available.`)
})

test('reviewer keys are the provider and model, numbered on a repeat; a description becomes a short slug', () => {
  expect(keysFor([{ provider: 'codex' }, { provider: 'zai' }, { provider: 'codex' }, { provider: 'claude', model: 'opus' }])).toEqual(['codex-default', 'zai-default', 'codex-default-2', 'claude-opus'])
  expect(slugOf('Review cc-providers & cc-agents!')).toBe('review-cc-providers-cc-agents')
  expect(slugOf('!!!')).toBe('review')
})

test("a reviewer runs its provider's configured model and effort unless the call names its own; empty settings leave the tool's default", () => {
  const s = settingsFrom({ reviewers: ['codex'], codex_model: '', codex_effort: 'medium', agy_model: 'gemini-4-argon-high', agy_effort: '', claude_model: 'opus', claude_effort: '', reviewer_rules: [], timeout_s: 900 })
  expect(s.timeoutMs).toBe(900_000)
  expect(withDefaults({ provider: 'codex' }, s.defaults)).toEqual({ provider: 'codex', effort: 'medium' })
  expect(withDefaults({ provider: 'codex', effort: 'xhigh' }, s.defaults)).toEqual({ provider: 'codex', effort: 'xhigh' })
  expect(withDefaults({ provider: 'antigravity' }, s.defaults)).toEqual({ provider: 'antigravity', model: 'gemini-4-argon-high' })
  expect(withDefaults({ provider: 'claude', model: 'haiku' }, s.defaults)).toEqual({ provider: 'claude', model: 'haiku' })
  expect(withDefaults({ provider: 'claude' }, s.defaults)).toEqual({ provider: 'claude', model: 'opus' })
  expect(withDefaults({ provider: 'zai' }, s.defaults)).toEqual({ provider: 'zai' })
})
