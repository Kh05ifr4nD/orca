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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

const MAIN_ROOT = join(import.meta.dirname, '..')

/** Read through a call: a test's reset to null would otherwise narrow away the install's write. */
function installedDeps(): Partial<StructuredAgentSessionRuntimeDeps> | null {
  return installed.deps
}

// Why: a restart evicts every native lease it loads without a probe only while this process holds
// the profile alone; a peer sharing the store would lose its live chat to that eviction.
describe('structured store ownership wiring', () => {
  it('hands the host the userData ownership the runtime was constructed with', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService(null, undefined, { userDataOwnership: 'exclusive' })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installedDeps()?.recordStore?.ownership).toBe('exclusive')
  })

  it('shares the store when the runtime was told nothing about ownership', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installedDeps()?.recordStore?.ownership).toBe('shared')
  })

  it('derives the desktop ownership from its own single-instance lock', () => {
    const preflight = readFileSync(join(MAIN_ROOT, 'startup/main-process-preflight.ts'), 'utf8')
    const source = readFileSync(join(MAIN_ROOT, 'startup/main-process-runtime-service.ts'), 'utf8')

    expect(preflight).toContain('state.userDataOwnership = ownership')
    // A dev serve run holds the lock that dev desktop runs on the same userData skip.
    expect(preflight).toContain(
      'peersSkipLock: shouldSkipSingleInstanceLock({ isDev, isServeMode: false })'
    )
    expect(source).toContain('userDataOwnership: state.userDataOwnership')
  })

  it('leaves orcad shared, since its instance lock does not exclude a desktop on the same root', () => {
    const source = readFileSync(join(MAIN_ROOT, 'orcad/orcad-entry.ts'), 'utf8')

    expect(source).not.toContain('userDataOwnership')
  })
})

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
