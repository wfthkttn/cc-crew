import type { ClientModule } from 'claude-code'

import type { LimitsProps, LogProps, OverviewAction, OverviewProps, RunningProps, Tab } from './overview-props'

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
const OPEN_LABEL = '⧉ Details'
/** A pill is its label and its two ends. */
const STOP_COLUMNS = [...STOP_LABEL].length + 2
const OPEN_COLUMNS = [...OPEN_LABEL].length + 2

/** The tab row and the rule under it. */
export const TAB_ROWS = 2

function tabLines(props: OverviewProps): Line[] {
  const label = (tab: Tab): string => {
    if (tab === 'running') return ` Running${props.counts.running > 0 ? ' ' + props.counts.running : ''} `
    if (tab === 'log') return ` Log${props.counts.log > 0 ? ' ' + props.counts.log : ''} `
    return ' Limits '
  }
  const tabs: Tab[] = ['running', 'limits', 'log']
  const row: Line = tabs.flatMap((tab, i) => [
    ...(i > 0 ? [{ text: '│', color: MUTED }] : []),
    { text: label(tab), action: { tab }, ...(tab === props.tab ? { color: HEADING, bold: true } : { color: MUTED }) },
  ])
  return [row, [{ text: '─'.repeat(OVERVIEW_COLUMNS), color: MUTED }]]
}

function runningLines(props: RunningProps): Line[] {
  const spent = [
    ...table(
      TOTAL_COLUMNS,
      0,
      props.totals.map(t => ({ cells: [t.label, t.count, t.new, t.cached, t.out], isPart: t.isPart })),
    ),
    [{ text: '' }],
  ]
  if (props.runs.length === 0 && props.agents.length === 0) return [...spent, muted('Nothing runs now.')]
  const lines: Line[] = [...spent]
  if (props.runs.length > 0) lines.push(heading('Crew reviews'))
  for (const run of props.runs) {
    const description = OVERVIEW_COLUMNS - 1 - 1 - 5 - 1 - OPEN_COLUMNS - 1 - STOP_COLUMNS
    lines.push([
      { text: ' ' + fit(run.description, description) + ' ', color: TEXT, bold: true },
      { text: right(run.elapsed, 5) + ' ', color: MUTED },
      ...pill(OPEN_LABEL, { open: { run: run.id } }),
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
      { text: '   ' + fit(a.type, 12), color: TEXT, action: { open: { agent: a.id } } },
      { text: fit(a.description, 15) + ' ', color: MUTED, action: { open: { agent: a.id } } },
      { text: fit(a.status, 9), color: a.status === 'running' ? RUNNING : TEXT, action: { open: { agent: a.id } } },
      { text: right(a.elapsed, 5) + ' ', color: MUTED, action: { open: { agent: a.id } } },
      { text: a.tokens ?? '', color: MUTED, action: { open: { agent: a.id } } },
    ])
  }
  return lines
}

type Column = { title: string; width: number; isNumber?: boolean }
/** A table row: `isPart` dims it and indents its named column; `action` makes the whole row a press; `isOpened` marks it. */
type TableRow = { cells: string[]; isPart: boolean; action?: OverviewAction; isOpened?: boolean }

/** Columns a space apart, numbers to the right, under a header and a rule. */
function table(columns: readonly Column[], named: number, rows: readonly TableRow[]): Line[] {
  const cell = (text: string, c: Column) => (c.isNumber === true ? right(fit(text, c.width).trimEnd(), c.width) : fit(text, c.width))
  const used = columns.reduce((n, c) => n + c.width, 0) + columns.length - 1
  return [
    [{ text: columns.map(c => cell(c.title, c)).join(' '), color: MUTED, bold: true }],
    [{ text: '─'.repeat(used), color: MUTED }],
    ...rows.map(
      (row): Line => [
        {
          text: columns.map((c, i) => cell(i === named && row.isPart ? `  ${row.cells[i] ?? ''}` : (row.cells[i] ?? ''), c)).join(' '),
          color: row.isOpened === true ? HEADING : row.isPart ? MUTED : TEXT,
          ...(row.isOpened === true ? { bold: true } : {}),
          ...(row.action === undefined ? {} : { action: row.action }),
        },
      ],
    ),
  ]
}

const TOTAL_COLUMNS: readonly Column[] = [
  { title: '', width: 10 },
  { title: 'count', width: 9, isNumber: true },
  { title: 'new', width: 6, isNumber: true },
  { title: 'cached', width: 7, isNumber: true },
  { title: 'out', width: 6, isNumber: true },
]

/** time, what, status, took, new, out: the what column takes what the others leave. */
const LOG_COLUMNS: readonly Column[] = [
  { title: 'time', width: 5 },
  { title: 'what', width: OVERVIEW_COLUMNS - 5 - 13 - 5 - 5 - 5 - 5 },
  { title: 'status', width: 13 },
  { title: 'took', width: 5, isNumber: true },
  { title: 'new', width: 5, isNumber: true },
  { title: 'out', width: 5, isNumber: true },
]

/** The table's header and rule, which every page repeats, and a line for the page buttons. */
const LOG_FRAME_ROWS = 3

/** Rows one page of the log lists: the drawer's room less the tabs, the header and rule, and the page buttons. */
export function logPageSize(rows: number): number {
  return Math.max(1, rows - TAB_ROWS - LOG_FRAME_ROWS)
}

const isSame = (a: OverviewProps['opened'], b: OverviewProps['opened']) => JSON.stringify(a) === JSON.stringify(b)

/** Every finished run and agent, a row each that opens its details, paged when they outrun the drawer. */
function logLines(props: LogProps, rows: number, opened: OverviewProps['opened']): Line[] {
  if (props.rows.length === 0) return [muted('Nothing ran in this session yet.')]
  const size = logPageSize(rows)
  const pages = Math.ceil(props.rows.length / size)
  const page = Math.min(props.page, pages - 1)
  const shown = props.rows.slice(page * size, page * size + size)
  const lines = table(
    LOG_COLUMNS,
    1,
    shown.map(r => ({ cells: [r.time, r.what, r.status, r.took, r.new, r.out], isPart: false, action: { open: r.open }, isOpened: isSame(opened, r.open) })),
  )
  if (pages === 1) return lines
  const nav: Line = [
    ...(page > 0 ? pill('▲ Newer', { page: -1 }) : [{ text: ' '.repeat(9) }]),
    { text: ' ' },
    ...(page < pages - 1 ? pill('▼ Older', { page: 1 }) : [{ text: ' '.repeat(9) }]),
    { text: `  page ${page + 1} of ${pages}`, color: MUTED },
  ]
  return [...lines, nav]
}

function limitsLines(props: LimitsProps): Line[] {
  const on: Line = [
    { text: fit('Limits', 15), color: TEXT, bold: true },
    ...pill(props.isOn ? '● on' : '○ off', { switchLimits: true }, !props.isOn),
    { text: props.isOn ? '' : '  nothing below is enforced', color: MUTED },
  ]
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
    on,
    [{ text: '' }],
    ...rows,
    [{ text: '' }],
    gates,
    [{ text: '' }],
    muted('Tokens: new input plus output; cache reads are not counted.'),
    muted('Raises and switches hold for this session; defaults in /config.'),
  ]
}

export function overviewLines(props: OverviewProps): Line[] {
  const body =
    props.tab === 'running' ? runningLines(props.running) : props.tab === 'log' ? logLines(props.log, props.rows, props.opened) : limitsLines(props.limits)
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
