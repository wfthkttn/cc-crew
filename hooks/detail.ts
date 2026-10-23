import type { ClientModule } from 'claude-code'

import type { DetailProps } from './overview-props'
import { OVERVIEW_COLUMNS } from './overview'

const TEXT = '#e8ecf4'
const HEADING = '#d97757'
const BUTTON = '#24324a'
const BUTTON_HOVER = '#33496b'
const CLOSE_LABEL = '✕ Close'
/** The close button's columns, its two half-block ends included, at the right end of the first line. */
const CLOSE_FROM = OVERVIEW_COLUMNS - [...CLOSE_LABEL].length - 2

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
      const next = line === '' ? word : `${line} ${word}`
      if ([...next].length <= width) {
        line = next
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

export function isCloseAt(x: number, y: number): boolean {
  return y === 0 && x >= CLOSE_FROM && x < OVERVIEW_COLUMNS
}

type State = { isHovered: boolean }

const Detail: ClientModule<DetailProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onPointer(p => {
      const isOn = p.type !== 'leave' && isCloseAt(p.x, p.y)
      if (p.type === 'down' && p.button === 'left' && isOn) surface.post({ close: true })
      if (surface.state?.isHovered !== isOn) surface.setState({ isHovered: isOn })
    })
    surface.setState({ isHovered: false })
  }
  const fill = surface.state?.isHovered === true ? BUTTON_HOVER : BUTTON
  return Box({
    flexDirection: 'column',
    width: OVERVIEW_COLUMNS,
    children: [
      Text({
        children: [
          Text({ color: HEADING, bold: true, children: [fit(props.title, CLOSE_FROM)] }),
          Text({ color: fill, children: ['▐'] }),
          Text({ color: TEXT, bold: true, backgroundColor: fill, children: [CLOSE_LABEL] }),
          Text({ color: fill, children: ['▌'] }),
        ],
      }),
      ...props.lines.map(line => Text({ color: TEXT, children: [fit(line, OVERVIEW_COLUMNS)] })),
    ],
  })
}

export default Detail
