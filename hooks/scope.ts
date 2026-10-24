import type { Io } from './io.ts'

export type ReadSpec = 'project' | 'none' | readonly string[]

export const SECRET_NAME =
  /^(\.env(\..+)?|.+\.env|\.envrc|.+\.(pem|key|p12|pfx|kdbx|tfstate)|.+\.tfstate\.backup|id_(rsa|ed25519|ecdsa|dsa)|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|credentials(\.json)?|kubeconfig)$/

const SKIP_DIRS = new Set(['.git'])

/** A read root this large is refused rather than scanned for minutes. */
const MAX_DIRS = 50_000

/**
 * A path in Windows' form: a drive letter and a separator, or a share (`\\server\share`). Such a path takes `\` and
 * `/` alike, is compared without case, and its top is its drive's or share's root; any other path is POSIX.
 */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)

export const isAbsolute = (path: string): boolean => path.startsWith('/') || isWindowsPath(path)

/** A Windows path with `\` throughout and no trailing one but its top's; a POSIX path as given. */
function native(path: string): string {
  if (!isWindowsPath(path)) return path
  const p = path.replace(/[\\/]+/g, '\\').replace(/^\\/, '\\\\')
  const top = topOf(p)
  return p.length > top.length ? p.replace(/\\+$/, '') : top
}

/** `/`, `C:\`, or `\\server\share\` for a share. */
function topOf(path: string): string {
  if (!isWindowsPath(path)) return '/'
  const p = path.replace(/[\\/]+/g, '\\').replace(/^\\/, '\\\\')
  if (/^[A-Za-z]:/.test(p)) return `${p.slice(0, 2).toUpperCase()}\\`
  const share = /^\\\\[^\\]+\\[^\\]+/.exec(p)
  return `${share?.[0] ?? p.replace(/\\+$/, '')}\\`
}

export const isTop = (path: string): boolean => native(path) === topOf(path)

/** How two paths compare on their system: by case on POSIX, without it on Windows. */
export const pathKey = (path: string): string => (isWindowsPath(path) ? native(path).toLowerCase() : path)

export function isInside(path: string, root: string): boolean {
  if (isWindowsPath(root)) {
    if (!isWindowsPath(path)) return false
    const p = pathKey(path)
    const r = pathKey(root)
    return p === r || p.startsWith(r.endsWith('\\') ? r : r + '\\')
  }
  if (root === '/') return path.startsWith('/')
  return path === root || path.startsWith(root + '/')
}

export function join(dir: string, name: string): string {
  if (isWindowsPath(dir)) {
    const d = native(dir)
    return d.endsWith('\\') ? d + name : `${d}\\${name}`
  }
  return dir === '/' ? '/' + name : dir + '/' + name
}

export function parentOf(path: string): string {
  if (isWindowsPath(path)) {
    const p = native(path)
    const top = topOf(p)
    const cut = p.lastIndexOf('\\')
    return cut < top.length ? top : p.slice(0, cut)
  }
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function nameOf(path: string): string {
  const cut = isWindowsPath(path) ? Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) : path.lastIndexOf('/')
  return path.slice(cut + 1)
}

/** The path's names from its top down; `..` stays a name, so a caller can refuse it. */
export function namesOf(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[\\/]/ : '/').filter(n => n !== '')
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
  const given = read === 'project' ? [project] : read.map(p => (isAbsolute(p) ? p : join(project, p)))
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

const SECRET_NAME_ANY_CASE = new RegExp(SECRET_NAME.source, 'i')

/** Whether the file's name marks it as a secret: without case on Windows, where every spelling opens the file. */
export const isSecretPath = (path: string): boolean => (isWindowsPath(path) ? SECRET_NAME_ANY_CASE : SECRET_NAME).test(nameOf(path))

/** Every file under the folder roots, and every file root, whose name marks it as a secret, links included. */
export async function findSecrets(io: Io, roots: readonly string[], files: readonly string[]): Promise<string[]> {
  const found = files.filter(isSecretPath)
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
        } else if (isSecretPath(path)) {
          found.push(path)
        }
      }
    }
  }
  return found.sort()
}

/**
 * Every path beside the way down from the top (`/`, a drive's root) to each kept path: denying them all closes the
 * disk except the kept paths, for a harness whose deny rules beat its allow rules. Windows paths come back with `\`;
 * the other drives are `otherDrives`'.
 */
export async function siblingsOf(io: Io, keep: readonly string[]): Promise<string[]> {
  const kept = new Set(keep.map(pathKey))
  const onTheWay = new Set<string>()
  const ancestors = new Map<string, string>()
  for (const path of keep) {
    let cur = native(path)
    while (!isTop(cur)) {
      onTheWay.add(pathKey(cur))
      cur = parentOf(cur)
    }
    ancestors.set(pathKey(cur), cur)
  }
  for (const path of keep) {
    for (let cur = parentOf(path); !isTop(cur); cur = parentOf(cur)) {
      if (!kept.has(pathKey(cur))) ancestors.set(pathKey(cur), cur)
    }
  }
  const denied: string[] = []
  for (const dir of [...ancestors.values()].sort()) {
    if (keep.some(k => isInside(dir, k))) continue
    let entries
    try {
      entries = await io.list(dir)
    } catch (err) {
      throw new Error(`crew: cannot list ${dir} to close it off: ${String(err)}`)
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (!onTheWay.has(pathKey(path))) denied.push(path)
    }
  }
  return denied.sort()
}

/** The roots of the drives present beside those of the kept Windows paths; none for POSIX paths. */
export async function otherDrives(io: Io, keep: readonly string[]): Promise<string[]> {
  const windows = keep.filter(isWindowsPath)
  if (windows.length === 0) return []
  const ours = new Set(windows.map(topOf))
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\`).filter(d => !ours.has(d))
  const present = await Promise.all(letters.map(async d => ((await io.exists(d)) ? d : null)))
  return present.filter((d): d is string => d !== null)
}
