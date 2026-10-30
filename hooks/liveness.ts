import type { AgentsHealth } from 'cc-agents'

/** How crew words a running agent's health. `mark` names the stall, so one stall is told once. */
export type Reading = { text: string; isStalled: boolean; mark: string }

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`

/** `health` null: the run ended, its end on its way here. */
export function readingOf(health: AgentsHealth | null): Reading {
  if (health === null || health.state === 'ending') return { text: 'ending', isStalled: false, mark: '' }
  if (health.state === 'working') {
    const text = health.tool === undefined ? `working, ${health.steps} step${health.steps === 1 ? '' : 's'} done` : `working: ${health.tool}`
    return { text, isStalled: false, mark: '' }
  }
  const on = health.on
  if (on === undefined) return { text: `no output for ${minutes(health.forMs)}`, isStalled: true, mark: health.mark }
  const what = on.target === '' ? on.tool : `${on.tool} ${on.target}`
  return { text: `waiting on ${what} for ${minutes(health.forMs)}`, isStalled: true, mark: health.mark }
}
