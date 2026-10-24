import type { FsEntry, FsStat } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import * as agy from '../hooks/antigravity.ts'
import { homeEnv } from '../hooks/antigravity.ts'
import * as claude from '../hooks/claude.ts'
import * as codex from '../hooks/codex.ts'
import { listing, search } from '../hooks/files.ts'
import type { Io } from '../hooks/io.ts'
import type { Job } from '../hooks/job.ts'
import { findSecrets, isInside, isWindowsPath, join, nameOf, namesOf, otherDrives, parentOf, resolveRoots, siblingsOf } from '../hooks/scope.ts'
import { bashUnder } from '../hooks/shell.ts'
import { readCodexCatalog } from '../hooks/catalog.ts'
import { fakeIo, ok } from './fake-io.ts'

/** A Windows disk as the engine shows it: `\` paths in the disk's case, found without case. */
function windowsDisk(dirs: string[], files: Record<string, string>, links: string[] = []): Io {
  const key = (p: string) => {
    const names: string[] = []
    for (const name of p.toLowerCase().split(/[\\/]/)) {
      if (name === '' || name === '.') continue
      if (name === '..') names.pop()
      else names.push(name)
    }
    return names.length === 1 ? `${names[0]}\\` : names.join('\\')
  }
  const parent = (p: string) => {
    const cut = p.lastIndexOf('\\')
    return cut <= 2 ? p.slice(0, 3) : p.slice(0, cut)
  }
  const byKey = new Map<string, { path: string; kind: 'dir' | 'file' | 'other' }>()
  for (const d of dirs) byKey.set(key(d), { path: d, kind: 'dir' })
  for (const f of Object.keys(files)) byKey.set(key(f), { path: f, kind: 'file' })
  for (const l of links) byKey.set(key(l), { path: l, kind: 'other' })
  const unused = async (): Promise<never> => {
    throw new Error('not in this fake')
  }
  return {
    async stat(path): Promise<FsStat> {
      const hit = byKey.get(key(path))
      if (hit === undefined) throw new Error(`ENOENT: ${path}`)
      return { kind: hit.kind, size: 0, mtimeMs: 0, isLink: links.includes(hit.path), realPath: hit.path }
    },
    async list(path): Promise<FsEntry[]> {
      const dir = byKey.get(key(path))
      if (dir?.kind !== 'dir') throw new Error(`ENOENT: ${path}`)
      return [...byKey.values()]
        .filter(e => e.path !== dir.path && key(parent(e.path)) === key(dir.path))
        .map(e => ({ name: e.path.slice(e.path.lastIndexOf('\\') + 1), kind: e.kind, size: (files[e.path] ?? '').length, mtimeMs: 0, isLink: links.includes(e.path) }))
    },
    async read(path) {
      const hit = byKey.get(key(path))
      if (hit?.kind !== 'file') throw new Error(`ENOENT: ${path}`)
      return files[hit.path]!
    },
    async exists(path) {
      return byKey.has(key(path))
    },
    write: unused,
    spawn: () => {
      throw new Error('not in this fake')
    },
    run: unused,
    now: async () => 0,
    after: () => ({ cancel: () => {} }),
    sleep: async () => {},
    agents: async () => [],
    spawnAgent: unused,
    send: unused,
    notify: unused,
  }
}

const P = 'C:\\Users\\u\\proj'
const DIRS = ['C:\\', 'C:\\Users', 'C:\\Users\\u', P, `${P}\\sub`, `${P}\\.git`, 'C:\\Windows', 'C:\\Users\\u\\.cache', 'C:\\Users\\u\\.cache\\crew', 'D:\\']
const FILES = {
  [`${P}\\main.ts`]: 'const a = 1\nconst token = 2\n',
  [`${P}\\.env`]: 'token=secret',
  [`${P}\\sub\\b.ts`]: 'token here\r\nnone\r\n',
  [`${P}\\.git\\config`]: 'token in git',
  'C:\\Users\\u\\notes.txt': 'token outside',
  'C:\\Users\\u\\proj2.txt': 'x',
}

test('Windows paths: either separator, no case, the drive root on top; POSIX paths as before', () => {
  expect(isWindowsPath('C:\\x')).toBe(true)
  expect(isWindowsPath('c:/x')).toBe(true)
  expect(isWindowsPath('\\\\server\\share')).toBe(true)
  expect(isWindowsPath('/home/x')).toBe(false)
  expect(isInside('c:/users/U/proj/a.ts', P)).toBe(true)
  expect(isInside(P, 'C:\\Users\\u\\proj\\')).toBe(true)
  expect(isInside('C:\\Users\\u\\proj2.txt', P)).toBe(false)
  expect(isInside('/home/proj/a', P)).toBe(false)
  expect(isInside('C:\\anything', 'C:\\')).toBe(true)
  expect(join('C:\\', 'Users')).toBe('C:\\Users')
  expect(join('C:\\Users/u', '.cache')).toBe('C:\\Users\\u\\.cache')
  expect(parentOf('C:\\Users')).toBe('C:\\')
  expect(parentOf('C:\\')).toBe('C:\\')
  expect(parentOf('c:/Users/u/')).toBe('c:\\Users')
  expect(nameOf('C:\\Users\\u/.env')).toBe('.env')
  expect(namesOf('C:\\a\\..\\b')).toEqual(['C:', 'a', '..', 'b'])
  expect(join('/home', 'x')).toBe('/home/x')
  expect(parentOf('/home/x')).toBe('/home')
  expect(nameOf('/a/b\\c')).toBe('b\\c')
})

test('read paths on Windows resolve to the disk spelling; secrets are found by name', async () => {
  const io = windowsDisk(DIRS, FILES)
  expect(await resolveRoots(io, ['sub', 'c:/users/u/proj/main.ts'], P)).toEqual({
    roots: [`${P}\\main.ts`, `${P}\\sub`],
    files: [`${P}\\main.ts`],
  })
  expect(await resolveRoots(io, ['.', 'SUB'], P)).toEqual({ roots: [P], files: [] })
  expect(await findSecrets(io, [P], [])).toEqual([`${P}\\.env`])
})

test("Antigravity's closed paths on Windows run from the drive root, and other drives are closed whole", async () => {
  const io = windowsDisk(DIRS, FILES)
  const work = 'C:\\Users\\u/.cache/crew'
  expect(await siblingsOf(io, [P, work])).toEqual(['C:\\Users\\u\\notes.txt', 'C:\\Users\\u\\proj2.txt', 'C:\\Windows'])
  expect(await otherDrives(io, [P, work])).toEqual(['D:\\'])
  expect(await otherDrives(io, ['/home/u'])).toEqual([])
  expect(homeEnv('C:\\h')).toEqual({ HOME: 'C:\\h', USERPROFILE: 'C:\\h' })
  expect(homeEnv('/h')).toEqual({ HOME: '/h' })
})

const fence = (roots: string[], secrets: string[] = [`${P}\\.env`]): claude.Fence => ({ roots, files: [], secrets, codexBin: 'codex' })

test("a Claude reviewer's Read on Windows is held to its roots without case and keeps out secrets", async () => {
  const io = windowsDisk(DIRS, FILES)
  expect(await claude.readRefusal(io, fence([P]), 'c:\\users\\u\\proj\\main.ts')).toBeUndefined()
  expect(await claude.readRefusal(io, fence([P]), 'C:/Users/u/proj/.ENV')).toContain('secret')
  expect(await claude.readRefusal(io, fence([P]), 'C:\\Users\\u\\notes.txt')).toContain('outside')
})

test("on Windows the Claude reviewer lists and searches with crew's tools in place of a shell", async () => {
  const [spec, web] = claude.agentSpecs('SYS', 'C:\\c\\approved', undefined, false)
  expect(spec!.tools).toEqual(['Read', 'mcp__cc-crew__reviewer_list', 'mcp__cc-crew__reviewer_search'])
  expect(web!.tools).toEqual(['Read', 'mcp__cc-crew__reviewer_list', 'mcp__cc-crew__reviewer_search', 'WebSearch', 'WebFetch'])
  expect(claude.agentSpecs('SYS', '/c/approved', undefined, true)[0]!.tools).toEqual(['Read', 'Bash'])
  expect(claude.approvedMark('C:\\c\\approved', 'toolu_1')).toBe('C:\\c\\approved\\toolu_1')
})

test("the reviewer's listing stays inside its roots, shows links unfollowed and leaves .git closed", async () => {
  const io = windowsDisk(DIRS, FILES, [`${P}\\sub\\out`])
  const listed = await listing(io, fence([P]), 'c:/users/u/proj', 3)
  expect(listed).toEqual({
    text: [P, '.env (12 bytes)', '.git/', 'main.ts (28 bytes)', 'sub/', 'sub/b.ts (18 bytes)', 'sub/out (link, not followed)'].join('\n'),
  })
  expect(await listing(io, fence([P]), 'C:\\Users\\u', 1)).toEqual({ refusal: 'C:\\Users\\u is outside the paths this review may read' })
  expect(await listing(io, fence([P]), `${P}\\main.ts`, 1)).toEqual({ refusal: `${P}\\main.ts is not a folder` })
})

test("the reviewer's search reads no secret, .git or outside file", async () => {
  const io = windowsDisk(DIRS, FILES)
  expect(await search(io, fence([P]), { pattern: 'token', path: P, ignoreCase: false })).toEqual({
    text: [`${P}\\main.ts:2: const token = 2`, `${P}\\sub\\b.ts:1: token here`].join('\n'),
  })
  expect(await search(io, fence([P]), { pattern: 'TOKEN', path: `${P}\\sub`, ignoreCase: true })).toEqual({ text: `${P}\\sub\\b.ts:1: token here` })
  expect(await search(io, fence([P]), { pattern: 'x', path: `${P}\\.env`, ignoreCase: false })).toEqual({ refusal: `${P}\\.env is a secret file` })
  expect(await search(io, fence([P]), { pattern: 'token', path: 'C:\\Users\\u\\notes.txt', ignoreCase: false })).toEqual({
    refusal: 'C:\\Users\\u\\notes.txt is outside the paths this review may read',
  })
  const bad = await search(io, fence([P]), { pattern: '(', path: P, ignoreCase: false })
  expect('refusal' in bad && bad.refusal.startsWith('the pattern is not a regular expression')).toBe(true)
})

test('on Windows a secret is known by its name in any case', async () => {
  const files = { ...FILES, [`${P}\\sub\\Server.PEM`]: 'pem', [`${P}\\ID_RSA`]: 'key' }
  const io = windowsDisk(DIRS, files)
  expect(await findSecrets(io, [P], [])).toEqual([`${P}\\.env`, `${P}\\ID_RSA`, `${P}\\sub\\Server.PEM`])
  expect(await claude.readRefusal(io, fence([P], []), `${P}\\sub\\Server.PEM`)).toContain('secret')
  expect(await search(io, fence([P], []), { pattern: 'pem|key', path: P, ignoreCase: false })).toEqual({ text: '(no matches)' })
})

test("on Windows git's folder stays closed by any spelling", async () => {
  const dirs = [...DIRS.filter(d => d !== `${P}\\.git`), `${P}\\.Git`]
  const files = { [`${P}\\main.ts`]: 'token', [`${P}\\.Git\\config`]: 'token in git' }
  const io = windowsDisk(dirs, files)
  expect(await search(io, fence([P], []), { pattern: 'token', path: P, ignoreCase: false })).toEqual({ text: `${P}\\main.ts:1: token` })
  const listed = await listing(io, fence([P], []), P, 3)
  expect('text' in listed && listed.text.includes('config')).toBe(false)
})

test('a search refuses a pattern that backtracks without end, and a folder it cannot list is noted, not fatal', async () => {
  const io = windowsDisk(DIRS, FILES)
  const nested = await search(io, fence([P]), { pattern: '(a+)+$', path: P, ignoreCase: false })
  expect('refusal' in nested && nested.refusal.includes('repeats a group')).toBe(true)
  const shaky: Io = { ...io, list: async p => (p.endsWith('sub') ? Promise.reject(new Error('EACCES')) : io.list(p)) }
  expect(await search(shaky, fence([P]), { pattern: 'token', path: P, ignoreCase: false })).toEqual({
    text: [`${P}\\main.ts:2: const token = 2`, '(1 folders could not be listed)'].join('\n'),
  })
  const listed = await listing(shaky, fence([P]), P, 2)
  expect('text' in listed && listed.text.includes('sub/ (could not be listed: Error: EACCES)')).toBe(true)
})

test('an Antigravity reviewer does not start on Windows, where its read fence is unproven', async () => {
  const pre = await agy.preflight(fakeIo(), 'agy', 'C:\\Users\\u\\.cache\\crew\\agy-home')
  expect(pre.ok).toBe(false)
  expect(!pre.ok && pre.detail).toContain('not on Windows yet')
})

const job = (over: Partial<Job> = {}): Job => ({
  dir: 'C:\\Users\\u\\.cache\\crew\\runs\\r1\\codex-default',
  roots: [P],
  files: [],
  secrets: [`${P}\\.env`],
  system: 'SYS',
  task: 'TASK',
  web: false,
  helpers: false,
  timeoutMs: 60_000,
  ...over,
})

test('a Codex reviewer on Windows runs in the MXC sandbox, the only one that takes a read-only profile without machine setup', async () => {
  const io = fakeIo({ spawn: () => ({ stdout: ['{"type":"thread.started","thread_id":"t"}\n'], code: 0 }) })
  await codex.review(io, 'codex', job())
  expect(io.spawned[0]!.argv.join(' ')).toContain('-c windows.sandbox="mxc"')
  await codex.review(io, 'codex', job({ dir: '/home/a/.cache/crew/runs/r1/codex-default', roots: ['/home/a/p'], secrets: [] }))
  expect(io.spawned[1]!.argv.join(' ')).not.toContain('windows.sandbox')
})

test("Codex's catalog answers are found by their ids wherever the answer puts them, run by the bash given", async () => {
  const signedOut = '{"error":{"code":-32600,"message":"codex account authentication required to read rate limits"},"id":2}'
  const models = '{"result":{"data":[{"id":"gpt-x","isDefault":true}]},"id":1}'
  let argv: readonly string[] = []
  const io = fakeIo({
    run: a => {
      argv = a
      return ok(['{"id":0,"result":{}}', '{"method":"remoteControl/status/changed","params":{}}', models, signedOut, ''].join('\n'))
    },
  })
  await expect(readCodexCatalog(io, 'codex', 'C:\\Git\\bin\\bash.exe')).rejects.toThrow('codex app-server: codex account authentication required to read rate limits')
  expect(argv[0]).toBe('C:\\Git\\bin\\bash.exe')
  expect(argv.slice(-2)).toEqual(['crew', 'codex'])
})

test("Git Bash is found under the Git for Windows that git's exec path names", () => {
  expect(bashUnder('C:/Program Files/Git/mingw64/libexec/git-core')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  expect(bashUnder('D:\\Tools\\Git\\clangarm64\\libexec\\git-core\\')).toBe('D:\\Tools\\Git\\bin\\bash.exe')
  expect(() => bashUnder('/usr/lib/git-core')).toThrow('not inside a Git for Windows install')
})
