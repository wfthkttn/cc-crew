import { OUTPUT_PROMPT } from './report.ts'

export type Rule = { path: string; text: string }

/** The job's own instructions, the report format every job shares, then the person's rules. */
export function systemPrompt(jobPrompt: string, rules: readonly Rule[]): string {
  const base = `${jobPrompt.trim()}\n\n${OUTPUT_PROMPT}`
  if (rules.length === 0) return base
  const parts = rules.map(r => `### ${r.path}\n\n${r.text.trim()}`)
  return `${base}\n\n## Rules from the person you work for\n\n${parts.join('\n\n')}`
}

/** A job's tool description; `write` is its profile's, undefined when cc-agents has no such profile. */
export function toolDescription(description: string, write: boolean | undefined): string {
  const access = write === undefined ? 'cc-agents has no such profile, so a call is refused' : write ? 'they may change those paths' : 'they change nothing'
  return `${description}

It runs in the background: you get its id at once, and a message when it finishes or an agent behind it stalls. That message wakes you, so go on with other work. Its agents know nothing of this conversation, so the brief carries what they need. They reach only the paths you name, secret files stay closed to them, and ${access}. Use \`report\` instead of opening its files: it reads by scope and marks the job read.`
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
    parts.push(`## The change under review\n\n${t.changes.label}. Issues it introduces are findings; say in a finding's body when an issue was there before it. Read surrounding code as needed to judge it.`)
    if (t.changes.untracked.length > 0) {
      parts.push(`New files not yet tracked by git (read them):\n${t.changes.untracked.map(f => `- ${f}`).join('\n')}`)
    }
    parts.push('```diff\n' + t.changes.diff + '\n```')
  }
  parts.push(`## Brief\n\n${t.brief}`)
  parts.push(`## Your access\n\nYou may read: ${access}. Web: ${t.web ? 'allowed' : 'not available'}.`)
  return parts.join('\n\n')
}
