/** How every agent of every job answers; the job's own prompt says what to look for. */
export const OUTPUT_PROMPT = `Answer with one JSON object, as the output schema describes:
- scopes: one entry per system or area you covered.
  - scope: a short name of that system, so a reader can tell at a glance whether it concerns them.
  - report: what you examined there and what you concluded, including what you found sound.
  - findings: one entry per thing worth acting on.
    - title: one line.
    - priority: 0 (matters most) to 3 (minor).
    - confidence: 0 to 1.
    - body: one paragraph on what you found and what it affects.
    - evidence: what shows it holds: the concrete scenario, or what you checked at the source.
    - references: where it can be checked: file:line, or a URL.
  - references: what else you relied on for this scope.
- not_read: what you did not read or could not reach.`

const STRINGS = { type: 'array', items: { type: 'string' } }

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scopes', 'not_read'],
  properties: {
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'report', 'findings', 'references'],
        properties: {
          scope: { type: 'string' },
          report: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'priority', 'confidence', 'body', 'evidence', 'references'],
              properties: {
                title: { type: 'string' },
                priority: { type: 'integer' },
                confidence: { type: 'number' },
                body: { type: 'string' },
                evidence: { type: 'string' },
                references: STRINGS,
              },
            },
          },
          references: STRINGS,
        },
      },
    },
    not_read: STRINGS,
  },
} as const

export type Finding = { title: string; priority: number; confidence: number; body: string; evidence: string; references: string[] }

export type Scope = { scope: string; report: string; findings: Finding[]; references: string[] }

export type Answer = { scopes: Scope[]; not_read: string[] }

const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])

function findingOf(v: unknown): Finding | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const f = v as Record<string, unknown>
  if (typeof f.title !== 'string' || typeof f.priority !== 'number' || typeof f.body !== 'string') return undefined
  return { title: f.title, priority: f.priority, confidence: typeof f.confidence === 'number' ? f.confidence : 0, body: f.body, evidence: typeof f.evidence === 'string' ? f.evidence : '', references: strings(f.references) }
}

function scopeOf(v: unknown): Scope | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const s = v as Record<string, unknown>
  if (typeof s.scope !== 'string' || typeof s.report !== 'string' || !Array.isArray(s.findings)) return undefined
  const findings = s.findings.map(findingOf)
  if (findings.some(f => f === undefined)) return undefined
  return { scope: s.scope, report: s.report, findings: findings as Finding[], references: strings(s.references) }
}

/** The agent's JSON answer, or undefined when the text holds none of that shape. */
export function parseAnswer(text: string): Answer | undefined {
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
    if (!Array.isArray(o.scopes)) continue
    const scopes = o.scopes.map(scopeOf)
    if (scopes.some(s => s === undefined)) continue
    return { scopes: scopes as Scope[], not_read: strings(o.not_read) }
  }
  return undefined
}

/** What one agent left: its answer, or its text where it gave none in the format. */
export type Left = { agent: string; answer?: Answer; text?: string }

/** One scope as the job read it: each agent's take on it under one name, agents named by their label alone. */
export type MergedScope = { scope: string; takes: (Scope & { agent: string })[] }

export type Merged = { scopes: MergedScope[]; notRead: string[]; unformatted: { agent: string; text: string }[] }

const scopeKey = (name: string) => name.trim().toLowerCase()

/** Every agent's scopes under their names, kept as each agent gave them: scopes of one name join, findings never do. */
export function merge(left: readonly Left[]): Merged {
  const scopes = new Map<string, MergedScope>()
  for (const { agent, answer } of left) {
    for (const s of answer?.scopes ?? []) {
      const key = scopeKey(s.scope)
      const merged = scopes.get(key) ?? { scope: s.scope.trim(), takes: [] }
      merged.takes.push({ ...s, agent })
      scopes.set(key, merged)
    }
  }
  return {
    scopes: [...scopes.values()],
    notRead: [...new Set(left.flatMap(l => l.answer?.not_read ?? []))],
    unformatted: left.flatMap(l => (l.text === undefined || l.text.trim() === '' ? [] : [{ agent: l.agent, text: l.text }])),
  }
}

export const findingCount = (m: Merged) => m.scopes.reduce((n, s) => n + s.takes.reduce((k, t) => k + t.findings.length, 0), 0)

/** `auth (2), limits (0)`: what a list or a summary says of a report. */
export function scopeList(m: Merged): string {
  return m.scopes.map(s => `${s.scope} (${s.takes.reduce((n, t) => n + t.findings.length, 0)})`).join(', ')
}

function findingLines(f: Finding): string[] {
  return [
    `- [P${f.priority}] ${f.title} (confidence ${f.confidence})`,
    `  ${f.body}`,
    ...(f.evidence === '' ? [] : [`  Evidence: ${f.evidence}`]),
    ...(f.references.length === 0 ? [] : [`  References: ${f.references.join(', ')}`]),
  ]
}

const byPriority = (a: Finding, b: Finding) => a.priority - b.priority

/** Each scope with its findings and their references, nothing else. */
export function findingsText(m: Merged): string {
  const parts = m.scopes.flatMap(s => {
    const findings = s.takes.flatMap(t => t.findings).sort(byPriority)
    return findings.length === 0 ? [] : [`## ${s.scope}\n\n${findings.flatMap(findingLines).join('\n')}`]
  })
  return parts.length === 0 ? 'No findings.' : parts.join('\n\n')
}

function scopeText(s: MergedScope): string {
  const takes = s.takes.map(t => {
    const lines = [t.report.trim()]
    if (t.findings.length > 0) lines.push('', 'Findings:', ...[...t.findings].sort(byPriority).flatMap(findingLines))
    if (t.references.length > 0) lines.push('', `References: ${t.references.join(', ')}`)
    return lines.join('\n')
  })
  return `## ${s.scope}\n\n${takes.join('\n\n---\n\n')}`
}

/** One scope whole, or undefined when the report has none of that name. */
export function scopeReport(m: Merged, name: string): string | undefined {
  const s = m.scopes.find(x => scopeKey(x.scope) === scopeKey(name))
  return s === undefined ? undefined : scopeText(s)
}

export function fullReport(m: Merged): string {
  const parts = m.scopes.map(scopeText)
  if (m.notRead.length > 0) parts.push(`## Not read\n\n${m.notRead.map(n => `- ${n}`).join('\n')}`)
  for (const u of m.unformatted) parts.push(`## Answer not in the report format (agent ${u.agent})\n\n${u.text}`)
  return parts.length === 0 ? 'The report is empty: no agent left an answer.' : parts.join('\n\n')
}
