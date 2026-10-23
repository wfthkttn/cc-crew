import { expect, test } from 'claude-code/testing'

import * as agy from '../hooks/antigravity.ts'
import * as claude from '../hooks/claude.ts'
import * as codex from '../hooks/codex.ts'
import type { Job } from '../hooks/job.ts'
import { mergeCatalog, parseCatalog } from '../hooks/catalog.ts'
import { settingsFrom, withDefaults } from '../hooks/config.ts'
import { run } from '../hooks/proc.ts'
import { parseFindings, renderFindings, systemPrompt, taskText } from '../hooks/prompt.ts'
import { type Run, execute, keysFor, load, stopReviewer, summary } from '../hooks/runs.ts'
import { SECRET_NAME, findSecrets, resolveRoots, siblingsOf } from '../hooks/scope.ts'
import { type Fake, fakeIo, ok } from './fake-io.ts'

const PROJECT = '/home/u/Projects/p'
const DIRS = ['/', '/home', '/home/u', '/home/u/Projects', PROJECT, `${PROJECT}/sub`, `${PROJECT}/.git`, '/tmp', '/etc']
const FILES = {
  [`${PROJECT}/main.ts`]: 'code',
  [`${PROJECT}/.env`]: 'A=1',
  [`${PROJECT}/sub/.env.local`]: 'B=2',
  [`${PROJECT}/sub/cert.pem`]: 'pem',
  [`${PROJECT}/.git/.env`]: 'in git',
  '/home/u/notes.txt': 'x',
  '/home/u/Projects/other.txt': 'y',
}

const FINDINGS = {
  summary: 'One bug.',
  findings: [
    {
      title: 'Off by one',
      priority: 1,
      confidence: 0.8,
      file: 'main.ts',
      line_start: 3,
      line_end: 4,
      scenario: 'n = 0',
      body: 'Loop skips the last item.',
      pre_existing: false,
    },
  ],
  checked: ['main.ts'],
  not_read: [],
}

function job(over: Partial<Job> = {}): Job {
  return {
    dir: '/home/u/.cache/crew/runs/r1/codex-default',
    roots: [PROJECT],
    files: [],
    secrets: [`${PROJECT}/.env`],
    system: 'SYSTEM',
    task: 'TASK',
    web: false,
    helpers: false,
    timeoutMs: 60_000,
    ...over,
  }
}

test('secret files under the roots are found by name, .git left alone', async () => {
  const io = fakeIo({ files: FILES, dirs: DIRS })
  expect(await findSecrets(io, [PROJECT], [])).toEqual([`${PROJECT}/.env`, `${PROJECT}/sub/.env.local`, `${PROJECT}/sub/cert.pem`])
})

test('a file root is a secret by its own name and is not listed', async () => {
  const io = fakeIo({ files: FILES, dirs: DIRS })
  const files = [`${PROJECT}/.env`, `${PROJECT}/main.ts`]
  expect(await findSecrets(io, files, files)).toEqual([`${PROJECT}/.env`])
})

test('a root inside another root is dropped; a missing one is refused', async () => {
  const io = fakeIo({ files: FILES, dirs: DIRS })
  expect(await resolveRoots(io, ['.', 'sub', 'main.ts'], PROJECT)).toEqual({ roots: [PROJECT], files: [] })
  expect(await resolveRoots(io, 'none', PROJECT)).toEqual({ roots: [], files: [] })
  await expect(resolveRoots(io, ['nope'], PROJECT)).rejects.toThrow('read path not found')
})

test('a file can be a read path, told apart from the folders', async () => {
  const io = fakeIo({ files: FILES, dirs: DIRS })
  expect(await resolveRoots(io, ['sub', 'main.ts'], PROJECT)).toEqual({
    roots: [`${PROJECT}/main.ts`, `${PROJECT}/sub`],
    files: [`${PROJECT}/main.ts`],
  })
})

test('everything beside the way down to the kept paths is denied', async () => {
  const io = fakeIo({ files: FILES, dirs: [...DIRS, '/home/u/.cache', '/home/u/.cache/crew'] })
  const denied = await siblingsOf(io, [PROJECT, '/home/u/.cache/crew'])
  expect(denied).toEqual(['/etc', '/home/u/Projects/other.txt', '/home/u/notes.txt', '/tmp'])
})

test('the Codex profile reads the roots, denies secrets and starts from nothing else', () => {
  const p = codex.profile([PROJECT, '/srv/docs'], [`${PROJECT}/.env`], PROJECT)
  expect(p).toStartWith('{":minimal"="read", ":workspace_roots"={"."="read", "**/.env"="deny"')
  expect(p).toContain('"/srv/docs"="read"')
  expect(p).not.toContain(`"${PROJECT}"="read"`)
  expect(p).toContain(`"${PROJECT}/.env"="deny"`)
  expect(p).not.toContain(':root')
})

test('a Codex review of files alone runs in an empty folder with each file readable', async () => {
  const j = job({ roots: [`${PROJECT}/main.ts`], files: [`${PROJECT}/main.ts`], secrets: [] })
  const io = fakeIo({
    spawn: () => ({ stdout: ['{"type":"thread.started","thread_id":"th-1"}\n'], writes: { [`${j.dir}/answer.txt`]: JSON.stringify(FINDINGS) } }),
  })
  expect((await codex.review(io, 'codex', j)).status).toBe('ok')
  const req = io.spawned[0]!
  expect(req.cwd).toBe(`${j.dir}/empty`)
  const profile = req.argv.find(a => a.startsWith('permissions.crew.filesystem='))!
  expect(profile).toBe(`permissions.crew.filesystem={":minimal"="read", "${PROJECT}/main.ts"="read"}`)
})

test('a Codex review answers its findings and its thread', async () => {
  const j = job()
  const io = fakeIo({
    spawn: () => ({
      stdout: [
        '{"type":"thread.started","thread_id":"th-1"}\n{"type":"turn.started"}\n',
        `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"x"}}\n`,
        '{"type":"turn.completed","usage":{"input_tokens":5}}\n',
      ],
      writes: { [`${j.dir}/answer.txt`]: JSON.stringify(FINDINGS) },
    }),
  })
  const o = await codex.review(io, 'codex', j)
  expect(o.status).toBe('ok')
  expect(o.continueId).toBe('th-1')
  expect(o.findings?.findings[0]?.title).toBe('Off by one')
  const argv = io.spawned[0]!.argv
  expect(argv).toContain('--ignore-user-config')
  expect(argv).toContain('web_search="disabled"')
  expect(argv).toContain('multi_agent')
  expect(argv.at(-1)).toBe('-')
  expect(io.spawned[0]!.input).toBe('TASK')
  expect(io.spawned[0]!.cwd).toBe(PROJECT)
})

test('Codex rejected for its sign-in is reported signed out', async () => {
  const io = fakeIo({
    spawn: () => ({
      stdout: ['{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer)"}\n'],
      code: 1,
    }),
  })
  const o = await codex.review(io, 'codex', job())
  expect(o.status).toBe('signed_out')
  expect(o.detail).toContain('codex login --device-auth')
})

test('Codex preflight reads its login status', async () => {
  expect(await codex.preflight(fakeIo({ run: () => ok('Logged in using ChatGPT') }), 'codex')).toEqual({ ok: true })
  const out = await codex.preflight(fakeIo({ run: () => ok('', 'Not logged in', 1) }), 'codex')
  expect(out).toMatchObject({ ok: false, status: 'signed_out' })
})

test('a child that outlives its timeout is killed', async () => {
  const io = fakeIo({ spawn: () => ({ hang: true }) })
  const pending = run(io, { argv: ['sleep', '99'] }, { timeoutMs: 5_000 })
  await Promise.resolve()
  io.advance(5_000)
  const r = await pending
  expect(r.ended.kind).toBe('timeout')
  expect(io.killed).toBe(1)
})

const agyResult = (response: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response, usage: { input_tokens: 9 }, ...extra } }) + '\n'

test('an Antigravity review runs the fenced reviewer agent in its own home', async () => {
  const j = job({ dir: '/home/u/.cache/crew/runs/r1/antigravity-default' })
  const io = fakeIo({
    files: FILES,
    dirs: [...DIRS, '/home/u/.cache', '/home/u/.cache/crew', '/home/u/.cache/crew/runs', '/home/u/.cache/crew/runs/r1', j.dir, `${j.dir}/work`],
    spawn: () => ({ stdout: ['{"event":"init","conversation_id":"c-1","init":{}}\n', agyResult(JSON.stringify(FINDINGS))] }),
  })
  const o = await agy.review(io, 'agy', j)
  expect(o.status).toBe('ok')
  expect(o.continueId).toBe('c-1')
  const req = io.spawned[0]!
  expect(req.env).toEqual({ HOME: `${j.dir}/home` })
  expect(req.cwd).toBe(`${j.dir}/work`)
  expect(req.argv).toContain('--add-dir')
  expect(req.argv).toContain(agy.AGENT)
  const settings = JSON.parse(io.files.get(`${j.dir}/home/.gemini/antigravity-cli/settings.json`)!)
  expect(settings.permissions.deny).toContain('write_file(*)')
  expect(settings.permissions.deny).toContain(`read_file(${PROJECT}/.env)`)
  expect(settings.permissions.deny).toContain('read_file(/tmp)')
  expect(settings.permissions.deny).toContain('read_file(/home/u/notes.txt)')
  expect(settings.permissions.deny).not.toContain(`read_file(${PROJECT})`)
  expect(req.argv[req.argv.indexOf('--add-dir') + 1]).toBe(PROJECT)
  const agent = io.files.get(`${j.dir}/work/.agents/agents/${agy.AGENT}/agent.md`)!
  expect(agent).toContain('tools: [view_file, list_dir, find_by_name, finish]')
  expect(agent).toContain('excludeDefaultComponents: true')
  expect(agent).toContain('SYSTEM')
})

test('an Antigravity review of a file adds its folder and closes the rest of it', async () => {
  const main = `${PROJECT}/main.ts`
  const j = job({ dir: '/r/a', roots: [main], files: [main], secrets: [] })
  const io = fakeIo({
    files: FILES,
    dirs: [...DIRS, '/r', '/r/a', '/r/a/work'],
    spawn: () => ({ stdout: [agyResult(JSON.stringify(FINDINGS))] }),
  })
  expect((await agy.review(io, 'agy', j)).status).toBe('ok')
  const argv = io.spawned[0]!.argv
  expect(argv.filter((a, i) => argv[i - 1] === '--add-dir')).toEqual([PROJECT])
  const deny = JSON.parse(io.files.get(`${j.dir}/home/.gemini/antigravity-cli/settings.json`)!).permissions.deny
  expect(deny).toContain(`read_file(${PROJECT}/.env)`)
  expect(deny).toContain(`read_file(${PROJECT}/sub)`)
  expect(deny).not.toContain(`read_file(${main})`)
})

test('an Antigravity review with web on is allowed page reads, which headless runs would refuse; without web they stay denied', async () => {
  for (const web of [true, false]) {
    const j = job({ dir: '/r/a', web })
    const io = fakeIo({ files: FILES, dirs: [...DIRS, '/r', '/r/a', '/r/a/work'], spawn: () => ({ stdout: [agyResult(JSON.stringify(FINDINGS))] }) })
    await agy.review(io, 'agy', j)
    const { allow, deny } = JSON.parse(io.files.get(`${j.dir}/home/.gemini/antigravity-cli/settings.json`)!).permissions
    expect(allow).toEqual(web ? ['read_url(*)'] : [])
    expect(deny.includes('read_url(*)')).toBe(!web)
  }
})

test('an Antigravity run that left its paths is tried once more, warned', async () => {
  const j = job({ dir: '/r/a' })
  const io = fakeIo({
    files: FILES,
    dirs: [...DIRS, '/r', '/r/a', '/r/a/work'],
    spawn: (_, n) =>
      n === 0
        ? { stdout: [agyResult('', { denied_actions: [{ action: 'read_file' }] })] }
        : { stdout: [agyResult(JSON.stringify(FINDINGS))] },
  })
  const o = await agy.review(io, 'agy', j)
  expect(o.status).toBe('ok')
  expect(io.spawned).toHaveLength(2)
  expect(io.spawned[1]!.argv[2]).toStartWith('Your previous attempt')
})

test('a signed-out Antigravity is told apart in preflight', async () => {
  const io = fakeIo({ spawn: () => ({ stdout: ['Authentication required. Please visit the URL to log in:\n'], hang: true }) })
  const pending = agy.preflight(io, 'agy', '/h')
  await Promise.resolve()
  io.advance(20_000)
  expect(await pending).toMatchObject({ ok: false, status: 'signed_out' })
})

test('findings are read from bare JSON or JSON inside prose, and rendered by priority', () => {
  expect(parseFindings(JSON.stringify(FINDINGS))?.summary).toBe('One bug.')
  expect(parseFindings('Here:\n```json\n' + JSON.stringify(FINDINGS) + '\n```')?.findings).toHaveLength(1)
  expect(parseFindings('no json here')).toBeUndefined()
  expect(renderFindings(FINDINGS)).toContain('### [P1] Off by one — `main.ts:3-4`')
})

test('the rule files follow the shared prompt; the task states the access', () => {
  expect(systemPrompt([{ path: '/r.md', text: 'Cite file:line.' }])).toContain('### /r.md\n\nCite file:line.')
  const t = taskText({ brief: 'Look at X', roots: [PROJECT], web: false })
  expect(t).toContain(`You may read: \`${PROJECT}\`. Web: not available.`)
})

test('a Claude reviewer may read inside its roots, never a secret, never outside', async () => {
  const io = fakeIo({ files: FILES, dirs: DIRS })
  const fence = { roots: [PROJECT], files: [], secrets: [`${PROJECT}/.env`], codexBin: 'codex' }
  expect(await claude.readRefusal(io, fence, `${PROJECT}/main.ts`)).toBeUndefined()
  expect(await claude.readRefusal(io, fence, `${PROJECT}/.env`)).toContain('secret')
  expect(await claude.readRefusal(io, fence, '/home/u/notes.txt')).toContain('outside')
  const file = { ...fence, roots: [`${PROJECT}/main.ts`], files: [`${PROJECT}/main.ts`] }
  expect(await claude.readRefusal(io, file, `${PROJECT}/main.ts`)).toBeUndefined()
  expect(await claude.readRefusal(io, file, `${PROJECT}/sub/cert.pem`)).toContain('outside')
})

test("a Claude reviewer's shell runs inside Codex's sandbox", () => {
  const fence = { roots: [PROJECT], files: [], secrets: [], codexBin: '/bin/codex' }
  const cmd = claude.fencedCommand(fence, "grep -r 'x' .")!
  expect(cmd).toStartWith(`cd '${PROJECT}' && '/bin/codex' 'sandbox'`)
  expect(cmd).toEndWith(`'--' 'sh' '-c' 'grep -r '\\''x'\\'' .'`)
  expect(claude.fencedCommand({ ...fence, roots: [] }, 'ls')).toBeUndefined()
  const main = `${PROJECT}/main.ts`
  const onFile = claude.fencedCommand({ ...fence, roots: [main], files: [main] }, 'cat main.ts')!
  expect(onFile).toStartWith(`cd '${PROJECT}' && `)
  expect(onFile).toContain(`'permissions.crew.filesystem={":minimal"="read", "${main}"="read"}'`)
})

test('a run reports each reviewer, alerts on a sign-in, and sums up', async () => {
  const io: Fake = fakeIo({
    files: FILES,
    dirs: DIRS,
    run: argv => (argv[1] === 'login' ? ok('', 'Not logged in', 1) : ok()),
  })
  const keys = keysFor([{ provider: 'codex' }, { provider: 'claude-p' }, { provider: 'codex' }])
  expect(keys).toEqual(['codex-default', 'claude-p-default', 'codex-default-2'])
  const r: Run = {
    id: 'r1',
    description: 'Check X',
    createdAt: 0,
    reportDir: `${PROJECT}/.claude/work/reviews/r1-check-x`,
    runDir: '/c/runs/r1',
    roots: [PROJECT],
    secrets: [],
    web: false,
    helpers: false,
    reviewers: [
      { provider: 'codex', key: 'codex-default', status: 'running', dir: '/c/runs/r1/codex-default', startedAt: 0 },
      { provider: 'claude-p', key: 'claude-p-default', status: 'running', dir: '/c/runs/r1/claude-p-default', startedAt: 0 },
    ],
  }
  const settings = { codexBin: 'codex', agyBin: 'agy', reviewers: [], defaults: {}, reviewerRules: [], timeoutMs: 60_000, fallbackUsd: 9 }
  const alert = async (_: unknown, provider: string, detail: string) => {
    io.notified.push(`${provider}: ${detail}`)
    return undefined
  }
  await execute(io, r, settings, 'SYS', 'TASK', '/c', alert, new Map())
  expect(r.reviewers.map(x => x.status)).toEqual(['signed_out', 'failed'])
  expect(io.notified[0]).toStartWith('codex: Codex is signed out')
  expect(io.files.has(`${r.reportDir}/codex-default.md`)).toBe(true)
  expect(io.files.has(`${r.reportDir}/run.json`)).toBe(true)
  const s = summary(r)
  expect(s).toContain('- codex-default (default): SIGNED OUT: Codex is signed out')
  expect(s).toContain('claude-p is a stub')
})

test('a running Codex reviewer stopped from the tab is killed and reads as stopped; a finished one keeps its tokens', async () => {
  const io: Fake = fakeIo({
    files: FILES,
    dirs: DIRS,
    run: () => ok('Logged in using ChatGPT'),
    spawn: (_, n) =>
      n === 0
        ? { hang: true }
        : { stdout: ['{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":600,"output_tokens":40,"reasoning_output_tokens":10}}\n'] },
  })
  const reviewer = (key: string) => ({ provider: 'codex' as const, key, status: 'running' as const, dir: `/c/runs/r2/${key}`, startedAt: 0 })
  const r: Run = {
    id: 'r2',
    description: 'Stop me',
    createdAt: 0,
    reportDir: `${PROJECT}/.claude/work/reviews/r2-stop-me`,
    runDir: '/c/runs/r2',
    roots: [PROJECT],
    secrets: [],
    web: false,
    helpers: false,
    reviewers: [reviewer('codex-default'), reviewer('codex-default-2')],
  }
  const settings = { codexBin: 'codex', agyBin: 'agy', reviewers: [], defaults: {}, reviewerRules: [], timeoutMs: 60_000, fallbackUsd: 9 }
  const done = execute(io, r, settings, 'SYS', 'TASK', '/c', async () => undefined, new Map())
  for (let i = 0; i < 10_000 && io.spawned.length < 2; i++) await Promise.resolve()
  expect(stopReviewer('r2', 'codex-default')).toBe(true)
  await done
  expect(r.reviewers.map(x => x.status)).toEqual(['stopped', 'failed'])
  expect(io.killed).toBe(1)
  expect(r.reviewers[1]!.tokens).toEqual({ in: 900, cached: 600, out: 40, reasoning: 10 })
  expect(stopReviewer('r2', 'codex-default')).toBe(false)
})

test('a run left running by an earlier load of crew reads back as stopped', async () => {
  const stale: Run = {
    id: 'old1',
    description: 'Old',
    createdAt: 0,
    reportDir: `${PROJECT}/.claude/work/reviews/old1-old`,
    runDir: '/c/runs/old1',
    roots: [PROJECT],
    secrets: [],
    web: false,
    helpers: false,
    reviewers: [
      { provider: 'codex', key: 'codex-default', status: 'running', dir: '/c/runs/old1/codex-default', startedAt: 0 },
      { provider: 'claude', key: 'claude-sonnet', status: 'ok', dir: '/c/runs/old1/claude-sonnet', startedAt: 0 },
    ],
  }
  const io = fakeIo({ files: { '/c/runs/old1/run.json': JSON.stringify(stale) } })
  const run = await load(io, '/c', 'old1')
  expect(run.reviewers.map(r => r.status)).toEqual(['stopped', 'ok'])
  expect(JSON.parse(io.files.get('/c/runs/old1/run.json')!).reviewers[0].status).toBe('stopped')
  expect(summary(run)).toContain('codex-default (default): STOPPED: cut off')
})

test('secret names cover keys, tokens and cloud credentials', () => {
  for (const name of ['.envrc', '.git-credentials', '.npmrc', '.pypirc', 'cert.p12', 'id.pfx', 'vault.kdbx', 'terraform.tfstate', 'terraform.tfstate.backup', 'credentials', 'kubeconfig']) {
    expect(SECRET_NAME.test(name)).toBe(true)
  }
  for (const name of ['main.ts', 'envrc.md', 'credentials.ts', 'secrets.rs', 'keys.txt']) {
    expect(SECRET_NAME.test(name)).toBe(false)
  }
})

test('the Claude reviewer is held by its own gate on every Read and Bash', () => {
  const [spec] = claude.agentSpecs('SYS', '/c/approved', undefined)
  expect('effort' in spec!).toBe(false)
  expect(claude.agentSpecs('SYS', '/c/approved', 'high').map(s => s.effort)).toEqual(['high', 'high'])
  const pre = (spec!.hooks as { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }).PreToolUse
  expect(pre[0]!.matcher).toBe('Read|Bash')
  expect(pre[0]!.hooks[0]!.command).toContain(`'/c/approved'/"$id"`)
  expect(pre[0]!.hooks[0]!.command).toContain('exit 2')
  expect(claude.approvedMark('/c/approved', 'toolu_1')).toBe('/c/approved/toolu_1')
})

test("a reviewer runs its provider's configured model and effort unless the call names its own; empty settings leave the tool's default", () => {
  const s = settingsFrom({ codex_bin: 'codex', agy_bin: 'agy', reviewers: ['codex'], codex_model: '', codex_effort: 'medium', agy_model: 'gemini-4-argon-high', agy_effort: '', claude_model: 'opus', reviewer_rules: [], timeout_s: 900, model_limits: [] })
  expect(withDefaults({ provider: 'codex' }, s.defaults)).toEqual({ provider: 'codex', effort: 'medium' })
  expect(withDefaults({ provider: 'codex', effort: 'xhigh' }, s.defaults)).toEqual({ provider: 'codex', effort: 'xhigh' })
  expect(withDefaults({ provider: 'antigravity' }, s.defaults)).toEqual({ provider: 'antigravity', model: 'gemini-4-argon-high' })
  expect(withDefaults({ provider: 'claude', model: 'haiku' }, s.defaults)).toEqual({ provider: 'claude', model: 'haiku' })
  expect(withDefaults({ provider: 'claude' }, s.defaults)).toEqual({ provider: 'claude', model: 'opus' })
  expect(withDefaults({ provider: 'claude-p' }, s.defaults)).toEqual({ provider: 'claude-p' })
})

test("a person's models.json replaces crew's groups, aliases and prices by name and keeps the rest; one that is no object is refused", () => {
  const shipped = parseCatalog(
    JSON.stringify({ groups: { a: { name: 'A', provider: 'codex', models: ['m'] } }, aliases: { 'codex/default': 'codex/m' }, prices: { 'codex/m': { in: 1, cached: 0.1, written: 0, out: 5 } } }),
    'shipped.json',
  )
  const own = parseCatalog(JSON.stringify({ groups: { a: { name: 'A', provider: 'codex', models: ['m'], limitUsd: 3 } }, prices: { 'codex/n': { in: 2, cached: 0.2, written: 0, out: 9 } } }), 'own.json')
  const catalog = mergeCatalog(shipped, own)
  expect(catalog.groups).toEqual([{ id: 'a', name: 'A', provider: 'codex', models: ['m'], limitUsd: 3 }])
  expect(catalog.aliases).toEqual({ 'codex/default': 'codex/m' })
  expect(Object.keys(catalog.prices)).toEqual(['codex/m', 'codex/n'])
  expect(() => parseCatalog('[]', 'x.json')).toThrow('x.json must hold an object')
  expect(() => parseCatalog('{', 'x.json')).toThrow('x.json is not JSON')
})
