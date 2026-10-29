import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const RECORDS = `${HOME}/.cache/crew/sessions`
const POOLS = ['claude', 'codex']

/**
 * Puts up the nouns of the mods crew calls, so the test's hooks beneath answer their calls; `crew-test-limit` raises
 * `providers.limitReached` as cc-providers does. An inline plugin sees nothing of this file, so it is all literals.
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
        courier: noun(['ask', 'deliver', 'wait', 'cancel']),
        conversation: noun(['tell', 'deliver']),
      }
    })
    on('command.run', { command: 'crew-test-limit' }, async ($: any, e: { args: string }) => {
      await $.providers.limitReached(JSON.parse(e.args))
      return { text: '' }
    })
  },
}
const MODS = { plugins: [mods] }

type Shown ={ state: string; answers: Record<string, { selected: string[] }> }
type Asked = { thread: string; state: string; cancelled?: string; waiter?: (v: Shown) => void }

/** The engine and the mods crew calls, in memory; `session` is the id the engine runs under now. */
function setup(on: any) {
  const clock = mock.clock(on)
  const world = {
    session: 'A',
    files: new Map<string, string>(),
    paused: new Map<string, Set<string>>(),
    raises: [] as { session: string; pool: string; usd: number }[],
    asks: new Map<string, Asked>(),
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
  on('courier.ask', ($: unknown, e: { key: string; thread: string }) => {
    world.asks.set(e.key, { thread: e.thread, state: 'held' })
    return { value: { state: 'held', answers: {} } }
  })
  on('courier.deliver', ($: unknown, e: { key: string }) => {
    world.asks.get(e.key)!.state = 'delivered'
    return { value: { state: 'delivered', answers: {} } }
  })
  on('courier.wait', async ($: unknown, e: { key: string }) => {
    const ask = world.asks.get(e.key)!
    if (ask.state !== 'delivered') return { value: { state: ask.state, answers: {} } }
    return { value: await new Promise<Shown>(resolve => (ask.waiter = resolve)) }
  })
  on('courier.cancel', ($: unknown, e: { key: string; reason: string }) => {
    const ask = world.asks.get(e.key)!
    ask.state = 'cancelled'
    ask.cancelled = e.reason
    ask.waiter?.({ state: 'cancelled', answers: {} })
    return { value: undefined }
  })
  on('conversation.tell', value(undefined))
  on('ui.toast', value(undefined))
  on('ui.log', value(undefined))
  on('session.start', () => ({ cwd: '/home/u/p' }))
  on('turn.complete', () => ({ text: '' }))
  const press = (key: string, label: string) => {
    const ask = world.asks.get(key)!
    ask.state = 'answered'
    ask.waiter?.({ state: 'answered', answers: { action: { selected: [label] } } })
  }
  return { clock, world, press }
}

async function settle(clock: { advance(ms: number): Promise<void> }) {
  for (let i = 0; i < 20; i++) await clock.advance(5)
}

const start = ($: any) => $.session.start({ cwd: '/home/u/p', surface: 'terminal', isInteractive: true })
const reach = ($: any, reached: unknown) => $.command.run({ command: 'crew-test-limit', args: JSON.stringify(reached) })
const turnEnd = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

function pause(world: ReturnType<typeof setup>['world'], session: string, pool: string) {
  if (!world.paused.has(session)) world.paused.set(session, new Set())
  world.paused.get(session)!.add(pool)
  return { session, pool, name: pool, provider: pool, role: 'main', spentUsd: 6, limitUsd: 5, at: world.paused.size * 10 + POOLS.indexOf(pool) }
}

test('after a /clear the turns, the Telegram thread and a raise belong to the new session', MODS, async ($, on) => {
  const { clock, world, press } = setup(on)
  await start($)
  await settle(clock)
  world.session = 'B'
  await turnEnd($)
  expect(JSON.parse(world.files.get(`${RECORDS}/B.json`)!).turns).toBe(1)
  expect(world.files.has(`${RECORDS}/A.json`)).toBe(false)
  await reach($, pause(world, 'B', 'claude'))
  await settle(clock)
  const [key, ask] = [...world.asks.entries()][0]!
  expect(ask.thread).toBe('cc:B')
  press(key, '+$1')
  await settle(clock)
  expect(world.raises).toEqual([{ session: 'B', pool: 'claude', usd: 1 }])
})

test('the ask about a pause in the session a /clear ended is cancelled, and a press on it raises nothing', MODS, async ($, on) => {
  const { clock, world, press } = setup(on)
  await start($)
  await reach($, pause(world, 'A', 'claude'))
  await settle(clock)
  const [key, ask] = [...world.asks.entries()][0]!
  expect(ask.state).toBe('delivered')
  world.session = 'B'
  await clock.advance(1000)
  await settle(clock)
  expect(ask.cancelled).toBe('That conversation ended: a /clear or a resume started another.')
  press(key, '+$1')
  await settle(clock)
  expect(world.raises).toEqual([])
})

test('a second pause replaces the open ask, which is cancelled; a press after the pause ended raises nothing', MODS, async ($, on) => {
  const { clock, world, press } = setup(on)
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
  press(asks[1]![0], '+$10')
  await settle(clock)
  expect(world.raises).toEqual([])
})
