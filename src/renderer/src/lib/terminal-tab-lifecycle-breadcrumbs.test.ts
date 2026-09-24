import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recordRendererCrashBreadcrumb = vi.hoisted(() => vi.fn())
vi.mock('./crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb }))

import { hashCrashBreadcrumbId } from './crash-breadcrumb-id-hash'
import {
  TERMINAL_TAB_LIFECYCLE_BREADCRUMB_LIMIT,
  TERMINAL_TAB_LIFECYCLE_BREADCRUMB_WINDOW_MS,
  notePtySpawnedForBreadcrumbs,
  recordActiveTerminalTabAutoMoveBreadcrumb,
  recordFreshSpawnRetirementBreadcrumb,
  recordTerminalTabPtyExitBreadcrumb,
  resetTerminalTabLifecycleBreadcrumbsForTests
} from './terminal-tab-lifecycle-breadcrumbs'

describe('terminal tab lifecycle breadcrumbs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    recordRendererCrashBreadcrumb.mockClear()
    resetTerminalTabLifecycleBreadcrumbsForTests()
  })
  afterEach(() => vi.useRealTimers())

  it('records a pty-exit close with host kind and time since spawn, hashing the tab id', () => {
    notePtySpawnedForBreadcrumbs('ssh-conn@@pty-7')
    vi.advanceTimersByTime(1_500)
    recordTerminalTabPtyExitBreadcrumb({
      outcome: 'closed',
      tabId: 'tab-secret-name',
      ptyId: 'ssh-conn@@pty-7',
      exitCode: 0,
      synthetic: false,
      hostKind: 'ssh'
    })
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith('terminal_tab_pty_exit', {
      outcome: 'closed',
      hostKind: 'ssh',
      synthetic: false,
      exitCode: 0,
      msSinceSpawn: 1_500,
      ptyId: '…@@pty-7',
      tabIdHash: hashCrashBreadcrumbId('tab-secret-name')
    })
    expect(JSON.stringify(recordRendererCrashBreadcrumb.mock.calls)).not.toContain('tab-secret')
  })

  it('reports an unknown spawn time as null', () => {
    recordTerminalTabPtyExitBreadcrumb({
      outcome: 'kept-unverified',
      tabId: 'tab',
      ptyId: 'pty-unknown',
      exitCode: -1,
      synthetic: true,
      hostKind: 'local'
    })
    expect(recordRendererCrashBreadcrumb.mock.calls[0]?.[1]).toMatchObject({
      msSinceSpawn: null,
      synthetic: true,
      exitCode: -1
    })
  })

  it('records a disposed-spawn retirement verdict', () => {
    recordFreshSpawnRetirementBreadcrumb({
      path: 'disposed',
      outcome: 'retained',
      ptyId: 'ssh-conn@@pty-7',
      tabId: 'tab',
      isSsh: true,
      spawnWaitMs: 420
    })
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledWith('terminal_fresh_spawn_retired', {
      path: 'disposed',
      outcome: 'retained',
      hostKind: 'ssh',
      ptyId: '…@@pty-7',
      tabIdHash: hashCrashBreadcrumbId('tab'),
      spawnWaitMs: 420
    })
  })

  it('rate-limits per crumb name and carries the suppressed count into the next window', () => {
    const move = {
      reason: 'active-terminal-repair' as const,
      fallback: 'first-tab' as const,
      fromTabId: 'gone',
      toTabId: 'tab-1',
      tabCount: 1
    }
    for (let i = 0; i < TERMINAL_TAB_LIFECYCLE_BREADCRUMB_LIMIT + 3; i += 1) {
      recordActiveTerminalTabAutoMoveBreadcrumb(move)
    }
    expect(recordRendererCrashBreadcrumb).toHaveBeenCalledTimes(
      TERMINAL_TAB_LIFECYCLE_BREADCRUMB_LIMIT
    )

    vi.advanceTimersByTime(TERMINAL_TAB_LIFECYCLE_BREADCRUMB_WINDOW_MS)
    recordActiveTerminalTabAutoMoveBreadcrumb(move)
    expect(recordRendererCrashBreadcrumb.mock.calls.at(-1)?.[1]).toMatchObject({
      reason: 'active-terminal-repair',
      fallback: 'first-tab',
      suppressedSinceLast: 3
    })
  })
})
