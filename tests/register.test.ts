import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const RECORDS = `${HOME}/.cache/crew/sessions`
const POOLS = ['claude', 'codex']

/**
 * Puts up the nouns of the mods crew calls, so the test's hooks beneath answer their calls; `crew-test-limit` raises
 * `providers.limitReached` as cc-providers does, `crew-test-ended` and `crew-test-changed` the calls cc-agents makes,
 * `crew-test-tell` tells on the bus as a carrier does. An inline plugin sees nothing of this file, so it is all literals.
 */
const mods = {
  name: 'mods',
  register(on: any) {
    on('engine.create', async (_$: unknown, e: unknown, next: (e: unknown) => Promise<any>) => {
      const built = await next(e)
      const unused = () => Promise.reject(new Error('answered by the test'))
      const noun = (names: string[]) => Object.fromEntries(names.map(n => [n, unused]))
      return {
        ...built,
        providers: noun(['list', 'catalog', 'poolOf', 'sessionProvider', 'limits', 'quota', 'raise', 'switchLimits', 'close', 'limitReached', 'modelKey', 'checkModel', 'roots', 'secretPaths']),
        agents: noun(['start', 'placeable', 'kinds', 'profiles', 'followUp', 'stop', 'health', 'get', 'list', 'outcome', 'subagents', 'prompt', 'conversation', 'isIdle', 'hold', 'release', 'ended', 'changed']),
        sidebar: noun(['register', 'badge', 'gauge', 'selected', 'modal', 'room']),
        bus: noun(['ask', 'tell']),
        conversation: noun(['tell', 'deliver']),
      }
    })
    on('command.run', { command: 'crew-test-limit' }, async ($: any, e: { args: string }) => {
      await $.providers.limitReached(JSON.parse(e.args))
      return { text: '' }
    })
    on('command.run', { command: 'crew-test-tell' }, async ($: any, e: { args: string }) => {
      await $.bus.tell(JSON.parse(e.args))
      return { text: '' }
    })
    on('command.run', { command: 'crew-test-ended' }, async ($: any, e: { args: string }) => {
      await $.agents.ended(JSON.parse(e.args))
      return { text: '' }
    })
    on('command.run', { command: 'crew-test-changed' }, async ($: any, e: { args: string }) => {
      await $.agents.changed(JSON.parse(e.args))
      return { text: '' }
    })
  },
}
const MODS = { plugins: [mods] }
const JOB = { description: 'Do it.', prompt: 'prompts/job.md', kind: 'oneshot', profile: 'read-only', prefer: ['quota', 'unread', 'api'], web: false, helpers: false, timeoutMin: 60, pokeMin: 20, stallMin: 10 }
const CREW = JSON.stringify({
  jobs: {
    review: {
      ...JOB,
      paths: 'required',
      diff: true,
      models: { 'openai/gpt-6.1-sol': { effort: 'medium' }, 'anthropic/claude-sonnet-5-5': { effort: 'high' }, 'zhipu/glm-5.3': {} },
      default: ['openai/gpt-6.1-sol'],
      bySessionModel: { 'claude/opus': ['anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-sol'] },
    },
    research: { ...JOB, web: true, paths: 'optional', diff: false, models: { 'openai/gpt-6.1-sol': {} }, default: ['openai/gpt-6.1-sol'] },
  },
})
const CATALOG = [
  { id: 'codex', name: 'Codex', endpoints: { 'cli:codex': 'codex' }, pools: [], offers: [], isHeadless: true },
  { id: 'claude', name: 'Claude', endpoints: { 'cli:claude': 'claude' }, pools: [], offers: [], isHeadless: true },
  { id: 'vectide-go', name: 'Vectide Go', endpoints: { 'cli:custom': 'go' }, pools: [], offers: [], isHeadless: false },
]
const PICKS: Record<string, { provider: string; model: string }> = {
  'openai/gpt-6.1-sol': { provider: 'codex', model: 'gpt-6.1-sol' },
  'anthropic/claude-sonnet-5-5': { provider: 'claude', model: 'claude-sonnet-5-5' },
}

type Asked = { state: 'delivered' | 'cancelled'; text: string; cancelled?: string }

/** The engine and the mods crew calls, in memory; `session` is the id the engine runs under now, `carries` whether a mod carries asks to the person. */
function setup(on: any) {
  const clock = mock.clock(on)
  const world = {
    session: 'A',
    carries: true,
    files: new Map<string, string>(),
    paused: new Map<string, Set<string>>(),
    raises: [] as { session: string; pool: string; usd: number }[],
    asks: new Map<string, Asked>(),
    notices: [] as string[],
    model: 'claude-opus-5-5',
    started: [] as { provider: string; kind: string; model: string; effort?: string; read: unknown; web: boolean }[],
    delivered: [] as string[],
    activity: null as unknown,
    badCrew: false,
    noProviders: false,
    jobFolders: new Map<string, string[]>(),
    listed: [] as unknown[],
    toasts: [] as string[],
    picked: [] as { serves: string; provider?: string; effort?: string }[],
    closed: [] as { gate: string; isClosed: boolean }[],
    switched: [] as boolean[],
    modals: [] as boolean[],
    poolReads: [] as string[],
    subagents: [] as unknown[],
    spend: { topic: 'spend', chat: { turns: 0, usd: 0, isEstimate: false }, agents: {}, groups: {}, keys: {}, pools: {}, by: 'cc-agents' } as unknown,
    prompts: new Map<string, string>(),
    outcome: null as unknown,
    isIdle: true,
    isLimitsOn: true,
    /** Which pools cc-agents holds, by `<session>:<pool>`, and with what notice. */
    holds: new Map<string, string>(),
    holdCalls: 0,
    /** Models cc-providers says can never run. */
    unrunnable: [] as string[],
    /** How many deliveries fail before they go through. */
    deliveriesToFail: 0,
    /** Runs when a job's agent starts: a /clear in the middle of one. */
    atStart: () => {},
  }
  const limitsOf = (session: string) => ({
    isOn: world.isLimitsOn,
    closed: [],
    pools: POOLS.map(pool => ({
      pool,
      name: pool,
      provider: pool,
      isClosed: false,
      reachedAt: world.paused.get(session)?.has(pool) === true ? 1 : null,
      main: { limitUsd: 5, spentUsd: 6, raisedUsd: 0, isOver: true },
      helpers: { limitUsd: null, spentUsd: 0, raisedUsd: 0, isOver: false },
    })),
  })
  const value = (v: unknown) => () => ({ value: v })
  on('session.id', () => ({ value: world.session }))
  on('env.get', value(HOME))
  on('tool.register', value(undefined))
  on('fs.exists', ($: unknown, e: { path: string }) => ({ value: e.path.endsWith('/prompts/job.md') || world.files.has(e.path) || [...world.files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  // the plugin's own crew.json and prompts, wherever the test runs it from
  on('fs.read', ($: unknown, e: { path: string }) => ({ value: world.files.get(e.path) ?? (e.path.endsWith('/crew.json') ? (world.badCrew ? '{' : CREW) : e.path.endsWith('/prompts/job.md') ? 'THE JOB' : undefined) }))
  on('fs.write', ($: unknown, e: { path: string; text: string }) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($: unknown, e: { path: string }) => ({ value: (world.jobFolders.get(e.path) ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  on('agents.list', () => ({ value: world.listed }))
  on('agents.subagents', () => ({ value: world.subagents }))
  on('agents.prompt', ($: unknown, e: { id: string }) => ({ value: { text: world.prompts.get(e.id) ?? null } }))
  on('agents.outcome', () => ({ value: world.outcome }))
  on('agents.isIdle', () => ({ value: { isIdle: world.isIdle } }))
  on('agents.hold', ($: unknown, e: { session: string; pool: string; notice: string }) => {
    world.holdCalls += 1
    world.holds.set(`${e.session}:${e.pool}`, e.notice)
    return { value: undefined }
  })
  on('agents.release', ($: unknown, e: { session: string; pool: string }) => {
    world.holds.delete(`${e.session}:${e.pool}`)
    return { value: undefined }
  })
  on('providers.list', () => {
    if (world.noProviders) throw new Error('providers: not loaded yet; its config is read when the session starts')
    return { value: [] }
  })
  on('providers.catalog', value({ providers: CATALOG, groups: [] }))
  on('providers.sessionProvider', value({ provider: 'claude' }))
  on('session.model', () => ({ value: world.model }))
  on('session.root', value('/home/u/p'))
  on('providers.modelKey', ($: unknown, e: { provider: string; model?: string }) => ({ value: e.provider === 'claude' && e.model?.includes('opus') === true ? 'claude/opus' : `${e.provider}/${e.model}` }))
  on('providers.checkModel', ($: unknown, e: { serves: string }) => ({ value: { problem: world.unrunnable.includes(e.serves) ? `no provider runs ${e.serves} headless` : null } }))
  on('agents.placeable', ($: unknown, e: { serves: string; provider?: string; effort?: string }) => {
    world.picked.push({ serves: e.serves, ...(e.provider === undefined ? {} : { provider: e.provider }), ...(e.effort === undefined ? {} : { effort: e.effort }) })
    return { value: { why: PICKS[e.serves] === undefined ? `zai/${e.serves}: its pool Z has no quota left` : null } }
  })
  on('providers.roots', value({ roots: ['/home/u/p'], files: [] }))
  on('agents.kinds', value({ oneshot: { cacheTtl: '5m' } }))
  on('agents.profiles', value({ 'read-only': { write: false } }))
  on('agents.start', ($: unknown, e: { session: string; serves: string; provider?: string; effort?: string; kind: string; profile: string; prefer: string[]; job: { read: unknown; web: boolean }; group: string; label: string }) => {
    const best = PICKS[e.serves]!
    world.started.push({ provider: e.provider ?? best.provider, kind: e.kind, model: best.model, read: e.job.read, web: e.job.web, ...(e.effort === undefined ? {} : { effort: e.effort }) })
    world.atStart()
    const id = `r${world.started.length}`
    const provider = e.provider ?? best.provider
    return {
      value: { id, session: world.session, group: e.group, label: e.label, serves: e.serves, provider, key: `${provider}/${best.model}`, kind: e.kind, profile: e.profile, job: { ...e.job, dir: `/agents/work/${id}`, write: false, model: best.model }, status: 'running', current: id, attempts: [], spent: {}, followUps: 0, startedAt: 0 },
    }
  })
  on('agents.health', () => ({ value: world.activity }))
  on('agents.ended', ($: unknown, e: unknown) => ({ value: e }))
  on('agents.changed', ($: unknown, e: unknown) => ({ value: e }))
  on('conversation.deliver', ($: unknown, e: { text: string }) => {
    if (world.deliveriesToFail > 0) {
      world.deliveriesToFail -= 1
      throw new Error('no conversation to deliver to')
    }
    world.delivered.push(e.text)
    return { value: undefined }
  })
  on('providers.poolOf', ($: unknown, e: { key: string }) => {
    world.poolReads.push(e.key)
    return { value: { pool: e.key.slice(0, e.key.indexOf('/')), isPlaced: true } }
  })
  on('providers.close', ($: unknown, e: { session: string; gate: string; isClosed: boolean }) => {
    world.closed.push({ gate: e.gate, isClosed: e.isClosed })
    return { value: limitsOf(e.session) }
  })
  on('providers.switchLimits', ($: unknown, e: { session: string; isOff: boolean }) => {
    world.switched.push(e.isOff)
    return { value: limitsOf(e.session) }
  })
  on('sidebar.modal', ($: unknown, e: { isShown: boolean }) => {
    world.modals.push(e.isShown)
    return { value: undefined }
  })
  on('providers.quota', value([]))
  on('providers.limits', ($: unknown, e: { session: string }) => ({ value: limitsOf(e.session) }))
  on('providers.raise', ($: unknown, e: { session: string; pool: string; usd: number }) => {
    world.raises.push({ session: e.session, pool: e.pool, usd: e.usd })
    world.paused.get(e.session)?.delete(e.pool)
    return { value: limitsOf(e.session) }
  })
  on('providers.limitReached', ($: unknown, e: unknown) => ({ value: e }))
  for (const op of ['register', 'badge', 'gauge']) on(`sidebar.${op}`, value(undefined))
  on('sidebar.selected', value(null))
  // a carrier, as cc-courier is: it takes the ask, and closes it when told
  on('bus.ask', ($: unknown, e: { topic: string; key: string; questions: { text: string }[] }) => {
    if (e.topic === 'spend') return { value: { answers: [world.spend] } }
    if (e.topic !== 'person.ask' || !world.carries) return { value: { answers: [] } }
    world.asks.set(e.key, { state: 'delivered', text: e.questions[0]!.text })
    return { value: { answers: [{ topic: 'person.ask', key: e.key, by: 'carrier' }] } }
  })
  on('bus.tell', ($: unknown, e: { topic: string; key: string; reason?: string }) => {
    const ask = world.asks.get(e.key)
    if (e.topic === 'person.close' && ask !== undefined) Object.assign(ask, { state: 'cancelled', cancelled: e.reason })
    return { value: undefined }
  })
  on('conversation.tell', ($: unknown, e: { text: string }) => {
    world.notices.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($: unknown, e: { text?: string }) => {
    world.toasts.push(e.text ?? JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', value(undefined))
  on('session.start', () => ({ cwd: '/home/u/p' }))
  return { clock, world }
}

async function settle(clock: { advance(ms: number): Promise<void> }) {
  for (let i = 0; i < 20; i++) await clock.advance(5)
}

const start = ($: any) => $.session.start({ cwd: '/home/u/p', surface: 'terminal', isInteractive: true })
const reach = ($: any, reached: unknown) => $.command.run({ command: 'crew-test-limit', args: JSON.stringify(reached) })
const tell = ($: any, event: unknown) => $.command.run({ command: 'crew-test-tell', args: JSON.stringify(event) })
/** The person's press, as the carrier tells it; a carrier never answers an ask it closed. */
const press = ($: any, key: string, label: string) => tell($, { topic: 'person.answered', key, answers: { action: { selected: [label] } } })
/** A tool call, which brings crew onto the session the engine runs now. */
const turnEnd = ($: any) => tool($, 'jobs', {})

function pause(world: ReturnType<typeof setup>['world'], session: string, pool: string) {
  if (!world.paused.has(session)) world.paused.set(session, new Set())
  world.paused.get(session)!.add(pool)
  return { session, pool, name: pool, provider: pool, role: 'main', spentUsd: 6, limitUsd: 5, at: world.paused.size * 10 + POOLS.indexOf(pool) }
}

test('after a /clear the ask and a raise belong to the new session', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.session = 'B'
  await turnEnd($)
  await reach($, pause(world, 'B', 'claude'))
  await settle(clock)
  const [key] = [...world.asks.keys()]
  expect(key).toStartWith('crew-limit:B:claude:')
  await press($, key!, '+$1')
  await settle(clock)
  expect(world.raises).toEqual([{ session: 'B', pool: 'claude', usd: 1 }])
})

test('reaching a limit holds the conversation in that pool at once, saying why; a raise past it lets it go', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  expect(world.holds.size).toBe(0)
  await reach($, pause(world, 'A', 'claude'))
  expect(world.holds).toEqual(new Map([['A:claude', 'crew: paused. This conversation went past its limit in the claude pool; it goes on in turns you start or type into, and on its own again once its limit is raised.']]))
  await settle(clock)
  const [key] = [...world.asks.keys()]
  await press($, key!, '+$1')
  await settle(clock)
  expect(world.holds.size).toBe(0)
})

test('a hold cc-agents lost in a reload of its own comes back at the next tick; with nothing held no tick calls it', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  const calls = world.holdCalls
  await clock.advance(3000)
  await settle(clock)
  expect(world.holdCalls).toBe(calls)
  await reach($, pause(world, 'A', 'codex'))
  world.holds.clear()
  await clock.advance(1000)
  await settle(clock)
  expect([...world.holds.keys()]).toEqual(['A:codex'])
})

test('a raise in the tab lets the hold go at once, before any tick', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  await start($)
  await settle(clock)
  await reach($, pause(world, 'A', 'codex'))
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  await ui.drawn({ in: 'crew-overview' })
  world.paused.get('A')!.delete('codex')
  await ui.post({ raise: { pool: 'codex', role: 'main', usd: 1 } })
  expect(world.holds.size).toBe(0)
})

test('a hold follows the limits each tick: limits switched off or a raise elsewhere lets go', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  await reach($, pause(world, 'A', 'codex'))
  world.isLimitsOn = false
  await clock.advance(1000)
  await settle(clock)
  expect(world.holds.size).toBe(0)
  world.isLimitsOn = true
  await clock.advance(1000)
  await settle(clock)
  expect([...world.holds.keys()]).toEqual(['A:codex'])
  world.paused.get('A')!.delete('codex')
  await clock.advance(1000)
  await settle(clock)
  expect(world.holds.size).toBe(0)
})

test('a load finds a pool still past its limit and holds it, as holds live in memory', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  pause(world, 'A', 'claude')
  await start($)
  await settle(clock)
  expect([...world.holds.keys()]).toEqual(['A:claude'])
})

test('a hold stays with the session that reached it; a /clear starts the new one unheld', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await reach($, pause(world, 'A', 'claude'))
  world.session = 'B'
  await turnEnd($)
  expect([...world.holds.keys()]).toEqual(['A:claude'])
  await settle(clock)
})

test('the ask about a pause in the session a /clear ended is closed', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await reach($, pause(world, 'A', 'claude'))
  await settle(clock)
  const [ask] = [...world.asks.values()]
  expect(ask!.state).toBe('delivered')
  world.session = 'B'
  await clock.advance(1000)
  await settle(clock)
  expect(ask!.cancelled).toBe('That conversation ended: a /clear or a resume started another.')
})

test('a second pause replaces the open ask, which is closed; a press after the pause ended raises nothing', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  await reach($, pause(world, 'A', 'claude'))
  await reach($, pause(world, 'A', 'codex'))
  await settle(clock)
  const asks = [...world.asks.entries()]
  expect(asks.map(([, a]) => a.state)).toEqual(['cancelled', 'delivered'])
  expect(asks[0]![1].cancelled).toBe('Replaced by a newer ask.')
  // the tab raised it before the press came
  world.paused.get('A')!.delete('codex')
  await press($, asks[1]![0], '+$10')
  await settle(clock)
  expect(world.raises).toEqual([])
})

test('an answer that comes after a reload of crew is still acted on, by the session and pool its key names', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  pause(world, 'A', 'codex')
  await press($, 'crew-limit:A:codex:5', '+$1')
  await settle(clock)
  expect(world.raises).toEqual([{ session: 'A', pool: 'codex', usd: 1 }])
})

test('a pause nobody carries to the person, or one they never saw, is told in the terminal and the thread', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.carries = false
  await reach($, pause(world, 'A', 'claude'))
  await settle(clock)
  expect(world.notices).toHaveLength(1)
  expect(world.notices[0]).toStartWith('crew: Paused: this conversation spent $6.00 in the claude pool')
  expect(world.toasts).toEqual(world.notices)
  world.carries = true
  await reach($, pause(world, 'A', 'codex'))
  await settle(clock)
  const key = [...world.asks.keys()].find(k => k.includes(':codex:'))!
  await tell($, { topic: 'person.answered', key, closed: 'The thread is not enabled.', wasShown: false })
  await settle(clock)
  expect(world.notices).toHaveLength(2)
  expect(world.notices[1]).toContain('in the codex pool')
})

const tool = ($: any, name: string, input: Record<string, unknown>) => $.tool.call({ tool: `mcp__cc-crew__${name}`, tool_use_id: 't1', ...input })
const review = ($: any, input: Record<string, unknown>) => tool($, 'review', { prompt: 'Look at X.', ...input })
const runOf = (run: Record<string, unknown>, status: unknown) => ({ status, usedModel: 'm', session: 'A', key: 'codex/gpt-6.1-sol', followUps: 0, attempts: [], spent: {}, startedAt: 0, ...run })
const end = ($: any, run: Record<string, unknown>, outcome: Record<string, unknown>) => $.command.run({ command: 'crew-test-ended', args: JSON.stringify({ run: runOf(run, outcome.status), outcome }) })
const changed = ($: any, run: Record<string, unknown>, status: string) => $.command.run({ command: 'crew-test-changed', args: JSON.stringify({ run: runOf(run, status) }) })
const ANSWER = JSON.stringify({ scopes: [{ scope: 'Parser', report: 'Read it.', findings: [{ title: 'Off by one', priority: 1, confidence: 1, body: 'b', evidence: 'e', references: ['a.ts:1'] }], references: [] }], not_read: [] })

test("a call runs the models for the session's model, each with its settings and the provider picked for it; research runs apart, reading nothing unless told", MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  expect(JSON.stringify(await review($, { paths: ['.'] }))).toContain('Started review-1 with 2 agents.')
  expect(world.started).toEqual([
    { provider: 'claude', kind: 'oneshot', model: 'claude-sonnet-5-5', effort: 'high', read: ['.'], web: false },
    { provider: 'codex', kind: 'oneshot', model: 'gpt-6.1-sol', effort: 'medium', read: ['.'], web: false },
  ])
  world.model = 'glm-5.3'
  await review($, { paths: ['src'] })
  expect(world.started.slice(2)).toEqual([{ provider: 'codex', kind: 'oneshot', model: 'gpt-6.1-sol', effort: 'medium', read: ['src'], web: false }])
  expect(JSON.stringify(await tool($, 'research', { prompt: 'What changed in Y?' }))).toContain('Started research-1')
  expect(world.started.slice(3)).toEqual([{ provider: 'codex', kind: 'oneshot', model: 'gpt-6.1-sol', read: 'none', web: true }])
})

test('a call that names models or settings, a review without paths, or a job with nobody to run it is refused, saying what to do', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  expect(JSON.stringify(await review($, { paths: ['.'], model: 'gpt-6.1-sol', web: true }))).toContain('crew: review takes prompt, paths, diff, not model, web; which models run it and how is set in the crew tab and crew.json')
  expect(JSON.stringify(await review($, {}))).toContain('crew: review needs paths: what its agents may read, \\".\\" for the project')
  expect(JSON.stringify(await tool($, 'research', { prompt: 'Y?', diff: 'uncommitted' }))).toContain('research takes prompt, paths, not diff')
  expect(JSON.stringify(await tool($, 'jobs', { all: true }))).toContain('crew: jobs takes nothing, not all"')
  expect(JSON.stringify(await tool($, 'review', { __unparsedToolInput: { raw: '{"paths": a.py}', len: 15 } }))).toContain('your arguments were not valid JSON: {\\"paths\\": a.py}. Send one JSON object')
  expect(JSON.stringify(await tool($, 'report', { id: 'review-1', findings_only: 'true' }))).toContain('findings_only must be true or false')
  expect(JSON.stringify(await review($, { paths: 'a.py' }))).toContain('paths must be a non-empty list of paths, such as [\\".\\"]')
  expect(JSON.stringify(await review($, { paths: [] }))).toContain('paths must be a non-empty list of paths')
  expect(JSON.stringify(await review($, { paths: ['.'], diff: 'all of it' }))).toContain('diff must be \\"uncommitted\\", { base } or { commit }')
  expect(world.started).toEqual([])
})

test('a model nobody can run now is left out and the person told; with none left the call is refused, saying why', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  const record = `${RECORDS}/A.json`
  world.files.set(record, JSON.stringify({ jobs: { review: { ticked: ['zhipu/glm-5.3', 'openai/gpt-6.1-sol'] } } }))
  world.session = 'B'
  await turnEnd($)
  world.session = 'A'
  await turnEnd($)
  expect(JSON.stringify(await review($, { paths: ['.'] }))).toContain('Started review-1 with 1 agent.')
  expect(world.notices.at(-1)).toBe('crew: zhipu/glm-5.3: review-1 runs without it: zai/zhipu/glm-5.3: its pool Z has no quota left')
  world.files.set(record, JSON.stringify({ jobs: { review: { ticked: ['zhipu/glm-5.3'] } } }))
  world.session = 'B'
  await turnEnd($)
  world.session = 'A'
  await turnEnd($)
  expect(JSON.stringify(await review($, { paths: ['.'] }))).toContain('no model can run review now: zhipu/glm-5.3: zai/zhipu/glm-5.3: its pool Z has no quota left')
})

test('a refusal the caller can do nothing about says so, under one crew: prefix', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  world.files.set(`${RECORDS}/A.json`, JSON.stringify({ jobs: { review: { ticked: [] } } }))
  world.session = 'B'
  await turnEnd($)
  world.session = 'A'
  await turnEnd($)
  const none = JSON.stringify(await review($, { paths: ['.'] }))
  expect(none).toContain('no model is ticked for review in the crew tab. The call was fine: this is how crew is set up, so tell the person.')
  expect(none).not.toContain('crew: crew:')
})

test('a broken crew file costs the jobs, not crew: the person is told, jobs says why, the tab still draws', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  world.badCrew = true
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  await start($)
  await settle(clock)
  expect(world.notices.at(-1)).toContain('crew has no jobs:')
  expect(world.notices.at(-1)).toContain('not JSON')
  expect(world.notices.at(-1)).not.toContain('crew: crew:')
  const listed = JSON.stringify(await tool($, 'jobs', {}))
  expect(listed).toContain('Crew has no jobs:')
  expect(listed).toContain('tell the person')
  expect(JSON.stringify(await review($, { paths: ['.'] }))).toContain('tell the person')
  expect(world.toasts.at(-1)).toContain('crew has no jobs:')
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  await ui.post({ tab: 'jobs' })
  expect(JSON.stringify(await ui.drawn({ in: 'crew-overview' }))).toContain('not JSON')
  expect(world.started).toEqual([])
})

test('cc-providers not answering at the start is told, and jobs says crew did not start', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  world.noProviders = true
  await start($)
  await settle(clock)
  expect(world.notices.at(-1)).toContain('crew did not start:')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('crew did not start')
})

test('the check of the jobs tells the person once, a while after the start, of what does not line up', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  const before = world.notices.length
  world.unrunnable = ['openai/gpt-6.1-sol']
  await clock.advance(30_000)
  await settle(clock)
  expect(world.notices.slice(before)).toEqual(['crew: crew\'s jobs need fixing in crew.json: review: no provider runs openai/gpt-6.1-sol headless; research: no provider runs openai/gpt-6.1-sol headless'])
  await clock.advance(30_000)
  await settle(clock)
  expect(world.notices).toHaveLength(before + 1)
})

test('a job that ended while crew was reloading is told at the next load, once', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  const job = { id: 'review-1', job: 'review', title: 'X', createdAt: 0, session: 'A', dir: `${HOME}/crew/A/review-1`, roots: [], agents: [{ serves: 'v/m', web: false, helpers: false, timeoutMs: 1, pokeMs: 1, stallMs: 1, label: 'A', agent: 'r9' }], skipped: [], isAcked: false }
  world.files.set(job.dir + '/job.json', JSON.stringify(job))
  world.jobFolders.set(`${HOME}/crew/A`, ['review-1'])
  world.listed = [{ id: 'r9', status: 'stopped', session: 'A', group: 'A/review-1', label: 'A', key: 'codex/m', provider: 'codex', followUps: 0, attempts: [], spent: {}, startedAt: 0 }]
  world.outcome = { status: 'stopped', text: '', model: 'm' }
  await start($)
  await settle(clock)
  expect(world.delivered).toHaveLength(1)
  expect(world.delivered[0]).toContain('review-1 "X" finished')
  expect(world.delivered[0]).toContain('agent A: STOPPED')
  await turnEnd($)
  await settle(clock)
  expect(world.delivered).toHaveLength(1)
})

test('the end of a job arrives as a message, the jobs tool lists it until a full report read acks it, and the report names no model', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('review-1 running 0m \\"Look at X.\\"')
  await end($, { id: 'r1', group: 'A/review-1', label: 'A', provider: 'codex' }, { status: 'ok', text: ANSWER, model: 'gpt-6.1-sol' })
  await settle(clock)
  expect(world.delivered).toHaveLength(1)
  expect(world.delivered[0]).toContain('review-1 "Look at X." finished: 1 findings in Parser (1).')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('review-1 done, unread')
  const findings = JSON.stringify(await tool($, 'report', { id: 'review-1', findings_only: true }))
  expect(findings).toContain('[P1] Off by one')
  expect(findings).not.toContain('gpt')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('review-1 done, unread')
  expect(JSON.stringify(await tool($, 'report', { id: 'review-1' }))).toContain('Read it.')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('Nothing runs and nothing is unread.')
  expect(JSON.stringify(await tool($, 'report', { id: 'review-9' }))).toContain('crew: no job review-9')
})

test('a stalled agent wakes the conversation only once it is idle, saying what the agent is on; stop reaches the agent named', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  const stopped: unknown[] = []
  on('agents.stop', ($$: unknown, e: unknown) => {
    stopped.push(e)
    return { value: { isStopping: true } }
  })
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  world.activity = { state: 'stalled', on: { tool: 'WebFetch', target: 'https://x.invalid' }, forMs: 11 * 60_000, mark: 'open:1' }
  world.isIdle = false
  await clock.advance(11 * 60_000)
  await settle(clock)
  expect(world.delivered).toEqual([])
  world.isIdle = true
  await clock.advance(60_000)
  await settle(clock)
  expect(world.delivered).toHaveLength(1)
  expect(world.delivered[0]).toContain('agent A: waiting on WebFetch https://x.invalid for')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('waiting on WebFetch')
  expect(JSON.stringify(await tool($, 'stop', { id: 'review-1', agent: 'A' }))).toContain('Stopping 1 agent')
  expect(stopped).toEqual([{ id: 'r1' }])
})

test('ticks and pokes in the tab hold for the session, surviving a reload through its record', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  await ui.post({ tick: { job: 'review', model: 'anthropic/claude-sonnet-5-5' } })
  await ui.post({ tick: { job: 'review', model: 'openai/gpt-6.1-sol' } })
  await ui.post({ poke: { job: 'review', model: 'anthropic/claude-sonnet-5-5', by: 5 } })
  await ui.post({ tick: { job: 'nothing', model: 'x' } })
  expect(JSON.parse(world.files.get(`${RECORDS}/A.json`)!).jobs).toEqual({ review: { ticked: ['anthropic/claude-sonnet-5-5'], pokeMin: { 'anthropic/claude-sonnet-5-5': 25 } } })
  // leaving the session and coming back reads them from its record, as a load does
  world.session = 'B'
  await turnEnd($)
  world.session = 'A'
  await turnEnd($)
  await review($, { paths: ['.'] })
  expect(world.started.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
})

test("a model's provider pin and effort reach cc-agents, from a machine's crew file over the shipped one", MODS, async ($, on) => {
  const { clock, world } = setup(on)
  world.files.set(`${HOME}/.config/crew/crew.json`, JSON.stringify({ jobs: { research: { models: { 'openai/gpt-6.1-sol': { provider: 'codex', effort: 'high' } } } } }))
  await start($)
  await settle(clock)
  await tool($, 'research', { prompt: 'Y?' })
  expect(world.picked).toEqual([{ serves: 'openai/gpt-6.1-sol', provider: 'codex', effort: 'high' }])
  expect(world.started[0]).toMatchObject({ provider: 'codex', effort: 'high' })
})

test("the tab draws Claude's agents and the chat as cc-agents holds them, and an agent's pop-out reads its prompt from it", MODS, async ($, on) => {
  const { clock, world } = setup(on)
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  await start($)
  await settle(clock)
  world.subagents = [{ id: 'sub1', session: 'A', type: 'Explore', description: 'Look around', key: 'codex/gpt-6.1-sol', startedAt: 0, status: 'running', isLive: true, spent: { 'codex/gpt-6.1-sol': { tokens: { in: 2000, cached: 0, out: 500 }, usd: 0.25, isEstimate: false } } }]
  world.spend = { topic: 'spend', chat: { turns: 3, tokens: { in: 9000, cached: 1000, out: 800 }, usd: 1.5, isEstimate: false }, agents: {}, groups: {}, keys: {}, pools: {}, by: 'cc-agents' }
  world.prompts.set('sub1', 'Find X')
  await clock.advance(1000)
  await settle(clock)
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  const drawn = JSON.stringify(await ui.drawn({ in: 'crew-overview' }))
  expect(drawn).toContain('Look around')
  await ui.post({ tab: 'usage' })
  const usage = JSON.stringify(await ui.drawn({ in: 'crew-overview' }))
  expect(usage).toContain('3 turns')
  expect(usage).toContain('$1.50')
  await ui.post({ open: { agent: 'sub1' } })
  expect(world.modals).toEqual([true])
})

test('a run moved by anyone reaches the job through changed: a follow-up cc-agents started reads as running again', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  const run = { id: 'r1', group: 'A/review-1', label: 'A', provider: 'codex' }
  await end($, run, { status: 'ok', text: ANSWER, model: 'gpt-6.1-sol' })
  await settle(clock)
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('review-1 done, unread')
  await changed($, { ...run, followUps: 1, current: 'r1.f1' }, 'running')
  expect(JSON.stringify(await tool($, 'jobs', {}))).toContain('review-1 running')
})

test('the drawer reads each model\'s pool from providers once, until the catalog is read again', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  await ui.post({ tab: 'usage' })
  await ui.post({ tab: 'running' })
  expect(world.poolReads).toEqual(['codex/gpt-6.1-sol'])
  await clock.advance(30_000)
  await settle(clock)
  await ui.post({ tab: 'usage' })
  expect(world.poolReads).toEqual(['codex/gpt-6.1-sol', 'codex/gpt-6.1-sol'])
})

test("the tab's presses reach providers and the agents: limits, raises, gates of what runs headless, a job's stop and its pop-out", MODS, async ($, on) => {
  const { clock, world } = setup(on)
  const stopped: unknown[] = []
  on('agents.stop', ($$: unknown, e: unknown) => {
    stopped.push(e)
    return { value: { isStopping: true } }
  })
  on('sidebar.room', () => ({ value: { drawer: 30, popout: 0, drawerFrameColumns: 4, modal: { rows: 30, columns: 80 } } }))
  on('ui.render', { component: 'InfoNotice' }, ($$: any, e: unknown) => $$.ui.resolve(e).Box({ key: 'sidebar-drawer:crew' }))
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  const ui = await ($ as any).ui.mount({ plugin: 'cc-crew', surface: 'terminal', component: 'InfoNotice', props: { command: null, text: '' }, viewport: { columns: 80, rows: 30, isDocked: false } })
  await ui.post({ switchLimits: true })
  expect(world.switched).toEqual([true])
  await ui.post({ raise: { pool: 'codex', role: 'helpers', usd: 1 } })
  await ui.post({ raise: { pool: 'codex', role: 'helpers', usd: 7 } })
  expect(world.raises).toEqual([{ session: 'A', pool: 'codex', usd: 1 }])
  await ui.post({ toggle: 'codex' })
  await ui.post({ toggle: 'vectide-go' })
  expect(world.closed).toEqual([{ gate: 'codex', isClosed: true }])
  await ui.post({ open: { run: 'review-1' } })
  await ui.post({ open: { run: 'review-1' } })
  expect(world.modals).toEqual([true, false])
  await ui.post({ stop: { run: 'review-1' } })
  expect(stopped).toEqual([{ id: 'r1' }])
})

test('stop says when nothing of the job ran, and when nothing here can reach an agent that reads as running', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  on('agents.stop', () => ({ value: { isStopping: false } }))
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  expect(JSON.stringify(await tool($, 'stop', { id: 'review-1' }))).toContain('1 agent reads as running with nothing here to stop')
  await end($, { id: 'r1', group: 'A/review-1', label: 'A', provider: 'codex' }, { status: 'ok', text: ANSWER, model: 'gpt-6.1-sol' })
  await settle(clock)
  expect(JSON.stringify(await tool($, 'stop', { id: 'review-1' }))).toContain('Nothing of it was running.')
})

test('a finish message that failed is tried again at the next read of the agents, a busy conversation included, and its failure shown once', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  await review($, { paths: ['.'] })
  world.deliveriesToFail = 2
  world.isIdle = false
  await end($, { id: 'r1', group: 'A/review-1', label: 'A', provider: 'codex' }, { status: 'ok', text: ANSWER, model: 'gpt-6.1-sol' })
  await settle(clock)
  expect(world.delivered).toEqual([])
  await clock.advance(60_000)
  await settle(clock)
  expect(world.delivered).toEqual([])
  await clock.advance(60_000)
  await settle(clock)
  expect(world.delivered).toHaveLength(1)
  expect(world.toasts.filter(t => t.includes('telling the end of review-1 failed'))).toHaveLength(1)
})

test('a /clear during a start answers an id the new conversation can read', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.model = 'glm-5.3'
  world.atStart = () => {
    world.session = 'B'
  }
  expect(JSON.stringify(await review($, { paths: ['.'] }))).toContain('Started A/review-1 with 1 agent. A message says when it finished; read it with report { id: \\"A/review-1\\" }.')
})
