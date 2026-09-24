/**
 * Minimal repros for serializer round-trip faults the differential fuzz found
 * (serialize-grid.differential.fuzz.test.ts): each replays a SerializeAddon
 * snapshot at the source grid and expects the same cells and cursor.
 */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createFuzzTerminal, writeTerminal } from './serialize-grid-roundtrip'

function paintedGrid(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from({ length: terminal.rows }, (_, y) => {
    const line = buffer.getLine(buffer.viewportY + y)
    return Array.from({ length: terminal.cols }, (_, x) => {
      const cell = line?.getCell(x)
      return `${cell?.getChars() || ' '}${cell?.isBgDefault() ? '' : '*'}`
    }).join('')
  })
}

function snapshotState(terminal: Terminal): { grid: string[]; cursor: string; type: string } {
  const buffer = terminal.buffer.active
  return {
    grid: paintedGrid(terminal),
    cursor: `${buffer.cursorX},${buffer.cursorY},${buffer.baseY}`,
    type: buffer.type
  }
}

function roundTrip(source: Terminal): ReturnType<typeof snapshotState> {
  const serializer = new SerializeAddon()
  source.loadAddon(serializer)
  const replay = createFuzzTerminal({ cols: source.cols, rows: source.rows, scrollback: 1000 })
  writeTerminal(replay, serializer.serialize())
  return snapshotState(replay)
}

describe('SerializeAddon round-trip edge cases', () => {
  it('keeps a soft wrap after a clipped wide glyph on its own row (conpty seed 1149)', () => {
    const source = createFuzzTerminal({ cols: 12, rows: 3, scrollback: 1000, conpty: true })
    writeTerminal(source, 'abcdefghi中WRAPPED')
    source.resize(10, 3)
    const expected = snapshotState(source)
    // The glyph's trailing half is past the grid, so the serializer blanks its last column.
    expected.grid[0] = expected.grid[0].replace('中', ' ')

    expect(roundTrip(source)).toEqual(expected)
  })
})
