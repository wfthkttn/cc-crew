import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const RECORDS = `${HOME}/.cache/crew/sessions`
const POOLS = ['claude', 'codex']

/**
 * Puts up the nouns of the mods crew calls, so the test's hooks beneath answer their calls; `crew-test-limit` raises
 * `providers.limitReached` as cc-providers does, `crew-test-tell` tells on the bus as a carrier does. An inline plugin
 * sees nothing of this file, so it is all literals.
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
        providers: noun(['list', 'catalog', 'sessionProvider', 'limits', 'quota', 'raise', 'switchLimits', 'close', 'limitReached', 'modelKey', 'refusal', 'roots', 'secretPaths', 'cost']),
        agents: noun(['start', 'followUp', 'stop', 'get', 'list', 'ended']),
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
  },
}
const MODS = { plugins: [mods] }

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
  }
  const limitsOf = (session: string) => ({
    isOn: true,
    closed: [],
    pools: POOLS.map(pool => ({
      pool,
      name: pool,
      provider: pool,
      isClosed: false,
      pausedAt: world.paused.get(session)?.has(pool) === true ? 1 : null,
      main: { limitUsd: 5, spentUsd: 6, raisedUsd: 0, isOver: true },
      helpers: { limitUsd: null, spentUsd: 0, raisedUsd: 0, isOver: false },
    })),
  })
  const value = (v: unknown) => () => ({ value: v })
  on('session.id', () => ({ value: world.session }))
  on('env.get', value(HOME))
  on('tool.register', value(undefined))
  on('fs.exists', ($: unknown, e: { path: string }) => ({ value: world.files.has(e.path) || [...world.files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', ($: unknown, e: { path: string }) => ({ value: world.files.get(e.path) }))
  on('fs.write', ($: unknown, e: { path: string; text: string }) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', value([]))
  on('agent.list', value([]))
  on('agents.list', value([]))
  on('providers.list', value([]))
  on('providers.catalog', value({ providers: [], groups: [] }))
  on('providers.sessionProvider', value({ provider: 'claude' }))
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
  on('ui.toast', value(undefined))
  on('ui.log', value(undefined))
  on('session.start', () => ({ cwd: '/home/u/p' }))
  on('turn.complete', () => ({ text: '' }))
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
const turnEnd = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

function pause(world: ReturnType<typeof setup>['world'], session: string, pool: string) {
  if (!world.paused.has(session)) world.paused.set(session, new Set())
  world.paused.get(session)!.add(pool)
  return { session, pool, name: pool, provider: pool, role: 'main', spentUsd: 6, limitUsd: 5, at: world.paused.size * 10 + POOLS.indexOf(pool) }
}

test('after a /clear the turns, the ask and a raise belong to the new session', MODS, async ($, on) => {
  const { clock, world } = setup(on)
  await start($)
  await settle(clock)
  world.session = 'B'
  await turnEnd($)
  expect(JSON.parse(world.files.get(`${RECORDS}/B.json`)!).turns).toBe(1)
  expect(world.files.has(`${RECORDS}/A.json`)).toBe(false)
  await reach($, pause(world, 'B', 'claude'))
  await settle(clock)
  const [key] = [...world.asks.keys()]
  expect(key).toStartWith('crew-limit:B:claude:')
  await press($, key!, '+$1')
  await settle(clock)
  expect(world.raises).toEqual([{ session: 'B', pool: 'claude', usd: 1 }])
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
  world.carries = true
  await reach($, pause(world, 'A', 'codex'))
  await settle(clock)
  const key = [...world.asks.keys()].find(k => k.includes(':codex:'))!
  await tell($, { topic: 'person.answered', key, closed: 'The thread is not enabled.', wasShown: false })
  await settle(clock)
  expect(world.notices).toHaveLength(2)
  expect(world.notices[1]).toContain('in the codex pool')
})
