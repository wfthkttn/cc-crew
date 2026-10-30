import type { SidebarGaugeColumn } from 'cc-sidebar'
import type { ProvidersInfo, ProvidersQuotaSlot, ProvidersWindowReading } from 'cc-providers'

import type { QuotaBlock, QuotaProps } from './overview-props.ts'
import { clockText } from './jobs.ts'

/** A provider's quota as `$.providers.quota` answered it last. */
export type QuotaView = { info: ProvidersInfo; slots: ProvidersQuotaSlot[] }

/** Each provider's bars, its brand color and a darker shade of it; others draw gray. */
const LOOKS: Record<string, { letter: string; colors: [string, string] }> = {
  claude: { letter: 'C', colors: ['#d97757', '#8f4a35'] },
  codex: { letter: 'O', colors: ['#10a37f', '#0a6650'] },
  antigravity: { letter: 'G', colors: ['#4796e3', '#2c5d8f'] },
}
const OTHER: [string, string] = ['#9ca3af', '#6b7280']

const lookOf = (info: ProvidersInfo) => LOOKS[info.id] ?? { letter: info.name.slice(0, 1).toUpperCase(), colors: OTHER }

/** The rail holds this many gauge columns. */
const GAUGE_COLUMNS = 3

/** A reading this old draws dim: providers reads again after 5 minutes, so reads have been failing. */
const STALE_MS = 15 * 60_000

const left = (w: ProvidersWindowReading | undefined) => (w === undefined || w.percentUsed === null ? null : Math.max(0, Math.min(100, 100 - w.percentUsed)))

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `19:54` within the next day, the weekday after that. */
function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '?'
  return resetsAt - now >= 24 * 3600_000 ? WEEKDAYS[new Date(resetsAt).getDay()]! : clockText(resetsAt)
}

/** The pools a provider's slots read, in the provider's order, each with its windows. */
function readPools(v: QuotaView): { id: string; name: string; windows: ProvidersWindowReading[] }[] {
  const read = v.slots.flatMap(s => s.reading?.pools ?? [])
  return v.info.pools.flatMap(p => {
    const found = read.find(r => r.pool === p.id)
    return found === undefined ? [] : [{ id: p.id, name: p.name, windows: found.windows }]
  })
}

function isStale(v: QuotaView, now: number): boolean {
  const read = v.slots.filter(s => s.source !== 'none')
  return read.every(s => s.reading === null) || read.some(s => s.error !== null || (s.reading !== null && now - s.reading.readAt > STALE_MS))
}

/**
 * One column per provider that has a quota source, the first three: its one pool's first and second window (the short
 * one first), or, for several pools, its first two pools as a pair each.
 */
export function gaugeColumns(views: readonly QuotaView[], now: number): SidebarGaugeColumn[] {
  return views
    .filter(v => v.slots.some(s => s.source !== 'none'))
    .slice(0, GAUGE_COLUMNS)
    .map(v => {
      const pools = readPools(v)
      const { letter, colors } = lookOf(v.info)
      const values: SidebarGaugeColumn['values'] =
        pools.length <= 1
          ? [left(pools[0]?.windows[0]), left(pools[0]?.windows[1])]
          : [[left(pools[0]!.windows[0]), left(pools[0]!.windows[1])], [left(pools[1]!.windows[0]), left(pools[1]!.windows[1])]]
      return { letter, colors, values, isDim: isStale(v, now) }
    })
}

/** Each provider with a quota source: every window of every pool it read, then why the rest are missing. */
export function quotaProps(views: readonly QuotaView[], now: number): QuotaProps {
  const blocks = views
    .filter(v => v.slots.some(s => s.source !== 'none'))
    .map((v): QuotaBlock => {
      const plan = v.slots.find(s => s.reading?.plan !== null && s.reading?.plan !== undefined)?.reading?.plan
      const rows = readPools(v).flatMap(p =>
        p.windows.map((w, i) => {
          const l = left(w)
          return { pool: i === 0 ? p.name : '', window: w.name, left: l === null ? `${w.used}` : `${Math.round(l)}%`, resets: resetText(w.resetsAt, now), isLow: l !== null && l <= 10 }
        }),
      )
      const notes = v.slots.flatMap(s => {
        const estimate = s.reading?.isEstimate === true && s.reading.basis !== undefined ? [`estimate: ${s.reading.basis}`] : []
        return [...(s.error === null ? [] : [s.error]), ...estimate]
      })
      return { title: plan === undefined ? v.info.name : `${v.info.name} ${plan}`, color: lookOf(v.info).colors[0], rows, notes }
    })
  return { blocks }
}
