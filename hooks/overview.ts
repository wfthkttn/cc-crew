import type { ClientModule } from 'claude-code'

import type { LimitsProps, LogEntry, LogProps, OverviewAction, OverviewProps, RunningProps, Tab } from './overview-props'

export const OVERVIEW_COLUMNS = 64

const TEXT = '#e8ecf4'
const MUTED = '#6b7280'
const HEADING = '#d97757'
const RUNNING = '#5b9bf0'
const BUTTON = '#24324a'
const BUTTON_HOVER = '#33496b'
const STOP = '#5a2a2a'
const STOP_HOVER = '#7a3434'

/** A run of text; `isPill` marks a button's cells, which draw on a fill; a plain segment with an action (a tab) brightens under the pointer. */
type Segment = { text: string; color?: string; bold?: boolean; action?: OverviewAction; isPill?: boolean; isStop?: boolean; isEnd?: boolean }
type Line = Segment[]

function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length > width ? chars.slice(0, width - 1).join('') + '…' : text + ' '.repeat(width - chars.length)
}

const right = (text: string, width: number) => ' '.repeat(Math.max(0, width - [...text].length)) + text

/** A button: its label on a filled block, half blocks for ends; every cell of it takes the press. */
function pill(label: string, action: OverviewAction, isStop = false): Segment[] {
  return [
    { text: '▐', action, isPill: true, isStop, isEnd: true },
    { text: label, action, isPill: true, isStop },
    { text: '▌', action, isPill: true, isStop, isEnd: true },
  ]
}

const width = (line: Line) => line.reduce((n, s) => n + [...s.text].length, 0)

/** Pads a line to the drawer's width, or cuts it from its end. */
function full(line: Line): Line {
  let left = OVERVIEW_COLUMNS
  const out: Line = []
  for (const s of line) {
    if (left <= 0) break
    const chars = [...s.text]
    out.push(chars.length <= left ? s : { ...s, text: chars.slice(0, left).join('') })
    left -= Math.min(chars.length, left)
  }
  return left > 0 ? [...out, { text: ' '.repeat(left) }] : out
}

const heading = (text: string): Line => [{ text, color: HEADING, bold: true }]
const muted = (text: string): Line => [{ text, color: MUTED }]

const STOP_LABEL = '■ Stop'
const BRIEF_LABEL = '⧉ Brief'
/** A pill is its label and its two ends. */
const STOP_COLUMNS = [...STOP_LABEL].length + 2
const BRIEF_COLUMNS = [...BRIEF_LABEL].length + 2

/** The tab row and the rule under it. */
export const TAB_ROWS = 2

function tabLines(props: OverviewProps): Line[] {
  const label = (tab: Tab): string => {
    if (tab === 'running') return ` Running${props.counts.running > 0 ? ' ' + props.counts.running : ''} `
    if (tab === 'log') return ` Log${props.counts.log > 0 ? ' ' + props.counts.log : ''} `
    return ' Limits '
  }
  const tabs: Tab[] = ['running', 'log', 'limits']
  const row: Line = tabs.flatMap((tab, i) => [
    ...(i > 0 ? [{ text: '│', color: MUTED }] : []),
    { text: label(tab), action: { tab }, ...(tab === props.tab ? { color: HEADING, bold: true } : { color: MUTED }) },
  ])
  return [row, [{ text: '─'.repeat(OVERVIEW_COLUMNS), color: MUTED }]]
}

function runningLines(props: RunningProps): Line[] {
  if (props.runs.length === 0 && props.agents.length === 0) return [muted('Nothing runs now.')]
  const lines: Line[] = []
  if (props.runs.length > 0) lines.push(heading('Crew reviews'))
  for (const run of props.runs) {
    const description = OVERVIEW_COLUMNS - 1 - 1 - 5 - 1 - BRIEF_COLUMNS - 1 - STOP_COLUMNS
    lines.push([
      { text: ' ' + fit(run.description, description) + ' ', color: TEXT, bold: true },
      { text: right(run.elapsed, 5) + ' ', color: MUTED },
      ...pill(BRIEF_LABEL, { brief: run.id }),
      { text: ' ' },
      ...pill(STOP_LABEL, { stop: { run: run.id } }, true),
    ])
    for (const r of run.reviewers) {
      const head: Line = [
        { text: '   ' + fit(r.provider, 12), color: TEXT },
        { text: fit(r.pick, 15) + ' ', color: MUTED },
        { text: fit(r.status, 9), color: r.isRunning ? RUNNING : TEXT },
        { text: right(r.elapsed, 5) + ' ', color: MUTED },
      ]
      const tail: Line = r.isRunning ? pill(STOP_LABEL, { stop: { run: run.id, key: r.key } }, true) : [{ text: r.tokens ?? '', color: MUTED }]
      lines.push([...head, ...tail])
    }
  }
  if (props.agents.length > 0) lines.push(heading('Claude agents'))
  for (const a of props.agents) {
    lines.push([
      { text: '   ' + fit(a.type, 12), color: TEXT },
      { text: fit(a.description, 15) + ' ', color: MUTED },
      { text: fit(a.status, 9), color: a.status === 'running' ? RUNNING : TEXT },
      { text: right(a.elapsed, 5) + ' ', color: MUTED },
      { text: a.tokens ?? '', color: MUTED },
    ])
  }
  return lines
}

function entryLines(entry: LogEntry): Line[] {
  if (entry.kind === 'agent') {
    return [
      [
        { text: entry.time + ' ', color: MUTED },
        { text: fit(entry.type, 10), color: TEXT },
        { text: fit(entry.description, 15) + ' ', color: MUTED },
        { text: fit(entry.status, 9), color: TEXT },
        { text: right(entry.elapsed, 5) + ' ', color: MUTED },
        { text: entry.tokens ?? '', color: MUTED },
      ],
    ]
  }
  return [
    [
      { text: entry.time + ' ', color: MUTED },
      { text: fit(entry.description, OVERVIEW_COLUMNS - 6 - 6 - 16), color: TEXT, bold: true },
      { text: right(entry.elapsed, 5) + ' ', color: MUTED },
      { text: entry.tally, color: MUTED },
    ],
    ...entry.reviewers.map(
      (r): Line => [
        { text: '      ' + fit(r.provider, 12), color: TEXT },
        { text: fit(r.status, 9), color: TEXT },
        { text: right(r.elapsed, 5) + ' ', color: MUTED },
        { text: [r.tokens, r.findings].filter(x => x !== null && x !== '').join(' · '), color: MUTED },
      ],
    ),
  ]
}

/** The log's lines before paging: the session's totals, then each entry. */
function logBody(props: LogProps): Line[] {
  const body: Line[] = props.totals.map((text, i) => [{ text, color: i === 0 ? TEXT : MUTED, bold: i === 0 }])
  if (props.entries.length === 0) return [...body, muted('Nothing ran in this session yet.')]
  return [...body, ...props.entries.flatMap(entryLines)]
}

/** Lines one page of the log shows: the drawer's room less the tabs and a line for the page buttons. */
export function logPageSize(rows: number): number {
  return Math.max(1, rows - TAB_ROWS - 1)
}

function logLines(props: LogProps, rows: number): Line[] {
  const body = logBody(props)
  if (body.length <= rows - TAB_ROWS) return body
  const size = logPageSize(rows)
  const pages = Math.ceil(body.length / size)
  const page = Math.min(props.page, pages - 1)
  const nav: Line = [
    ...(page > 0 ? pill('▲ Newer', { page: -1 }) : [{ text: ' '.repeat(9) }]),
    { text: ' ' },
    ...(page < pages - 1 ? pill('▼ Older', { page: 1 }) : [{ text: ' '.repeat(9) }]),
    { text: `  page ${page + 1} of ${pages}`, color: MUTED },
  ]
  return [...body.slice(page * size, page * size + size), nav]
}

function limitsLines(props: LimitsProps): Line[] {
  const rows: Line[] = props.rows.map(r => [
    { text: fit(r.label, 15), color: TEXT, bold: true },
    { text: fit(`${r.spent} / ${r.limit}`, 33), color: MUTED },
    ...pill(r.raiseLabel, { raise: r.raise }),
  ])
  const gates: Line = [
    { text: fit('Allowed', 15), color: TEXT, bold: true },
    ...props.gates.flatMap(g => [...pill(`${g.isOpen ? '●' : '○'} ${g.gate}`, { toggle: g.gate }, !g.isOpen), { text: ' ' }]),
  ]
  return [
    ...rows,
    [{ text: '' }],
    gates,
    [{ text: '' }],
    muted('Fresh tokens: input not read from a cache, plus output.'),
    muted('Raises and switches hold for this session; defaults in /config.'),
  ]
}

export function overviewLines(props: OverviewProps): Line[] {
  const body = props.tab === 'running' ? runningLines(props.running) : props.tab === 'log' ? logLines(props.log, props.rows) : limitsLines(props.limits)
  return [...tabLines(props), ...body].map(full)
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
let latest: OverviewProps | null = null

type State = { hover: OverviewAction | null }

const Overview: ClientModule<OverviewProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(p => {
      const action = p.type === 'leave' || latest === null ? null : actionAt(latest, p.x, p.y)
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
        const isHovered = s.action !== undefined && same(hover, s.action)
        if (s.isPill !== true) {
          return Text({ ...(s.color === undefined ? {} : { color: isHovered ? TEXT : s.color }), bold: s.bold === true || isHovered, children: [s.text] })
        }
        const fill = s.isStop === true ? (isHovered ? STOP_HOVER : STOP) : isHovered ? BUTTON_HOVER : BUTTON
        if (s.isEnd === true) return Text({ color: fill, children: [s.text] })
        return Text({ color: TEXT, bold: true, backgroundColor: fill, children: [s.text] })
      }),
    }),
  )
  return Box({ flexDirection: 'column', width: OVERVIEW_COLUMNS, children: drawn })
}

export default Overview
