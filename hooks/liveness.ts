import type { AgentsActivity } from 'cc-agents'

/** What crew makes of a running agent's activity. `mark` names the stall, so one stall is told once. */
export type Reading = { text: string; isStalled: boolean; mark: string }

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`

/** A run already gone from cc-providers has no activity: its end is on its way. */
export function readingOf(activity: AgentsActivity | null, stallMs: number, now: number): Reading {
  if (activity === null) return { text: 'ending', isStalled: false, mark: '' }
  const oldest = [...activity.open].sort((a, b) => a.since - b.since)[0]
  if (oldest !== undefined && now - oldest.since >= stallMs) {
    const what = oldest.target === '' ? oldest.tool : `${oldest.tool} ${oldest.target}`
    return { text: `waiting on ${what} for ${minutes(now - oldest.since)}`, isStalled: true, mark: `open:${oldest.tool}:${oldest.since}` }
  }
  const silent = now - activity.lastAt
  if (silent >= stallMs) return { text: `no output for ${minutes(silent)}`, isStalled: true, mark: `silent:${activity.lastAt}` }
  if (oldest !== undefined) return { text: `working: ${oldest.tool}`, isStalled: false, mark: '' }
  return { text: `working, ${activity.steps} step${activity.steps === 1 ? '' : 's'} done`, isStalled: false, mark: '' }
}
