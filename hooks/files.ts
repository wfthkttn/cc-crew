import type { Io } from './io.ts'

import type { Fence } from './claude.ts'
import { isInside, isSecretPath, isWindowsPath, join, nameOf, pathKey } from './scope.ts'

/**
 * The Claude reviewer's tools where it has no shell (Windows, whose Codex sandbox runs no shell under a read-only
 * profile): a folder's listing and a search of file contents, both held to the review's read paths by crew itself.
 */
export const LIST_TOOL = 'reviewer_list'
export const SEARCH_TOOL = 'reviewer_search'

const MAX_ENTRIES = 2000
const MAX_DEPTH = 6
const MAX_MATCHES = 300
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_LINE = 300
/** How much of a line the pattern is matched against. */
const MAX_MATCHED = 4000

export const LIST_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'An absolute folder inside the paths this review may read' },
    depth: { type: 'number', description: `How many levels down to list, 1 to ${MAX_DEPTH} (default 1)` },
  },
  required: ['path'],
  additionalProperties: false,
}

export const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'A JavaScript regular expression matched against each line' },
    path: { type: 'string', description: 'An absolute file or folder inside the paths this review may read' },
    ignore_case: { type: 'boolean', description: 'Match without case (default false)' },
  },
  required: ['pattern', 'path'],
  additionalProperties: false,
}

export const LIST_DESCRIPTION = `For crew's Claude reviewers only. Lists a folder inside the paths the review may read: one line per entry, folders ending in a separator, files with their size; links are shown and not followed, and .git is not entered. At most ${MAX_ENTRIES} entries.`

export const SEARCH_DESCRIPTION = `For crew's Claude reviewers only. Searches the files under a path inside the paths the review may read for lines matching a regular expression (no group that repeats a repeat, such as (a+)+; the first ${MAX_MATCHED} characters of a line): \`path:line: text\` per match, at most ${MAX_MATCHES}. Secret files, links, .git, binary files and files over ${MAX_FILE_BYTES / 1024 / 1024} MiB are skipped.`

class Refused extends Error {}

/** The path's real place, which must lie inside a read path. */
async function placed(io: Io, fence: Fence, path: string): Promise<{ real: string; kind: string }> {
  const stat = await io.stat(path, { resolve: true }).catch(() => undefined)
  if (stat?.realPath === undefined) throw new Refused(`${path} does not resolve`)
  if (!fence.roots.some(r => isInside(stat.realPath!, r))) throw new Refused(`${path} is outside the paths this review may read`)
  return { real: stat.realPath, kind: stat.kind }
}

const isSecret = (fence: Fence, path: string) => isSecretPath(path) || fence.secrets.some(s => pathKey(s) === pathKey(path))

/** Git's own folder, by any spelling of its name on Windows. */
const isGitDir = (path: string) => (isWindowsPath(path) ? nameOf(path).toLowerCase() === '.git' : nameOf(path) === '.git')

/** A pattern whose group repeats something that itself repeats, the shape that backtracks without end. */
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/

/** The answer to a list call, or why it is refused. */
export async function listing(io: Io, fence: Fence, path: string, depth: number | undefined): Promise<{ text: string } | { refusal: string }> {
  try {
    const levels = Math.min(MAX_DEPTH, Math.max(1, Math.floor(depth ?? 1)))
    const { real, kind } = await placed(io, fence, path)
    if (kind !== 'dir') throw new Refused(`${path} is not a folder`)
    const lines: string[] = []
    let isCut = false
    const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
      let listed
      try {
        listed = await io.list(dir)
      } catch (err) {
        if (level === 1) throw err
        lines.push(`${prefix} (could not be listed: ${String(err)})`)
        return
      }
      const entries = [...listed].sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries) {
        if (lines.length >= MAX_ENTRIES) {
          isCut = true
          return
        }
        const shown = prefix + e.name
        if (e.isLink) lines.push(`${shown} (link, not followed)`)
        else if (e.kind === 'dir') {
          lines.push(`${shown}/`)
          if (level < levels && !isGitDir(join(dir, e.name))) await walk(join(dir, e.name), `${shown}/`, level + 1)
        } else lines.push(`${shown} (${e.size} bytes)`)
      }
    }
    await walk(real, '', 1)
    if (lines.length === 0) lines.push('(empty)')
    if (isCut) lines.push(`(cut at ${MAX_ENTRIES} entries: list a deeper folder)`)
    return { text: `${real}\n${lines.join('\n')}` }
  } catch (err) {
    if (err instanceof Refused) return { refusal: err.message }
    throw err
  }
}

/** The answer to a search call, or why it is refused. */
export async function search(
  io: Io,
  fence: Fence,
  args: { pattern: string; path: string; ignoreCase: boolean },
): Promise<{ text: string } | { refusal: string }> {
  try {
    // it runs in the session's own process, where nothing can cut a runaway match short
    if (NESTED_REPEAT.test(args.pattern)) throw new Refused('the pattern repeats a group that itself repeats; write it without the nesting')
    let re: RegExp
    try {
      re = new RegExp(args.pattern, args.ignoreCase ? 'i' : '')
    } catch (err) {
      throw new Refused(`the pattern is not a regular expression: ${String(err)}`)
    }
    const { real, kind } = await placed(io, fence, args.path)
    const files: string[] = []
    let unlisted = 0
    if (kind === 'file') {
      if (isSecret(fence, real)) throw new Refused(`${args.path} is a secret file`)
      files.push(real)
    } else {
      const queue = [real]
      while (queue.length > 0 && files.length < MAX_FILES) {
        const dir = queue.shift()!
        let listed
        try {
          listed = await io.list(dir)
        } catch (err) {
          if (dir === real) throw err
          unlisted++
          continue
        }
        for (const e of listed) {
          const p = join(dir, e.name)
          if (e.isLink) continue
          if (e.kind === 'dir') {
            if (!isGitDir(p)) queue.push(p)
          } else if (e.kind === 'file' && e.size <= MAX_FILE_BYTES && !isSecret(fence, p)) files.push(p)
        }
      }
    }
    const matches: string[] = []
    let unread = 0
    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break
      let text: string
      try {
        text = await io.read(file)
      } catch {
        unread++
        continue
      }
      if (text.includes('\u0000')) continue
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (re.test(lines[i]!.slice(0, MAX_MATCHED))) matches.push(`${file}:${i + 1}: ${lines[i]!.slice(0, MAX_LINE)}`)
      }
    }
    const notes: string[] = []
    if (matches.length >= MAX_MATCHES) notes.push(`(cut at ${MAX_MATCHES} matches: narrow the path or the pattern)`)
    if (files.length >= MAX_FILES) notes.push(`(only the first ${MAX_FILES} files were searched)`)
    if (unread > 0) notes.push(`(${unread} files could not be read)`)
    if (unlisted > 0) notes.push(`(${unlisted} folders could not be listed)`)
    return { text: [...(matches.length === 0 ? ['(no matches)'] : matches), ...notes].join('\n') }
  } catch (err) {
    if (err instanceof Refused) return { refusal: err.message }
    throw err
  }
}
