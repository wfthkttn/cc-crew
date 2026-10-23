import type { Io } from './io.ts'

export type ReadSpec = 'project' | 'none' | readonly string[]

export const SECRET_NAME =
  /^(\.env(\..+)?|.+\.env|\.envrc|.+\.(pem|key|p12|pfx|kdbx|tfstate)|.+\.tfstate\.backup|id_(rsa|ed25519|ecdsa|dsa)|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|credentials(\.json)?|kubeconfig)$/

const SKIP_DIRS = new Set(['.git'])

/** A read root this large is refused rather than scanned for minutes. */
const MAX_DIRS = 50_000

export function isInside(path: string, root: string): boolean {
  if (root === '/') return path.startsWith('/')
  return path === root || path.startsWith(root + '/')
}

export function join(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

async function realRoot(io: Io, path: string): Promise<{ path: string; isFile: boolean }> {
  let stat
  try {
    stat = await io.stat(path, { resolve: true })
  } catch (err) {
    throw new Error(`crew: read path not found: ${path} (${String(err)})`)
  }
  if (stat.realPath === undefined) throw new Error(`crew: read path does not resolve: ${path}`)
  if (stat.kind === 'other') throw new Error(`crew: read path is neither a file nor a folder: ${path}`)
  return { path: stat.realPath, isFile: stat.kind === 'file' }
}

/** What a review may read: real absolute paths, none nested in another, and which of them are files. */
export type Roots = { roots: string[]; files: string[] }

export async function resolveRoots(io: Io, read: ReadSpec, project: string): Promise<Roots> {
  if (read === 'none') return { roots: [], files: [] }
  const given = read === 'project' ? [project] : read.map(p => (p.startsWith('/') ? p : join(project, p)))
  const real = await Promise.all(given.map(p => realRoot(io, p)))
  const unique = [...new Set(real.map(r => r.path))].sort()
  const roots = unique.filter(r => !unique.some(o => o !== r && isInside(r, o)))
  return { roots, files: roots.filter(r => real.some(x => x.path === r && x.isFile)) }
}

/** The folder a reviewer works in: the first read path that is a folder. */
export function workFolder(roots: readonly string[], files: readonly string[]): string | undefined {
  return roots.find(r => !files.includes(r))
}

/** Where a read path lies: itself for a folder, the folder holding it for a file. */
export function folderOf(root: string, files: readonly string[]): string {
  return files.includes(root) ? parentOf(root) : root
}

const isSecretName = (path: string) => SECRET_NAME.test(path.slice(path.lastIndexOf('/') + 1))

/** Every file under the folder roots, and every file root, whose name marks it as a secret, links included. */
export async function findSecrets(io: Io, roots: readonly string[], files: readonly string[]): Promise<string[]> {
  const found = files.filter(isSecretName)
  const queue = roots.filter(r => !files.includes(r))
  let seen = 0
  while (queue.length > 0) {
    const batch = queue.splice(0, 32)
    seen += batch.length
    if (seen > MAX_DIRS) {
      throw new Error(`crew: more than ${MAX_DIRS} folders under ${roots.join(', ')}; name narrower read paths`)
    }
    const listings = await Promise.all(batch.map(async dir => ({ dir, entries: await io.list(dir) })))
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.kind === 'dir' && !entry.isLink) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(path)
        } else if (SECRET_NAME.test(entry.name)) {
          found.push(path)
        }
      }
    }
  }
  return found.sort()
}

/**
 * Every path beside the way down from `/` to each kept path: denying them all closes the
 * disk except the kept paths, for a harness whose deny rules beat its allow rules.
 */
export async function siblingsOf(io: Io, keep: readonly string[]): Promise<string[]> {
  const onTheWay = new Set<string>()
  for (const path of keep) {
    let cur = path
    while (cur !== '/') {
      onTheWay.add(cur)
      cur = parentOf(cur)
    }
  }
  const ancestors = new Set<string>(['/'])
  for (const path of onTheWay) {
    if (!keep.includes(path)) ancestors.add(path)
  }
  for (const path of keep) ancestors.add(parentOf(path))
  const denied: string[] = []
  for (const dir of [...ancestors].sort()) {
    if (keep.some(k => isInside(dir, k))) continue
    let entries
    try {
      entries = await io.list(dir)
    } catch (err) {
      throw new Error(`crew: cannot list ${dir} to close it off: ${String(err)}`)
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (!onTheWay.has(path)) denied.push(path)
    }
  }
  return denied.sort()
}
