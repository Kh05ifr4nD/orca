import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

const { restoreRead } = vi.hoisted(() => ({
  restoreRead: vi.fn()
}))

vi.mock('./structured-agent-session-read-restore', () => ({
  restoreStructuredAgentSessionRead: restoreRead
}))

import {
  restoreOneStructuredAgentSessionRead,
  restoreStructuredAgentSessionReadPhase,
  restoreStructuredAgentSessionsOnRestart,
  type StructuredAgentSessionReadRestoreDeps
} from './structured-agent-session-restart-restore'

function phaseDeps(
  overrides: Partial<StructuredAgentSessionReadRestoreDeps> = {}
): StructuredAgentSessionReadRestoreDeps {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the phase reads only getRecord; the journal read itself is mocked.
    store: { getRecord: () => ({ sessionId: 'session-1' }) } as never,
    journalRoot: '/tmp/journals',
    reconcile: async () => null,
    resolveRecovery: async () => undefined,
    serialize: async (_sessionId, task) => task(),
    hasSession: () => false,
    onReadable: () => undefined,
    retrySettlement: async () => true,
    restoreHandoff: async () => undefined,
    ...overrides
  }
}

describe('restart journal restoration', () => {
  beforeEach(() => restoreRead.mockReset())

  it('bounds historical journal parsing to four sessions at a time', async () => {
    const gate = Promise.withResolvers<void>()
    let active = 0
    let peak = 0
    restoreRead.mockImplementation(async (_store, _root, sessionId: string) => {
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      return {
        journal: {},
        params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' },
        fence: 1,
        hasProviderChild: false,
        sessionId
      }
    })
    const records = Array.from(
      { length: 12 },
      (_, index) => ({ sessionId: `session-${index}` }) as AgentSessionRecord
    )

    const restoration = restoreStructuredAgentSessionsOnRestart({
      store: {} as never,
      journalRoot: '/tmp/journals',
      records,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined,
      retrySettlement: async () => true,
      restoreHandoff: async () => undefined
    })

    await vi.waitFor(() => expect(active).toBe(4))
    expect(restoreRead).toHaveBeenCalledTimes(4)
    gate.resolve()
    await restoration

    expect(restoreRead).toHaveBeenCalledTimes(records.length)
    expect(peak).toBe(4)
  })

  it('runs pending settlement retry after recovery resolution and before handoff', async () => {
    const calls: string[] = []
    const params: AgentSessionAttachParams = {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'read-restore:session-1',
        expectedRuntimeFence: 4,
        payloadFingerprint: 'fingerprint'
      },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex' },
      runtimeKind: 'native'
    }
    restoreRead.mockResolvedValue({
      journal: {},
      params,
      fence: 4,
      hasProviderChild: false,
      acquisitionGeneration: null
    })

    await restoreOneStructuredAgentSessionRead(
      {
        store: {} as never,
        journalRoot: '/tmp/journals',
        reconcile: async () => null,
        resolveRecovery: async () => {
          calls.push('resolveRecovery')
        },
        serialize: async (_sessionId, task) => task(),
        hasSession: () => calls.includes('onReadable'),
        onReadable: () => {
          calls.push('onReadable')
        },
        retrySettlement: async (_sessionId, restoredParams) => {
          calls.push(
            restoredParams === params ? 'retrySettlement:restored-params' : 'retrySettlement'
          )
          return true
        },
        restoreHandoff: async () => {
          calls.push('restoreHandoff')
        }
      },
      'session-1'
    )

    expect(calls).toEqual([
      'resolveRecovery',
      'onReadable',
      'retrySettlement:restored-params',
      'restoreHandoff'
    ])
  })

  it('does not rerun settlement retry when a second restore finds the session already open', async () => {
    const retrySettlement = vi.fn(async () => true)
    const restoreHandoff = vi.fn(async () => undefined)
    restoreRead.mockResolvedValue({
      journal: {},
      params: {},
      fence: 4,
      hasProviderChild: false,
      acquisitionGeneration: null
    })

    await restoreOneStructuredAgentSessionRead(
      {
        store: {} as never,
        journalRoot: '/tmp/journals',
        reconcile: async () => null,
        resolveRecovery: async () => undefined,
        serialize: async (_sessionId, task) => task(),
        hasSession: () => true,
        onReadable: () => undefined,
        retrySettlement,
        restoreHandoff
      },
      'session-1'
    )

    expect(retrySettlement).not.toHaveBeenCalled()
    expect(restoreHandoff).toHaveBeenCalledOnce()
  })

  it('opens the journal on the read phase alone, never the handoff recovery', async () => {
    // The handoff re-proves a live agent terminal against startup's PTY census; a read must not
    // run it early, or wait for it.
    const live = new Set<string>()
    const restoreHandoff = vi.fn(async () => undefined)
    restoreRead.mockResolvedValue({ journal: {}, params: {}, fence: 1 })

    await restoreStructuredAgentSessionReadPhase(
      phaseDeps({
        hasSession: (sessionId) => live.has(sessionId),
        onReadable: (sessionId) => live.add(sessionId),
        restoreHandoff
      }),
      'session-1'
    )

    expect(live.has('session-1')).toBe(true)
    expect(restoreHandoff).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'journal-unreadable'] as const)(
    'skips the handoff when the journal restores nothing (%s)',
    async (outcome) => {
      const onReadable = vi.fn()
      const restoreHandoff = vi.fn(async () => undefined)
      restoreRead.mockResolvedValue(outcome)

      await restoreOneStructuredAgentSessionRead(
        phaseDeps({ onReadable, restoreHandoff }),
        'session-1'
      )

      expect(onReadable).not.toHaveBeenCalled()
      expect(restoreHandoff).not.toHaveBeenCalled()
    }
  )

  it.each(['unavailable', 'journal-unreadable'] as const)(
    'hands the read restore verdict (%s) to the surface that asked',
    async (outcome) => {
      restoreRead.mockResolvedValue(outcome)

      await expect(restoreStructuredAgentSessionReadPhase(phaseDeps(), 'session-1')).resolves.toBe(
        outcome
      )
    }
  )
})
