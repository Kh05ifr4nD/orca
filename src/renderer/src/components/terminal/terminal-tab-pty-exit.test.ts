import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordTerminalTabPtyExitBreadcrumb = vi.hoisted(() => vi.fn())
const closeTerminalTab = vi.hoisted(() => vi.fn())
const markUnverifiedPtyLoss = vi.hoisted(() => vi.fn())
const connectionIdByWorktree = vi.hoisted((): Record<string, string | null> => ({}))

vi.mock('@/lib/terminal-tab-lifecycle-breadcrumbs', () => ({ recordTerminalTabPtyExitBreadcrumb }))
vi.mock('./terminal-tab-actions', () => ({ closeTerminalTab }))
vi.mock('../terminal-pane/terminal-parked-tab-watchers', () => ({
  shouldDeferParkedPtyExitTabClose: () => false
}))
vi.mock('@/store/terminals/terminal-workspace-routing', () => ({
  getRemoteConnectionIdForWorktree: (_state: unknown, worktreeId: string) =>
    connectionIdByWorktree[worktreeId] ?? null,
  worktreeUsesWslPath: () => false
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: { 'wt-ssh': [{ id: 'tab-2', worktreeId: 'wt-ssh' }] },
      markUnverifiedPtyLoss
    })
  }
}))

import { handleTerminalTabPtyExit } from './terminal-tab-pty-exit'

describe('handleTerminalTabPtyExit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionIdByWorktree['wt-ssh'] = 'ssh-conn'
  })

  it('records a proven exit on an SSH tab before closing it', () => {
    handleTerminalTabPtyExit({
      tabId: 'tab-2',
      ptyId: 'ssh-conn@@pty-7',
      exitCode: 0,
      consumeSuppressedPtyExit: () => false
    })
    expect(recordTerminalTabPtyExitBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'closed', hostKind: 'ssh', synthetic: false })
    )
    expect(closeTerminalTab).toHaveBeenCalledWith('tab-2', {
      reason: 'pty-exit',
      lifecyclePtyId: 'ssh-conn@@pty-7'
    })
  })

  it('keeps the tab on the host-loss sentinel and records it as synthetic', () => {
    handleTerminalTabPtyExit({
      tabId: 'tab-2',
      ptyId: 'ssh-conn@@pty-7',
      exitCode: -1,
      consumeSuppressedPtyExit: () => false
    })
    expect(recordTerminalTabPtyExitBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'kept-unverified', synthetic: true })
    )
    expect(markUnverifiedPtyLoss).toHaveBeenCalledWith('tab-2')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('records nothing for an Orca-suppressed exit', () => {
    handleTerminalTabPtyExit({
      tabId: 'tab-2',
      ptyId: 'pty',
      exitCode: 0,
      consumeSuppressedPtyExit: () => true
    })
    expect(recordTerminalTabPtyExitBreadcrumb).not.toHaveBeenCalled()
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('still closes the tab when recording the crumb throws', () => {
    recordTerminalTabPtyExitBreadcrumb.mockImplementationOnce(() => {
      throw new Error('diagnostics down')
    })
    handleTerminalTabPtyExit({
      tabId: 'tab-2',
      ptyId: 'pty',
      exitCode: 0,
      consumeSuppressedPtyExit: () => false
    })
    expect(closeTerminalTab).toHaveBeenCalled()
  })
})
