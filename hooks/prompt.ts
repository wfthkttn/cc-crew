export const REVIEWER_PROMPT = `You are a reviewer working for another agent. You read; you never change anything: no file writes, no commands that change state. Stay inside the paths your brief says you may read: everything else is closed, and reaching for it can end your run. The brief is self-contained: whoever wrote it is not in this conversation and cannot answer questions.

Answer with one JSON object, as the output schema describes:
- summary: your overall judgement in a few sentences.
- findings: one entry per issue.
  - title: one line.
  - priority: 0 (breaks something that matters) to 3 (minor).
  - confidence: 0 to 1.
  - file, line_start, line_end: where it lives; "" and 0 when it has no single place.
  - scenario: the concrete inputs or steps that lead to the wrong result.
  - body: one paragraph on what is wrong and what it affects.
  - pre_existing: true when the brief asks about a change and the issue was there before it.
- checked: what you examined and found sound.
- not_read: what you did not read or could not reach.

A finding names what it provably breaks: point at the code that is affected instead of speculating. Prefer no finding to a weak one.`

export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'checked', 'not_read'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'priority', 'confidence', 'file', 'line_start', 'line_end', 'scenario', 'body', 'pre_existing'],
        properties: {
          title: { type: 'string' },
          priority: { type: 'integer' },
          confidence: { type: 'number' },
          file: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
          scenario: { type: 'string' },
          body: { type: 'string' },
          pre_existing: { type: 'boolean' },
        },
      },
    },
    checked: { type: 'array', items: { type: 'string' } },
    not_read: { type: 'array', items: { type: 'string' } },
  },
} as const

export type Finding = {
  title: string
  priority: number
  confidence: number
  file: string
  line_start: number
  line_end: number
  scenario: string
  body: string
  pre_existing: boolean
}

export type Findings = {
  summary: string
  findings: Finding[]
  checked: string[]
  not_read: string[]
}

export type Rule = { path: string; text: string }

export function systemPrompt(rules: readonly Rule[]): string {
  if (rules.length === 0) return REVIEWER_PROMPT
  const parts = rules.map(r => `### ${r.path}\n\n${r.text.trim()}`)
  return `${REVIEWER_PROMPT}\n\n## Rules from the person you work for\n\n${parts.join('\n\n')}`
}

export type TaskInput = {
  brief: string
  roots: readonly string[]
  web: boolean
  changes?: { label: string; diff: string; untracked: readonly string[] }
}

export function taskText(t: TaskInput): string {
  const access = t.roots.length === 0 ? 'nothing on disk' : t.roots.map(r => `\`${r}\``).join(', ')
  const parts: string[] = []
  if (t.changes !== undefined) {
    parts.push(
      `## The change under review\n\n${t.changes.label}. Review this change: issues it introduces are findings; issues that were there before it are findings with pre_existing true. Read surrounding code as needed to judge it.`,
    )
    if (t.changes.untracked.length > 0) {
      parts.push(`New files not yet tracked by git (read them):\n${t.changes.untracked.map(f => `- ${f}`).join('\n')}`)
    }
    parts.push('```diff\n' + t.changes.diff + '\n```')
  }
  parts.push(`## Brief\n\n${t.brief}`)
  parts.push(`## Your access\n\nYou may read: ${access}. Web: ${t.web ? 'allowed' : 'not available'}.`)
  return parts.join('\n\n')
}

function isFinding(v: unknown): v is Finding {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return typeof f.title === 'string' && typeof f.priority === 'number' && typeof f.body === 'string'
}

/** The reviewer's JSON answer, or undefined when the text holds none of that shape. */
export function parseFindings(text: string): Findings | undefined {
  const candidates = [text]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const c of candidates) {
    let v: unknown
    try {
      v = JSON.parse(c)
    } catch {
      continue
    }
    if (typeof v !== 'object' || v === null) continue
    const o = v as Record<string, unknown>
    if (typeof o.summary !== 'string' || !Array.isArray(o.findings) || !o.findings.every(isFinding)) continue
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
    return { summary: o.summary, findings: o.findings, checked: strings(o.checked), not_read: strings(o.not_read) }
  }
  return undefined
}

function place(f: Finding): string {
  if (f.file === '') return ''
  if (f.line_start <= 0) return ` — \`${f.file}\``
  const lines = f.line_end > f.line_start ? `${f.line_start}-${f.line_end}` : `${f.line_start}`
  return ` — \`${f.file}:${lines}\``
}

export function renderFindings(f: Findings): string {
  const out: string[] = [`## Summary\n\n${f.summary}`]
  if (f.findings.length === 0) {
    out.push('## Findings\n\nNone.')
  } else {
    const sorted = [...f.findings].sort((a, b) => a.priority - b.priority)
    out.push(
      '## Findings\n\n' +
        sorted
          .map(
            x =>
              `### [P${x.priority}] ${x.title}${place(x)}\n\n` +
              `Confidence ${x.confidence}${x.pre_existing ? ', pre-existing' : ''}.\n\n` +
              `Scenario: ${x.scenario}\n\n${x.body}`,
          )
          .join('\n\n'),
    )
  }
  if (f.checked.length > 0) out.push('## Checked and sound\n\n' + f.checked.map(c => `- ${c}`).join('\n'))
  if (f.not_read.length > 0) out.push('## Not read\n\n' + f.not_read.map(c => `- ${c}`).join('\n'))
  return out.join('\n\n')
}
