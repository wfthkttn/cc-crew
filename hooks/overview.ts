import type { ClientModule } from 'claude-code'

import type { OverviewAction, OverviewProps } from './overview-props'

export const OVERVIEW_COLUMNS = 64

const TEXT = '#e8ecf4'
const MUTED = '#6b7280'
const HEADING = '#d97757'
const RUNNING = '#5b9bf0'
const BUTTON = '#24324a'
const BUTTON_HOVER = '#33496b'
const STOP = '#5a2a2a'
const STOP_HOVER = '#7a3434'

type Segment = { text: string; color?: string; bold?: boolean; action?: OverviewAction; isStop?: boolean; isEnd?: boolean }
type Line = Segment[]

function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length > width ? chars.slice(0, width - 1).join('') + '…' : text + ' '.repeat(width - chars.length)
}

const right = (text: string, width: number) => ' '.repeat(Math.max(0, width - [...text].length)) + text

/** A button: its label on a filled block, half blocks for ends; every cell of it takes the press. */
function pill(label: string, action: OverviewAction, isStop = false): Segment[] {
  return [
    { text: '▐', action, isStop, isEnd: true },
    { text: label, action, isStop },
    { text: '▌', action, isStop, isEnd: true },
  ]
}

const width = (line: Line) => line.reduce((n, s) => n + [...s.text].length, 0)

function padded(line: Line): Line {
  return [...line, { text: ' '.repeat(Math.max(0, OVERVIEW_COLUMNS - width(line))) }]
}

const STOP_LABEL = '■ Stop'
const BRIEF_LABEL = '⧉ Brief'
/** A pill is its label and its two ends. */
const STOP_COLUMNS = [...STOP_LABEL].length + 2
const BRIEF_COLUMNS = [...BRIEF_LABEL].length + 2

export function overviewLines(props: OverviewProps): Line[] {
  const lines: Line[] = []
  if (props.runs.length === 0 && props.agents.length === 0) return [padded([{ text: 'Nothing runs now.', color: MUTED }])]
  if (props.runs.length > 0) lines.push(padded([{ text: 'Crew reviews', color: HEADING, bold: true }]))
  for (const run of props.runs) {
    const description = OVERVIEW_COLUMNS - 1 - 1 - 5 - 1 - BRIEF_COLUMNS - 1 - STOP_COLUMNS
    lines.push(
      padded([
        { text: ' ' + fit(run.description, description) + ' ', color: TEXT, bold: true },
        { text: right(run.elapsed, 5) + ' ', color: MUTED },
        ...pill(BRIEF_LABEL, { brief: run.id }),
        { text: ' ' },
        ...pill(STOP_LABEL, { stop: { run: run.id } }, true),
      ]),
    )
    for (const r of run.reviewers) {
      const head: Line = [
        { text: '   ' + fit(r.provider, 12), color: TEXT },
        { text: fit(r.pick, 15) + ' ', color: MUTED },
        { text: fit(r.status, 9), color: r.isRunning ? RUNNING : TEXT },
        { text: right(r.elapsed, 5) + ' ', color: MUTED },
      ]
      const tail: Line = r.isRunning ? pill(STOP_LABEL, { stop: { run: run.id, key: r.key } }, true) : [{ text: r.tokens ?? '', color: MUTED }]
      lines.push(padded([...head, ...tail]))
    }
  }
  if (props.agents.length > 0) lines.push(padded([{ text: 'Claude agents', color: HEADING, bold: true }]))
  for (const a of props.agents) {
    lines.push(
      padded([
        { text: '   ' + fit(a.type, 12), color: TEXT },
        { text: fit(a.description, 15) + ' ', color: MUTED },
        { text: fit(a.status, 9), color: a.status === 'running' ? RUNNING : TEXT },
        { text: right(a.elapsed, 5) + ' ', color: MUTED },
        { text: a.tokens ?? '', color: MUTED },
      ]),
    )
  }
  return lines.map(line => fitLine(line))
}

/** Cuts a line that runs past the drawer, from its end. */
function fitLine(line: Line): Line {
  let left = OVERVIEW_COLUMNS
  const out: Line = []
  for (const s of line) {
    if (left <= 0) break
    const chars = [...s.text]
    out.push(chars.length <= left ? s : { ...s, text: chars.slice(0, left).join('') })
    left -= Math.min(chars.length, left)
  }
  return out
}

/** The action of the button at `x`, `y`, or null. */
export function actionAt(props: OverviewProps, x: number, y: number): OverviewAction | null {
  const line = overviewLines(props)[y]
  if (line === undefined) return null
  let at = 0
  for (const s of line) {
    const end = at + [...s.text].length
    if (x >= at && x < end) return s.action ?? null
    at = end
  }
  return null
}

const same = (a: OverviewAction | null, b: OverviewAction | null) => JSON.stringify(a) === JSON.stringify(b)

/** The props of the last draw: the pointer listener, set once, hit-tests against these. */
let latest: OverviewProps = { runs: [], agents: [] }

type State = { hover: OverviewAction | null }

const Overview: ClientModule<OverviewProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(p => {
      const action = p.type === 'leave' ? null : actionAt(latest, p.x, p.y)
      if (p.type === 'down' && p.button === 'left' && action !== null) surface.post(action)
      if (!same(surface.state?.hover ?? null, action)) surface.setState({ hover: action })
    })
    surface.setState({ hover: null })
  }
  latest = props
  const hover = surface.state?.hover ?? null
  const drawn = overviewLines(props).map(line =>
    Text({
      children: line.map(s => {
        if (s.action === undefined) return Text({ ...(s.color === undefined ? {} : { color: s.color }), bold: s.bold === true, children: [s.text] })
        const isHovered = same(hover, s.action)
        const fill = s.isStop === true ? (isHovered ? STOP_HOVER : STOP) : isHovered ? BUTTON_HOVER : BUTTON
        if (s.isEnd === true) return Text({ color: fill, children: [s.text] })
        return Text({ color: TEXT, bold: true, backgroundColor: fill, children: [s.text] })
      }),
    }),
  )
  return Box({ flexDirection: 'column', width: OVERVIEW_COLUMNS, children: drawn })
}

export default Overview
