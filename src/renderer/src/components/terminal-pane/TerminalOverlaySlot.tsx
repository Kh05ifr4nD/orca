import { memo, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../store'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import TerminalPane from './TerminalPane'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { handleTerminalTabPtyExit } from '../terminal/terminal-tab-pty-exit'

type TerminalOverlaySlotProps = {
  terminalTabId: string
  terminalGeneration: number | undefined
  worktreeId: string
  worktreePath: string
  startupCwd: string | undefined
  groupId: string | undefined
  isWorktreeActive: boolean
  isVisible: boolean
  isActive: boolean
  activityTerminalPortal: ActivityTerminalPortalTarget | null
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  leaveWorktreeIfEmpty: () => void
}

export const TerminalOverlaySlot = memo(function TerminalOverlaySlot({
  terminalTabId,
  terminalGeneration,
  worktreeId,
  worktreePath,
  startupCwd,
  groupId,
  isWorktreeActive,
  isVisible,
  isActive,
  activityTerminalPortal,
  onFocusOwningGroup,
  consumeSuppressedPtyExit,
  leaveWorktreeIfEmpty
}: TerminalOverlaySlotProps): React.JSX.Element {
  const [shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup] = useState(
    () => useAppStore.getState().pendingStartupByTabId[terminalTabId] !== undefined
  )
  useLayoutEffect(() => {
    if (isVisible && shouldMeasureHiddenStartup) {
      setShouldMeasureHiddenStartup(false)
    }
  }, [isVisible, shouldMeasureHiddenStartup])

  const terminalPane = (
    <TerminalPane
      key={`${terminalTabId}-${terminalGeneration ?? 0}`}
      tabId={terminalTabId}
      worktreeId={worktreeId}
      cwd={startupCwd ?? worktreePath}
      isActive={isActive || activityTerminalPortal?.active === true}
      // Why: split-group changes reparent TabGroupPanel subtrees. Keeping the
      // TerminalPane mounted here preserves alt-screen TUI state while this
      // flag still lets hidden tabs throttle rendering.
      isVisible={isVisible || activityTerminalPortal !== null}
      isWorktreeActive={isWorktreeActive || activityTerminalPortal !== null}
      isolatedPaneKey={activityTerminalPortal?.paneKey ?? null}
      onPtyExit={(ptyId, exitCode) =>
        handleTerminalTabPtyExit({
          tabId: terminalTabId,
          ptyId,
          exitCode,
          consumeSuppressedPtyExit,
          onClosed: leaveWorktreeIfEmpty
        })
      }
      onCloseTab={() => {
        // Why: route through closeTerminalTab (not the raw store closeTab) so a
        // pinned tab hits the confirmation guard. The overlay's direct
        // store.closeTab was the path that closed pinned terminals silently.
        closeTerminalTab(terminalTabId, { onClosed: leaveWorktreeIfEmpty })
      }}
    />
  )

  if (activityTerminalPortal) {
    return createPortal(
      terminalPane,
      activityTerminalPortal.target,
      `activity-terminal-${terminalTabId}`
    )
  }

  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isVisible}
      measureWhileHidden={shouldMeasureHiddenStartup}
      fitTerminal
      data-terminal-overlay-tab-id={terminalTabId}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      {terminalPane}
    </RetainedPaneHost>
  )
})
