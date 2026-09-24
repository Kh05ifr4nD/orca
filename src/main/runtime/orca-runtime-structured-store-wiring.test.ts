import { describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => {
  const state: { deps: Partial<StructuredAgentSessionRuntimeDeps> | null } = { deps: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: StructuredAgentSessionRuntimeDeps) => {
    installed.deps = deps
  })
}))

import { OrcaRuntimeService } from './orca-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

/** Read through a call: a test's reset to null would otherwise narrow away the install's write. */
function installedDeps(): Partial<StructuredAgentSessionRuntimeDeps> | null {
  return installed.deps
}

describe('structured store saved-tab wiring', () => {
  it('hands the host the chat tabs the saved workspace session lists', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the saved-tab read uses only getWorkspaceSession.
    ;(runtime as unknown as { store: unknown }).store = {
      getWorkspaceSession: () => ({
        activeTabIdByWorktree: {},
        unifiedTabs: {
          'workspace-1': [
            {
              id: 'agent-session:saved-chat-1',
              entityId: 'saved-chat-1',
              contentType: 'agent-session'
            }
          ]
        }
      })
    }

    await runtime.ensureStructuredAgentSessionHost()

    expect(installedDeps()?.recordStore?.savedTabSessionIds?.()).toEqual(['saved-chat-1'])
  })
})
