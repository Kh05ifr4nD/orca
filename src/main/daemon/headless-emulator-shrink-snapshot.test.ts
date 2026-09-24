/**
 * xterm keeps a line's old length after a column shrink whenever it does not
 * reflow (the alternate buffer always; the normal buffer without scrollback or
 * on older ConPTY). The snapshot must still describe only the visible grid, or
 * the stale right-hand cells wrap into garbage rows when a restore replays it.
 */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'

const WIDE = 135
const NARROW = 48
const ROWS = 6

function visibleRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: terminal.rows },
    (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true, 0, terminal.cols) ?? ''
  )
}

async function replayAtModelGrid(emu: HeadlessEmulator): Promise<Terminal> {
  const snapshot = emu.getSnapshot()
  const restored = new Terminal({ cols: NARROW, rows: ROWS, allowProposedApi: true })
  await new Promise<void>((resolve) =>
    restored.write(
      // The restorer owns the alt-screen transition that the split strips.
      `${snapshot.scrollbackAnsi ?? ''}${snapshot.modes.alternateScreen ? '\x1b[?1049h' : ''}${snapshot.snapshotAnsi}`,
      resolve
    )
  )
  return restored
}

async function paintShrinkRepaint(emu: HeadlessEmulator, prefix: string): Promise<void> {
  await emu.write(`${prefix}\x1b[48;5;236m`)
  for (let y = 1; y <= ROWS; y++) {
    await emu.write(`\x1b[${y};1H${`WIDE${y}`.padEnd(WIDE, '.')}`)
  }
  emu.resize(NARROW, ROWS)
  // Differential repaint of the narrow grid: no clear, like OpenTUI after SIGWINCH.
  for (let y = 1; y <= ROWS; y++) {
    await emu.write(`\x1b[${y};1H${`narrow${y}`.padEnd(NARROW, ' ')}`)
  }
}

describe('headless emulator snapshot after a column shrink', () => {
  it('restores the visible alternate-screen grid, not the stale pre-shrink cells', async () => {
    const emu = new HeadlessEmulator({ cols: WIDE, rows: ROWS })
    await paintShrinkRepaint(emu, '\x1b[?1049h')
    const model = visibleRows((emu as unknown as { terminal: Terminal }).terminal)
    expect(model[0]).toBe('narrow1'.padEnd(NARROW, ' '))

    const restored = await replayAtModelGrid(emu)

    expect(restored.buffer.active.type).toBe('alternate')
    expect(visibleRows(restored)).toEqual(model)
    emu.dispose()
  })

  it('restores the visible normal-buffer grid when the shrink did not reflow', async () => {
    const emu = new HeadlessEmulator({ cols: WIDE, rows: ROWS })
    // Pre-21376 ConPTY disables reflow, so the normal buffer keeps stale cells too.
    ;(emu as unknown as { terminal: Terminal }).terminal.options.windowsPty = {
      backend: 'conpty',
      buildNumber: 19041
    }
    await paintShrinkRepaint(emu, '')
    const model = visibleRows((emu as unknown as { terminal: Terminal }).terminal)
    expect(model[0]).toBe('narrow1'.padEnd(NARROW, ' '))

    const restored = await replayAtModelGrid(emu)

    expect(visibleRows(restored)).toEqual(model)
    emu.dispose()
  })
})
