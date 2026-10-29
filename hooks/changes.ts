import type { Io } from './io.ts'

import { join } from './paths.ts'

export type ChangeSpec = 'uncommitted' | { base: string } | { commit: string }

export type Change = { label: string; diff: string; untracked: string[] }

/** Which of the absolute paths name secret files. */
export type SecretsOf = (paths: string[]) => Promise<string[]>

const MAX_DIFF = 400 * 1024

async function git(io: Io, repo: string, args: string[]): Promise<string> {
  const r = await io.run(['git', '-C', repo, ...args], { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`crew: git ${args.join(' ')} failed in ${repo}: ${r.stderr.trim().slice(-500)}`)
  if (r.isStdoutTruncated) throw new Error(`crew: git ${args.join(' ')} wrote more than 4 MiB; narrow the change`)
  return r.stdout
}

const names = (out: string) => out.split('\n').filter(l => l !== '')

/** The paths as git names them, relative to `repo` with `/`, less those that name secrets. */
async function withoutSecrets(repo: string, paths: string[], secretsOf: SecretsOf): Promise<string[]> {
  const secret = new Set(await secretsOf(paths.map(p => join(repo, p))))
  return paths.filter(p => !secret.has(join(repo, p)))
}

/** The change as a diff, secret files left out by name. */
export async function changeOf(io: Io, repo: string, spec: ChangeSpec, secretsOf: SecretsOf): Promise<Change> {
  let label: string
  let range: string[]
  let changed: string[]
  let untracked: string[] = []
  if (spec === 'uncommitted') {
    label = `The uncommitted changes (staged and unstaged) in \`${repo}\``
    range = ['diff', 'HEAD']
    changed = names(await git(io, repo, ['diff', 'HEAD', '--name-only']))
    untracked = await withoutSecrets(repo, names(await git(io, repo, ['ls-files', '--others', '--exclude-standard'])), secretsOf)
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
  const kept = await withoutSecrets(repo, changed, secretsOf)
  const left = changed.length - kept.length
  const diff = kept.length === 0 ? '' : await git(io, repo, [...range, '--', ...kept])
  if (diff.length > MAX_DIFF) {
    throw new Error(`crew: the diff is ${Math.round(diff.length / 1024)} KiB, over ${MAX_DIFF / 1024} KiB; review a narrower change`)
  }
  if (left > 0) label += ` (${left} secret file${left === 1 ? '' : 's'} left out of the diff)`
  return { label, diff, untracked }
}
