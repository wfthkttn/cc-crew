import { isBuiltIn } from './config.ts'
import type { Io } from './io.ts'

/**
 * A reviewer the person adds in `~/.config/crew/reviewers.json`, called by `name` like a built-in: a `claude -p` child
 * started with `command` (the program and its first arguments), at `model` and `effort` when the call names none. Its
 * models count in a group of models.json whose provider is `name`.
 */
export type CustomReviewer = { name: string; kind: 'claude-p'; command: string[]; model?: string; effort?: string }

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** Why an entry can't be used, or undefined. */
function problemOf(name: string, entry: unknown): string | undefined {
  if (isBuiltIn(name)) return `${name} is a built-in reviewer`
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'a reviewer name takes lowercase letters, digits and -'
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'must be an object'
  const e = entry as Record<string, unknown>
  if (e.kind !== 'claude-p') return 'kind must be "claude-p"'
  if (!isStrings(e.command) || e.command.length === 0 || e.command[0] === '') return 'command must be a non-empty list of strings, the program first'
  if (e.model !== undefined && typeof e.model !== 'string') return 'model must be a string'
  if (e.effort !== undefined && typeof e.effort !== 'string') return 'effort must be a string'
  return undefined
}

/** The file's reviewers by name, `{ "<name>": { "kind": "claude-p", "command": [...] } }`. */
export function parseReviewers(text: string, path: string): CustomReviewer[] {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch (err) {
    throw new Error(`crew: ${path} is not JSON: ${String(err)}`)
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Error(`crew: ${path} must hold an object of reviewers by name`)
  return Object.entries(file).map(([name, entry]) => {
    const problem = problemOf(name, entry)
    if (problem !== undefined) throw new Error(`crew: ${path}: reviewer ${name}: ${problem}`)
    const e = entry as Omit<CustomReviewer, 'name'>
    return {
      name,
      kind: e.kind,
      command: [...e.command],
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
    }
  })
}

export const reviewersPath = (home: string) => `${home}/.config/crew/reviewers.json`

/** The person's reviewers; none when they keep no file. */
export async function loadReviewers(io: Io, home: string): Promise<CustomReviewer[]> {
  const path = reviewersPath(home)
  return (await io.exists(path)) ? parseReviewers(await io.read(path), path) : []
}
