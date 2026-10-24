import type { Io } from './io.ts'

import { isSecretPath, join } from './scope.ts'

export type ChangeSpec = 'uncommitted' | { base: string } | { commit: string }

export type Change = { label: string; diff: string; untracked: string[] }

const MAX_DIFF = 400 * 1024

async function git(io: Io, repo: string, args: string[]): Promise<string> {
  const r = await io.run(['git', '-C', repo, ...args], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`crew: git ${args.join(' ')} failed in ${repo}: ${r.stderr.trim().slice(-500)}`)
  if (r.isStdoutTruncated) throw new Error(`crew: git ${args.join(' ')} wrote more than 4 MiB; narrow the change`)
  return r.stdout
}

/** `path` as git names it, relative to `repo` with `/`. */
const isSecret = (repo: string, path: string) => isSecretPath(join(repo, path))

const names = (out: string) => out.split('\n').filter(l => l !== '')

/** The change as a diff, secret files left out by name. */
export async function changeOf(io: Io, repo: string, spec: ChangeSpec): Promise<Change> {
  let label: string
  let range: string[]
  let changed: string[]
  let untracked: string[] = []
  if (spec === 'uncommitted') {
    label = `The uncommitted changes (staged and unstaged) in \`${repo}\``
    range = ['diff', 'HEAD']
    changed = names(await git(io, repo, ['diff', 'HEAD', '--name-only']))
    untracked = names(await git(io, repo, ['ls-files', '--others', '--exclude-standard'])).filter(p => !isSecret(repo, p))
  } else if ('base' in spec) {
    const mergeBase = (await git(io, repo, ['merge-base', 'HEAD', spec.base])).trim()
    label = `The changes on this branch of \`${repo}\` since it left \`${spec.base}\` (merge base ${mergeBase.slice(0, 12)})`
    range = ['diff', mergeBase]
    changed = names(await git(io, repo, ['diff', mergeBase, '--name-only']))
  } else {
    const title = (await git(io, repo, ['show', '-s', '--format=%h %s', spec.commit])).trim()
    label = `Commit ${title} in \`${repo}\``
    range = ['show', '--format=%H %s%n%n%b', spec.commit]
    changed = names(await git(io, repo, ['show', '--name-only', '--format=', spec.commit]))
  }
  const kept = changed.filter(p => !isSecret(repo, p))
  const left = changed.length - kept.length
  const diff = kept.length === 0 ? '' : await git(io, repo, [...range, '--', ...kept])
  if (diff.length > MAX_DIFF) {
    throw new Error(`crew: the diff is ${Math.round(diff.length / 1024)} KiB, over ${MAX_DIFF / 1024} KiB; review a narrower change`)
  }
  if (left > 0) label += ` (${left} secret file${left === 1 ? '' : 's'} left out of the diff)`
  return { label, diff, untracked }
}
