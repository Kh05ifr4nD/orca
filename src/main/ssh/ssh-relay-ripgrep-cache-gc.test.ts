import { describe, expect, it, vi } from 'vitest'

const { execCommandMock } = vi.hoisted(() => ({ execCommandMock: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execCommandMock }))

import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { gcRemoteRipgrepCache, supportsRipgrepCacheGc } from './ssh-relay-ripgrep-cache-gc'

const LINUX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const CURRENT = 'c0ffee0123456789-linux-x64'
const SUPERSEDED = 'dead000000000000-linux-x64'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the GC only issues exec commands; nothing else on the connection is reached.
const conn = {} as unknown as SshConnection

function scripts(): string[] {
  return execCommandMock.mock.calls.map(([, command]) => String(command))
}

// Why exclude `find`: the entry listing carries its own `rm -rf` sweep for stale tombstones, and
// counting that as a collection would make every assertion here pass for the wrong reason.
function removedTrees(): string[] {
  return scripts().filter(
    (s) => s.includes('rm -rf') && s.includes('.rg-gc-') && !s.includes('find ')
  )
}

function reply(entries: readonly string[], refs: readonly string[] | 'unreadable'): void {
  execCommandMock.mockReset()
  execCommandMock.mockImplementation((_conn: unknown, command: string) => {
    const text = String(command)
    if (text.includes('ENTRY %s')) {
      return Promise.resolve(
        `${entries.map((e) => `ENTRY ${e}`).join('\n')}\n__ORCA_RG_CACHE__LIST_OK`
      )
    }
    if (text.includes('REF %s')) {
      return Promise.resolve(
        refs === 'unreadable'
          ? '__ORCA_RG_CACHE__REFS_ERR'
          : `${refs.map((r) => `REF ${r}`).join('\n')}\n__ORCA_RG_CACHE__REFS_OK`
      )
    }
    if (text.includes('MOVED')) {
      return Promise.resolve('MOVED')
    }
    return Promise.resolve('')
  })
}

describe('remote ripgrep cache GC', () => {
  it('collects a build no relay installation references', async () => {
    reply([CURRENT, SUPERSEDED], [CURRENT])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toHaveLength(1)
    expect(removedTrees()[0]).toContain(SUPERSEDED)
  })

  // Why: the reference is the whole safety argument. A build a live relay was launched against
  // must survive, however old its directory is.
  it('keeps a referenced build', async () => {
    reply([CURRENT, SUPERSEDED], [CURRENT, SUPERSEDED])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why the whole pass and not just that directory: a relay deployed by an older Orca records no
  // reference, so its binary cannot be identified -- and guessing is what breaks a live search.
  it('collects nothing when any relay directory cannot be accounted for', async () => {
    reply([CURRENT, SUPERSEDED], 'unreadable')

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why a readable RECHECK behind an unreadable first scan: with both unreadable, the restore in
  // removeUnreferencedEntry hides a missing up-front guard, and the test passes either way. This
  // shape is the only one that fails if the pass stops treating an unaccountable scan as fatal.
  it('does not even tombstone when the first reference scan is unreadable', async () => {
    execCommandMock.mockReset()
    let refCalls = 0
    execCommandMock.mockImplementation((_conn: unknown, command: string) => {
      const text = String(command)
      if (text.includes('ENTRY %s')) {
        return Promise.resolve(`ENTRY ${SUPERSEDED}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      if (text.includes('REF %s')) {
        refCalls += 1
        return Promise.resolve(
          refCalls === 1 ? '__ORCA_RG_CACHE__REFS_ERR' : '__ORCA_RG_CACHE__REFS_OK'
        )
      }
      if (text.includes('MOVED')) {
        return Promise.resolve('MOVED')
      }
      return Promise.resolve('')
    })

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

    expect(removedTrees()).toEqual([])
    expect(scripts().filter((s) => s.includes('MOVED'))).toEqual([])
  })

  it('keeps the pinned build even when nothing references it yet', async () => {
    reply([CURRENT], [])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  // Why restore rather than proceed: a deploy that read the entry as present can still be writing
  // its marker, and the recheck is the only place that race becomes visible.
  it('restores a tombstoned build when the recheck finds a new reference', async () => {
    execCommandMock.mockReset()
    let refCalls = 0
    execCommandMock.mockImplementation((_conn: unknown, command: string) => {
      const text = String(command)
      if (text.includes('ENTRY %s')) {
        return Promise.resolve(`ENTRY ${SUPERSEDED}\n__ORCA_RG_CACHE__LIST_OK`)
      }
      if (text.includes('REF %s')) {
        refCalls += 1
        return Promise.resolve(
          refCalls === 1
            ? '__ORCA_RG_CACHE__REFS_OK'
            : `REF ${SUPERSEDED}\n__ORCA_RG_CACHE__REFS_OK`
        )
      }
      if (text.includes('MOVED')) {
        return Promise.resolve('MOVED')
      }
      return Promise.resolve('')
    })

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', {})

    expect(removedTrees()).toEqual([])
    // Moved out, then moved back.
    expect(scripts().filter((s) => s.includes('MOVED'))).toHaveLength(2)
  })

  it('only mints entry names it could have written', async () => {
    reply([CURRENT, '../../etc', 'not-an-entry'], [CURRENT])

    await gcRemoteRipgrepCache(conn, LINUX, '/home/me', { pinnedEntry: CURRENT })

    expect(removedTrees()).toEqual([])
  })

  it('has no pass on Windows remotes yet', async () => {
    execCommandMock.mockReset()

    expect(supportsRipgrepCacheGc(WINDOWS)).toBe(false)
    await gcRemoteRipgrepCache(conn, WINDOWS, 'C:/Users/me', {})
    expect(execCommandMock).not.toHaveBeenCalled()
  })
})
