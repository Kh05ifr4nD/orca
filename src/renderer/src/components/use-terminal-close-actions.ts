import { useCallback } from 'react'
import { closeTerminalTab } from './terminal/terminal-tab-actions'
import { handleTerminalTabPtyExit } from './terminal/terminal-tab-pty-exit'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import type { TerminalCreateController } from './use-terminal-create-actions'

export function useTerminalCloseActions(controller: TerminalCreateController) {
  const { consumeSuppressedPtyExit } = controller
  const handleCloseTab = useCallback((tabId: string) => {
    closeTerminalTab(tabId)
  }, [])

  const handleCloseBrowserTab = useCallback((tabId: string) => {
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'browser-source', sourceId: tabId }
    })
  }, [])

  const handlePtyExit = useCallback(
    (tabId: string, ptyId: string, exitCode?: number) =>
      handleTerminalTabPtyExit({ tabId, ptyId, exitCode, consumeSuppressedPtyExit }),
    [consumeSuppressedPtyExit]
  )

  return { handleCloseTab, handleCloseBrowserTab, handlePtyExit }
}

export type TerminalCloseController = TerminalCreateController &
  ReturnType<typeof useTerminalCloseActions>
