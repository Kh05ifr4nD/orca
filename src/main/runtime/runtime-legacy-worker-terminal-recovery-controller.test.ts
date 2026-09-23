import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type { LegacyWorkerRecoveryPorts } from './runtime-legacy-worker-terminal-recovery-types'

const deferredPlan: LegacyWorkerTerminalRecoveryPlan = {
  candidates: [
    {
      dispatchId: 'dispatch-1',
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: 'task-1',
      worktreeId: 'repo-1::/tmp/wt',
      terminalHandle: 'term-1',
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      processIncarnation: 'pty-1:incarnation-1',
      ptyId: 'pty-1',
      incarnationId: 'incarnation-1'
    }
  ],
  ambiguousDispatchIds: []
}

function createController(): {
  controller: RuntimeLegacyWorkerTerminalRecoveryController
  reconcile: ReturnType<typeof vi.fn>
} {
  const reconcile = vi.fn(async () => ({
    adoptedDispatchIds: [],
    exitedDispatchIds: [],
    deferredDispatchIds: []
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry timer reads only ports.reconcile.
  const ports = { reconcile } as unknown as LegacyWorkerRecoveryPorts
  return { controller: new RuntimeLegacyWorkerTerminalRecoveryController(ports), reconcile }
}

describe('RuntimeLegacyWorkerTerminalRecoveryController.dispose', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a pending retry and refuses to arm another', async () => {
    vi.useFakeTimers()
    const { controller, reconcile } = createController()
    controller.updateRetry(deferredPlan, new Set(['dispatch-1']), {})

    controller.dispose()
    controller.updateRetry(deferredPlan, new Set(['dispatch-1']), {})
    await vi.advanceTimersByTimeAsync(60_000)

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('retries a deferred worker while live', async () => {
    vi.useFakeTimers()
    const { controller, reconcile } = createController()
    controller.updateRetry(deferredPlan, new Set(['dispatch-1']), {})

    await vi.advanceTimersByTimeAsync(1_000)

    expect(reconcile).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
