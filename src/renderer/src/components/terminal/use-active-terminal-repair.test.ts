import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const recordActiveTerminalTabAutoMoveBreadcrumb = vi.hoisted(() => vi.fn())
vi.mock('@/lib/terminal-tab-lifecycle-breadcrumbs', () => ({
  recordActiveTerminalTabAutoMoveBreadcrumb
}))

import { repairActiveTerminalTab } from './use-active-terminal-repair'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('repairActiveTerminalTab breadcrumb', () => {
  beforeEach(() => recordActiveTerminalTabAutoMoveBreadcrumb.mockClear())

  it('records the automatic move and which fallback it took', () => {
    const setActiveTab = vi.fn()
    const repaired = repairActiveTerminalTab({
      activeTabType: 'terminal',
      activeTabId: 'tab-2-closed',
      activeTabIdByWorktree: { 'wt-1': 'tab-2-closed' },
      renderedActiveWorktreeId: 'wt-1',
      setActiveTab,
      tabs: [tab('tab-1')]
    })

    expect(repaired).toBe(true)
    expect(setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(recordActiveTerminalTabAutoMoveBreadcrumb).toHaveBeenCalledWith({
      reason: 'active-terminal-repair',
      fallback: 'first-tab',
      fromTabId: 'tab-2-closed',
      toTabId: 'tab-1',
      tabCount: 1
    })
  })

  it('records nothing when the active tab is still present', () => {
    repairActiveTerminalTab({
      activeTabType: 'terminal',
      activeTabId: 'tab-1',
      activeTabIdByWorktree: {},
      renderedActiveWorktreeId: 'wt-1',
      setActiveTab: vi.fn(),
      tabs: [tab('tab-1')]
    })
    expect(recordActiveTerminalTabAutoMoveBreadcrumb).not.toHaveBeenCalled()
  })
})
