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

/** How two paths compare on their system: by case on POSIX, without it on Windows. */
const pathKey = (path: string): string => (isWindowsPath(path) ? native(path).toLowerCase() : path)

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

/** The path's names from its top down; `..` stays a name, so a caller can refuse it. */
export function namesOf(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[\\/]/ : '/').filter(n => n !== '')
}

/** Where a read path lies: itself for a folder, the folder holding it for a file. */
export function folderOf(root: string, files: readonly string[]): string {
  return files.includes(root) ? parentOf(root) : root
}
