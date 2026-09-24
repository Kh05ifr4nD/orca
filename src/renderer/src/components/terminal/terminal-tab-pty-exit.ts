import { useAppStore } from '@/store'
import { isProvenProcessExit } from '../../../../shared/terminal-exit-cause'
import { locateTerminalTab } from '@/store/terminals/terminal-tab-location'
import {
  getRemoteConnectionIdForWorktree,
  worktreeUsesWslPath
} from '@/store/terminals/terminal-workspace-routing'
import {
  recordTerminalTabPtyExitBreadcrumb,
  type TerminalHostKind
} from '@/lib/terminal-tab-lifecycle-breadcrumbs'
import { closeTerminalTab } from './terminal-tab-actions'
import { shouldDeferParkedPtyExitTabClose } from '../terminal-pane/terminal-parked-tab-watchers'

function resolveTabHostKind(tabId: string): TerminalHostKind {
  const state = useAppStore.getState()
  const worktreeId = locateTerminalTab(state.tabsByWorktree, tabId)?.tab.worktreeId
  if (!worktreeId) {
    return 'local'
  }
  if (getRemoteConnectionIdForWorktree(state, worktreeId)) {
    return 'ssh'
  }
  return worktreeUsesWslPath(state, worktreeId) ? 'wsl' : 'local'
}

/** A tab's last PTY exited: close the tab only on a proven exit. */
export function handleTerminalTabPtyExit(args: {
  tabId: string
  ptyId: string
  exitCode: number | undefined
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  onClosed?: () => void
}): void {
  const { tabId, ptyId, exitCode } = args
  if (args.consumeSuppressedPtyExit(ptyId)) {
    return
  }
  const synthetic = exitCode === undefined || !isProvenProcessExit(exitCode)
  const record = (outcome: 'closed' | 'kept-unverified' | 'deferred-parked'): void => {
    try {
      recordTerminalTabPtyExitBreadcrumb({
        outcome,
        tabId,
        ptyId,
        exitCode,
        synthetic,
        hostKind: resolveTabHostKind(tabId)
      })
    } catch {
      // Diagnostics must never block the close decision.
    }
  }
  // A negative code is the host-loss sentinel, not proof that the remote process exited. Keep the
  // mounted tab for reconnect/reveal to recover.
  if (exitCode !== undefined && !isProvenProcessExit(exitCode)) {
    record('kept-unverified')
    useAppStore.getState().markUnverifiedPtyLoss(tabId)
    return
  }
  // Why: a parked multi-leaf tab has no PaneManager to promote split siblings, so closing here would
  // kill them; reveal-remount handles dead PTYs per leaf.
  if (shouldDeferParkedPtyExitTabClose(tabId, ptyId)) {
    record('deferred-parked')
    return
  }
  record('closed')
  closeTerminalTab(tabId, {
    reason: 'pty-exit',
    lifecyclePtyId: ptyId,
    ...(args.onClosed ? { onClosed: args.onClosed } : {})
  })
}
