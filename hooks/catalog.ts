import { DEFAULT_MODEL } from './claude.ts'
import type { Provider } from './config.ts'
import type { Io } from './io.ts'
import type { Tokens } from './usage.ts'

/** API prices in $ per 1M tokens; `written` is a cache write, 0 where the vendor charges none. */
export type Price = { in: number; cached: number; written: number; out: number }

/** Models that share one quota; a limit is the group's, in $ at API prices. */
export type Group = { id: string; name: string; provider: Provider; models: string[]; limitUsd?: number }

/**
 * What crew knows of the models: the groups each vendor's quota counts together, aliases (`codex/default` → the model
 * Codex runs by default) and prices. Models are keyed `<provider>/<model>`: Claude by family (`claude/opus`),
 * Antigravity without the effort its ids end in (`antigravity/gemini-4-argon`).
 */
export type Catalog = { groups: Group[]; aliases: Record<string, string>; prices: Record<string, Price> }

/** The shape of `models.json`, crew's and the person's: groups by id, aliases, prices. */
type CatalogFile = {
  groups?: Record<string, Omit<Group, 'id'>>
  aliases?: Record<string, string>
  prices?: Record<string, Price>
}

/** The person's file over crew's: a group, alias or price there replaces crew's of the same name. */
export function mergeCatalog(shipped: CatalogFile, own: CatalogFile | null): Catalog {
  const groups = { ...shipped.groups, ...own?.groups }
  return {
    groups: Object.entries(groups).map(([id, g]) => ({ id, ...g })),
    aliases: { ...shipped.aliases, ...own?.aliases },
    prices: { ...shipped.prices, ...own?.prices },
  }
}

export function parseCatalog(text: string, path: string): CatalogFile {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch (err) {
    throw new Error(`crew: ${path} is not JSON: ${String(err)}`)
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Error(`crew: ${path} must hold an object with groups, aliases and prices`)
  return file as CatalogFile
}

/** crew's `models.json` beside its plugin.json, with `~/.config/crew/models.json` over it when the person keeps one. */
export async function loadCatalog(io: Io, pluginRoot: string, home: string): Promise<Catalog> {
  const shippedPath = `${pluginRoot}/models.json`
  const ownPath = `${home}/.config/crew/models.json`
  const shipped = parseCatalog(await io.read(shippedPath), shippedPath)
  const own = (await io.exists(ownPath)) ? parseCatalog(await io.read(ownPath), ownPath) : null
  return mergeCatalog(shipped, own)
}

/**
 * Asks Codex's app-server for its models and its rate limits, holding its stdin open until both answers are out: the
 * server drops answers it has not written by the time its stdin closes.
 */
const CODEX_SCRIPT = [
  'coproc C { exec "$1" app-server; }',
  `printf '%s\\n' '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"crew","version":"0.1.0"}}}' '{"method":"initialized"}' '{"method":"model/list","id":1,"params":{}}' '{"method":"account/rateLimits/read","id":2}' >&"\${C[1]}"`,
  'seen=0',
  'while IFS= read -r line <&"${C[0]}"; do',
  // an answer may name its id after its result or error
  `  case $line in '{"id":1,'*|*',"id":1}'|'{"id":2,'*|*',"id":2}') printf '%s\\n' "$line"; seen=$((seen + 1)); [ $seen -eq 2 ] && break ;; esac`,
  'done',
  'kill "$C_PID" 2>/dev/null',
].join('\n')

/** `bash`: the bash to run the script with, Git Bash's on Windows. */
export async function readCodexCatalog(io: Io, bin: string, bash: string): Promise<CodexCatalog> {
  const run = await io.run([bash, '-c', CODEX_SCRIPT, 'crew', bin], { timeoutMs: 20_000 })
  const lines = run.stdout.split('\n').flatMap(l => {
    if (!l.startsWith('{')) return []
    try {
      return [JSON.parse(l) as { id?: unknown; result?: unknown; error?: { message?: string } }]
    } catch {
      return []
    }
  })
  const answer = (id: number) => {
    const parsed = lines.find(l => l.id === id)
    if (parsed === undefined) throw new Error(`no answer ${id} from codex app-server (exit ${run.exitCode}): ${run.stderr.trim().slice(-200)}`)
    if (parsed.error !== undefined) throw new Error(`codex app-server: ${parsed.error.message ?? JSON.stringify(parsed.error)}`)
    return parsed.result
  }
  const models = answer(1) as { data: { id: string; isDefault?: boolean; hidden?: boolean }[] }
  const limits = answer(2) as { rateLimitsByLimitId?: Record<string, { limitId: string; limitName: string | null; normalModelSlug: string | null }> }
  if (limits.rateLimitsByLimitId === undefined) throw new Error('codex app-server answered its rate limits without rateLimitsByLimitId')
  return {
    models: models.data.filter(m => m.hidden !== true).map(m => ({ id: m.id, isDefault: m.isDefault === true })),
    limits: Object.values(limits.rateLimitsByLimitId).map(l => ({ id: l.limitId, name: l.limitName, model: l.normalModelSlug })),
  }
}

/** Codex's own answer: its models, the one it runs by default, and the limits it counts apart. */
export type CodexCatalog = {
  models: { id: string; isDefault: boolean }[]
  /** A limit that names a model (`normalModelSlug`) is that model's own pool. */
  limits: { id: string; name: string | null; model: string | null }[]
}

/** Codex's models join its main group, a model with a limit of its own gets a group, and `codex/default` names its default. */
export function withCodex(catalog: Catalog, codex: CodexCatalog): Catalog {
  const own = codex.limits.filter(l => l.model !== null)
  const ownModels = new Set(own.map(l => l.model!))
  const main = catalog.groups.find(g => g.provider === 'codex')
  if (main === undefined) throw new Error('crew: models.json has no codex group for Codex models to join')
  const groups = catalog.groups.map(g =>
    g === main ? { ...g, models: [...new Set([...g.models, ...codex.models.map(m => m.id).filter(id => !ownModels.has(id))])] } : g,
  )
  const added = own.map(l => ({ id: `codex-${l.id}`, name: l.name ?? l.id, provider: 'codex' as const, models: [l.model!] }))
  const byDefault = codex.models.find(m => m.isDefault)
  return {
    ...catalog,
    groups: [...groups, ...added.filter(a => !groups.some(g => g.id === a.id))],
    aliases: byDefault === undefined ? catalog.aliases : { ...catalog.aliases, 'codex/default': `codex/${byDefault.id}` },
  }
}

const EFFORT_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/
const CLAUDE_FAMILY = /(opus|sonnet|haiku|fable)/

/** The model a reviewer or agent ran, keyed as the catalog keys it, aliases followed. */
export function modelKey(catalog: Catalog, provider: Provider, model: string | undefined): string {
  let key: string
  if (provider === 'claude' || provider === 'claude-p') {
    const m = model ?? DEFAULT_MODEL
    key = `claude/${CLAUDE_FAMILY.exec(m)?.[1] ?? m}`
  } else {
    key = `${provider}/${(model ?? 'default').replace(EFFORT_SUFFIX, '')}`
  }
  return catalog.aliases[key] ?? key
}

const providerOf = (key: string) => key.slice(0, key.indexOf('/'))
const nameOf = (key: string) => key.slice(key.indexOf('/') + 1)

/** The group a model counts in; `isPlaced` false when no group lists it and it fell into its vendor's first group. */
export function groupOf(catalog: Catalog, key: string): { group: Group; isPlaced: boolean } {
  const provider = providerOf(key)
  const listed = catalog.groups.find(g => g.provider === provider && g.models.includes(nameOf(key)))
  if (listed !== undefined) return { group: listed, isPlaced: true }
  const main = catalog.groups.find(g => g.provider === provider)
  if (main === undefined) throw new Error(`crew: models.json has no group for ${provider}, where ${key} would count`)
  return { group: main, isPlaced: false }
}

/** The model's prices; `isPriced` false when it has none and counts at the dearest of its group's, so never under. */
export function priceOf(catalog: Catalog, key: string): { price: Price; isPriced: boolean } {
  const own = catalog.prices[key]
  if (own !== undefined) return { price: own, isPriced: true }
  const { group } = groupOf(catalog, key)
  const known = Object.entries(catalog.prices).flatMap(([k, p]) => (groupOf(catalog, k).group.id === group.id ? [p] : []))
  if (known.length === 0) throw new Error(`crew: no price for ${key} or any model of its group ${group.name}; add one to models.json`)
  const dearest = (f: keyof Price) => Math.max(...known.map(p => p[f]))
  return { price: { in: dearest('in'), cached: dearest('cached'), written: dearest('written'), out: dearest('out') }, isPriced: false }
}

/** What tokens cost at `price`, in $: new input, cache reads, cache writes and output each at their own rate. */
export function costOf(t: Tokens | undefined, price: Price): number {
  if (t === undefined) return 0
  const written = t.written ?? 0
  return ((t.in - t.cached - written) * price.in + t.cached * price.cached + written * price.written + t.out * price.out) / 1_000_000
}
