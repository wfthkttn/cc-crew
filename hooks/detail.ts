import type { ClientModule } from 'claude-code'

import type { DetailProps } from './overview-props'

const TEXT = '#e8ecf4'
const MUTED = '#6b7280'
const HEADING = '#d97757'
const BUTTON = '#24324a'
const BUTTON_HOVER = '#33496b'
const CLOSE_LABEL = '✕ Close'
const UP_LABEL = '▲ Up'
const DOWN_LABEL = '▼ Down'
/** A button is its label and its two half-block ends. */
const pillColumns = (label: string) => [...label].length + 2

function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length > width ? chars.slice(0, width - 1).join('') + '…' : text + ' '.repeat(width - chars.length)
}

/** `text` broken into lines of at most `width` columns, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const joined = line === '' ? word : `${line} ${word}`
      if ([...joined].length <= width) {
        line = joined
        continue
      }
      if (line !== '') out.push(line)
      let rest = [...word]
      while (rest.length > width) {
        out.push(rest.slice(0, width).join(''))
        rest = rest.slice(width)
      }
      line = rest.join('')
    }
    out.push(line)
  }
  return out
}

/** One page of the text, wrapped to the modal's width: the rows it has less the title row and, when it pages, the row of page buttons. */
export function detailProps(title: string, text: string, room: { rows: number; columns: number }, page: number): DetailProps {
  const lines = wrap(text, room.columns)
  const isOnePage = lines.length <= room.rows - 1
  const size = isOnePage ? lines.length : Math.max(1, room.rows - 2)
  const pages = Math.max(1, Math.ceil(lines.length / size))
  const at = Math.min(page, pages - 1)
  const shown = lines.slice(at * size, at * size + size)
  return { title, lines: shown, columns: room.columns, page: at, pages, first: at * size + 1, last: at * size + shown.length, total: lines.length }
}

type Press = { close: true } | { page: 1 | -1 }

/** What a press at `x`, `y` asks for: Close on the title row, Up and Down on the last row when there are pages. */
export function pressAt(props: DetailProps, x: number, y: number): Press | null {
  if (y === 0) return x >= props.columns - pillColumns(CLOSE_LABEL) && x < props.columns ? { close: true } : null
  if (props.pages === 1 || y !== props.lines.length + 1) return null
  if (x < pillColumns(UP_LABEL)) return props.page > 0 ? { page: -1 } : null
  const down = pillColumns(UP_LABEL) + 1
  if (x >= down && x < down + pillColumns(DOWN_LABEL)) return props.page < props.pages - 1 ? { page: 1 } : null
  return null
}

const same = (a: Press | null, b: Press | null) => JSON.stringify(a) === JSON.stringify(b)

/** The props of the last draw: the pointer listener, set once, hit-tests against these. */
let latest: DetailProps | null = null

type State = { hover: Press | null }

const Detail: ClientModule<DetailProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(p => {
      const press = p.type === 'leave' || latest === null ? null : pressAt(latest, p.x, p.y)
      if (p.type === 'down' && p.button === 'left' && press !== null) surface.post(press)
      if (!same(surface.state?.hover ?? null, press)) surface.setState({ hover: press })
    })
    surface.setState({ hover: null })
  }
  latest = props
  const hover = surface.state?.hover ?? null
  const pill = (label: string, press: Press, isOn: boolean) => {
    const fill = same(hover, press) ? BUTTON_HOVER : BUTTON
    if (!isOn) return [Text({ color: MUTED, children: [` ${label} `] })]
    return [
      Text({ color: fill, children: ['▐'] }),
      Text({ color: TEXT, bold: true, backgroundColor: fill, children: [label] }),
      Text({ color: fill, children: ['▌'] }),
    ]
  }
  const nav =
    props.pages === 1
      ? []
      : [
          Text({
            children: [
              ...pill(UP_LABEL, { page: -1 }, props.page > 0),
              Text({ children: [' '] }),
              ...pill(DOWN_LABEL, { page: 1 }, props.page < props.pages - 1),
              Text({ color: MUTED, children: [`  lines ${props.first}–${props.last} of ${props.total}`] }),
            ],
          }),
        ]
  return Box({
    flexDirection: 'column',
    width: props.columns,
    children: [
      Text({
        children: [Text({ color: HEADING, bold: true, children: [fit(props.title, props.columns - pillColumns(CLOSE_LABEL))] }), ...pill(CLOSE_LABEL, { close: true }, true)],
      }),
      ...props.lines.map(line => Text({ color: TEXT, children: [fit(line, props.columns)] })),
      ...nav,
    ],
  })
}

export default Detail
