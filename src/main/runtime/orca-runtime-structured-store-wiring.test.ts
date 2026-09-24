import { describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => {
  const state: { deps: Record<string, unknown> | null } = { deps: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
    installed.deps = deps
  })
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'

const MAIN_ROOT = join(import.meta.dirname, '..')

// Why: a restart evicts every native lease it loads without a probe only while this process holds
// the profile alone; a peer sharing the store would lose its live chat to that eviction.
describe('structured store ownership wiring', () => {
  it('hands the host the userData ownership the runtime was constructed with', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService(null, undefined, { userDataOwnership: 'exclusive' })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['storeOwnership']).toBe('exclusive')
  })

  it('shares the store when the runtime was told nothing about ownership', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['storeOwnership']).toBe('shared')
  })

  it('derives the desktop ownership from its own single-instance lock', () => {
    const preflight = readFileSync(join(MAIN_ROOT, 'startup/main-process-preflight.ts'), 'utf8')
    const source = readFileSync(join(MAIN_ROOT, 'startup/main-process-runtime-service.ts'), 'utf8')

    expect(preflight).toContain('state.userDataOwnership = ownership')
    expect(source).toContain('userDataOwnership: state.userDataOwnership')
  })

  it('leaves orcad shared, since its instance lock does not exclude a desktop on the same root', () => {
    const source = readFileSync(join(MAIN_ROOT, 'orcad/orcad-entry.ts'), 'utf8')

    expect(source).not.toContain('userDataOwnership')
  })
})
