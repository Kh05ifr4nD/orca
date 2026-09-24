import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureRelayBundledRipgrep,
  pathRipgrepCommand,
  resetRelayRipgrepPathCacheForTests
} from './relay-bundled-ripgrep'

const originalPlatform = process.platform
const originalPath = process.env.PATH

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('relay PATH ripgrep resolution', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    process.env.PATH = originalPath
    resetRelayRipgrepPathCacheForTests()
    configureRelayBundledRipgrep(undefined)
  })

  // Why this matters on Windows only: CreateProcessW searches the spawn cwd -- the user's repo --
  // before PATH, so a bare `rg` there runs a planted rg.exe out of a cloned repository.
  it('resolves an absolute rg.exe from PATH on Windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-rg-'))
    try {
      writeFileSync(join(dir, 'rg.exe'), '')
      setPlatform('win32')
      process.env.PATH = `${join(dir, 'missing')}${delimiter}${dir}`
      resetRelayRipgrepPathCacheForTests()

      expect(pathRipgrepCommand()).toBe(join(dir, 'rg.exe'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null on Windows rather than a bare name when PATH has no rg', () => {
    setPlatform('win32')
    process.env.PATH = join(tmpdir(), 'definitely-not-here')
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBeNull()
  })

  // Why a relative PATH entry is skipped: it resolves against the cwd, the hazard being avoided.
  it('ignores relative PATH entries on Windows', () => {
    setPlatform('win32')
    process.env.PATH = `.${delimiter}node_modules/.bin`
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBeNull()
  })

  // Why POSIX keeps the bare name: execvp never consults the cwd, so there is nothing to resolve.
  it('keeps the bare name on POSIX', () => {
    setPlatform('linux')
    resetRelayRipgrepPathCacheForTests()

    expect(pathRipgrepCommand()).toBe('rg')
  })
})
