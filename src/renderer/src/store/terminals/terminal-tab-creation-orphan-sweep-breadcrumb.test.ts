import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

const recordActiveTerminalTabAutoMoveBreadcrumb = vi.hoisted(() => vi.fn())
vi.mock('@/lib/terminal-tab-lifecycle-breadcrumbs', () => ({
  recordActiveTerminalTabAutoMoveBreadcrumb
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

createStoreCascadesMockApi()

describe('createTab orphan sweep breadcrumb', () => {
  const wt = 'repo1::/path/wt1'
  beforeEach(() => recordActiveTerminalTabAutoMoveBreadcrumb.mockClear())

  it('records a swept tab and where focus went', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })] },
      // No unified tab and no PTY: the sweep's definition of an orphan.
      tabsByWorktree: { [wt]: [makeTab({ id: 'orphan', worktreeId: wt })] },
      activeTabIdByWorktree: { [wt]: 'orphan' },
      unifiedTabsByWorktree: {}
    })

    const created = store.getState().createTab(wt, undefined, undefined, { activate: false })

    expect(store.getState().tabsByWorktree[wt]?.map((entry) => entry.id)).toEqual([created.id])
    expect(recordActiveTerminalTabAutoMoveBreadcrumb).toHaveBeenCalledExactlyOnceWith({
      reason: 'create-tab-orphan-sweep',
      sweptCount: 1,
      fromTabId: 'orphan',
      toTabId: created.id,
      tabCount: 1
    })
  })

  it('records nothing when nothing was swept', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })] },
      unifiedTabsByWorktree: {}
    })
    store.getState().createTab(wt)
    expect(recordActiveTerminalTabAutoMoveBreadcrumb).not.toHaveBeenCalled()
  })
})
