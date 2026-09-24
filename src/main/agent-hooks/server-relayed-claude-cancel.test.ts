// The captured Claude cancels (see server-claude-cancel-captures.test.ts) replayed on an SSH pane:
// the hooks go through a real relay-side listener, which owns the provider records, and reach the
// desktop only as relayed payloads. The relay never learns of the cancel the desktop infers from
// Ctrl+C, so everything it restates afterwards still says the main agent is working.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { hookAt, loadCapture, type CapturedHook } from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

type SshPane = {
  relay: RelayAgentHookServer
  /** The desktop the relay forwards to; a desktop restart swaps it. */
  desktop: AgentHookServer
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(desktop: AgentHookServer): Promise<SshPane> {
  const pane: SshPane = {
    desktop,
    relay: new RelayAgentHookServer({
      endpointDir: temporaryDir('orca-relayed-cancel-'),
      token: 'relayed-cancel-token',
      forward: (envelope) => pane.desktop.ingestRemote(envelope, 'conn-1')
    }),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

async function postCaptured(pane: SshPane, hooks: CapturedHook[]): Promise<void> {
  for (const hook of hooks) {
    await pane.post(hook.payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

describe('a relayed Claude cancel with a live subagent (captured)', () => {
  const records = loadCapture('claude-cancel-subagent-hooks')
  const subagentStop = (index: number): Record<string, unknown> => ({
    ...hookAt(records, index).payload,
    hook_event_name: 'SubagentStop',
    tool_name: undefined,
    tool_input: undefined
  })

  it('does not read a restart-seeded local roster for a relayed pane', async () => {
    const userDataPath = temporaryDir('orca-relayed-cancel-restart-')
    const firstDesktop = new AgentHookServer()
    await firstDesktop.start({ env: 'production', userDataPath })
    const pane = await startSshPane(firstDesktop)
    // The main agent Stops with the child running, and the desktop restarts.
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5].map((index) => hookAt(records, index))
    )
    expect(row(firstDesktop)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    firstDesktop.flushStatusPersistSync()
    firstDesktop.stop()

    const desktop = new AgentHookServer()
    await desktop.start({ env: 'production', userDataPath })
    pane.desktop = desktop
    running.push(desktop)
    // Hydration seeds the desktop's own roster from the saved row, relayed or not.
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(true)

    // The child finishes on the remote, then a new turn starts and is cancelled.
    await pane.post(subagentStop(4))
    expect(row(desktop)).toMatchObject({ state: 'done' })
    await pane.post(hookAt(records, 7).payload)
    expect(row(desktop)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pressCtrlC(desktop)).toBe(true)

    // Why: nothing runs on the remote; the desktop's seed is not the relay's roster.
    expect(row(desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})
