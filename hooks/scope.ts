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

async function realDir(io: Io, path: string): Promise<string> {
  let stat
  try {
    stat = await io.stat(path, { resolve: true })
  } catch (err) {
    throw new Error(`crew: read path not found: ${path} (${String(err)})`)
  }
  if (stat.realPath === undefined) throw new Error(`crew: read path does not resolve: ${path}`)
  return stat.realPath
}

/** The read roots as real absolute paths, none nested in another. */
export async function resolveRoots(
  io: Io,
  read: ReadSpec,
  project: string,
): Promise<string[]> {
  if (read === 'none') return []
  const given = read === 'project' ? [project] : read.map(p => (p.startsWith('/') ? p : join(project, p)))
  const real = await Promise.all(given.map(p => realDir(io, p)))
  const unique = [...new Set(real)].sort()
  return unique.filter(r => !unique.some(o => o !== r && isInside(r, o)))
}

/** Every file under the roots whose name marks it as a secret, links included. */
export async function findSecrets(io: Io, roots: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const queue = [...roots]
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
