import type { AppState } from '@/store/types'
import { collectLeafIdsInOrder } from '../terminal-layout-leaf-ids'

/**
 * Whether a PTY spawned by a pane disposed before it bound should be kept for the pane's successor.
 *
 * A pane remounted mid-spawn spawns again under the same pane key, and main's pane-spawn reservation
 * hands the successor the SAME PTY; killing it from the disposed transport kills the successor's
 * shell. The PTY is ownerless only when the tab is gone, the leaf left the layout, or the worktree
 * is being deleted (teardown kills from the bound-id ledger, which never saw this id).
 */
export function shouldRetainDisposedPaneSpawn(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'deleteStateByWorktreeId'>,
  worktreeId: string,
  tabId: string,
  leafId: string
): boolean {
  if (state.deleteStateByWorktreeId?.[worktreeId]?.isDeleting) {
    return false
  }
  const tabPresent = Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === tabId)
  )
  if (!tabPresent) {
    return false
  }
  // A new single-pane tab has no layout root until its first pane binds.
  const root = state.terminalLayoutsByTabId[tabId]?.root
  return !root || collectLeafIdsInOrder(root).includes(leafId)
}
