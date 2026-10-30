import type { Io } from './io.ts'

import { isInside, join } from './paths.ts'

export type ChangeSpec = 'uncommitted' | { base: string } | { commit: string }

export type Change = { label: string; diff: string; untracked: string[] }

/** Which of the absolute paths name secret files. */
export type SecretsOf = (paths: string[]) => Promise<string[]>

const MAX_DIFF = 400 * 1024

/** With paths as they are: by default git escapes a name that isn't plain ASCII, in a diff's headers too. */
const gitArgv = (repo: string, args: readonly string[]) => ['git', '-C', repo, '-c', 'core.quotePath=false', ...args]

async function git(io: Io, repo: string, args: string[]): Promise<string> {
  const r = await io.run(gitArgv(repo, args), { timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`crew: git ${args.join(' ')} failed in ${repo}: ${r.stderr.trim().slice(-500)}`)
  if (r.isStdoutTruncated) throw new Error(`crew: git ${args.join(' ')} wrote more than 4 MiB; narrow the change`)
  return r.stdout
}

/** A `-z` listing: a name can hold a newline or a quote, which git would escape into a name that matches no file. */
const names = (out: string) => out.split('\0').filter(l => l !== '')

/** What `git diff` compares the working tree with: HEAD, or nothing yet in a repository with no commits. */
async function baseOfWork(io: Io, repo: string): Promise<string> {
  const head = await io.run(gitArgv(repo, ['rev-parse', '--verify', '-q', 'HEAD']), { timeoutMs: 60_000 })
  return head.exitCode === 0 ? 'HEAD' : (await git(io, repo, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
}

/** The paths as git names them, relative to `repo` with `/`, less those that name secrets. */
async function withoutSecrets(repo: string, paths: string[], secretsOf: SecretsOf): Promise<string[]> {
  const secret = new Set(await secretsOf(paths.map(p => join(repo, p))))
  return paths.filter(p => !secret.has(join(repo, p)))
}

/**
 * The change in the repository that holds `folder`, kept to the `scope` paths inside it, so a reviewer is shown no
 * change outside what it may read; secret files left out by name.
 */
export async function changeOf(io: Io, folder: string, scope: readonly string[], spec: ChangeSpec, secretsOf: SecretsOf): Promise<Change> {
  // from its top: from a subfolder git names changed files from the top but untracked ones from the subfolder
  const repo = (await git(io, folder, ['rev-parse', '--show-toplevel'])).trim()
  const within = ['--', ...scope.filter(p => isInside(p, repo))]
  let label: string
  let range: string[]
  let changed: string[]
  let untracked: string[] = []
  if (spec === 'uncommitted') {
    const base = await baseOfWork(io, repo)
    label = `The uncommitted changes (staged and unstaged) in \`${repo}\``
    range = ['diff', base]
    changed = names(await git(io, repo, ['diff', base, '--no-renames', '--name-only', '-z', ...within]))
    untracked = await withoutSecrets(repo, names(await git(io, repo, ['ls-files', '-z', '--others', '--exclude-standard', ...within])), secretsOf)
  } else if ('base' in spec) {
    const mergeBase = (await git(io, repo, ['merge-base', 'HEAD', spec.base])).trim()
    label = `The changes on this branch of \`${repo}\` since it left \`${spec.base}\` (merge base ${mergeBase.slice(0, 12)})`
    range = ['diff', mergeBase]
    changed = names(await git(io, repo, ['diff', mergeBase, '--no-renames', '--name-only', '-z', ...within]))
  } else {
    const title = (await git(io, repo, ['show', '-s', '--format=%h %s', spec.commit])).trim()
    label = `Commit ${title} in \`${repo}\``
    range = ['show', '--format=%H %s%n%n%b', spec.commit]
    changed = names(await git(io, repo, ['show', '--no-renames', '--name-only', '-z', '--format=', spec.commit, ...within]))
  }
  const kept = await withoutSecrets(repo, changed, secretsOf)
  const left = changed.length - kept.length
  const diff = kept.length === 0 ? '' : await git(io, repo, [...range, '--no-renames', '--', ...kept])
  if (diff.length > MAX_DIFF) {
    throw new Error(`crew: the diff is ${Math.round(diff.length / 1024)} KiB, over ${MAX_DIFF / 1024} KiB; review a narrower change`)
  }
  if (diff === '' && untracked.length === 0) throw new Error(`there is no change under these paths in ${repo}; leave diff out to have the code read as it is`)
  if (left > 0) label += ` (${left} secret file${left === 1 ? '' : 's'} left out of the diff)`
  return { label, diff, untracked }
}
