import { pruneAgentSessionOperationRows } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionLease, AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { agentSessionReconciliationTargetMatches } from './agent-session-reconciliation-target'
import { applyAgentSessionRestartAdjudication } from './agent-session-restart-lease-transitions'
import {
  agentSessionHostRunEnded,
  memoizeAgentSessionPidPresence,
  type AgentSessionHostRun
} from './agent-session-host-run'

export type AgentSessionRestartProbeArgs = {
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: number
  /** False only when the pid is proven absent; defaults to a signal-0 probe. */
  isPidPresent?: (pid: number) => boolean
}

type RestartProbe = { record: AgentSessionRecord; probe: AgentSessionOwnerProbe }

/** Previous-run leases are adjudicated without a probe; every other lease is probed. */
export type AgentSessionPreviousAppRunTest = (record: AgentSessionRecord) => boolean

/**
 * A native owner is a child of the run that granted its fence, so it ended with that run once the
 * run is gone. A TUI owner lives in the terminal daemon, a lease without a current stamp was
 * granted by a build that kept none, and another machine's pid means nothing here: all are probed.
 */
function agentSessionLeaseEndedWithPreviousAppRun(
  lease: AgentSessionLease,
  current: {
    hostId: string
    hostRun: AgentSessionHostRun
    isPidPresent: (pid: number) => boolean
  }
): boolean {
  const stamp = lease.ownerHostRun
  return (
    lease.runtimeKind === 'native' &&
    stamp !== undefined &&
    stamp.fence === lease.runtimeFence &&
    stamp.machine === current.hostRun.machine &&
    // A reservation has no owner process yet.
    (lease.ownerProcess === null || lease.ownerProcess.hostId === current.hostId) &&
    agentSessionHostRunEnded(stamp, current.hostRun, current.isPidPresent)
  )
}

/** The test for one reconcile: each stamped pid is asked about once. */
export function agentSessionPreviousAppRunTest(
  hostId: string,
  hostRun: AgentSessionHostRun,
  isPidPresent?: (pid: number) => boolean
): AgentSessionPreviousAppRunTest {
  const current = { hostId, hostRun, isPidPresent: memoizeAgentSessionPidPresence(isPidPresent) }
  return (record) => agentSessionLeaseEndedWithPreviousAppRun(record.lease, current)
}

export async function collectAgentSessionRestartProbes(
  records: readonly AgentSessionRecord[],
  args: AgentSessionRestartProbeArgs,
  endedWithPreviousAppRun: AgentSessionPreviousAppRunTest = () => false
): Promise<Map<string, RestartProbe>> {
  const probes = new Map<string, RestartProbe>()
  const probed: AgentSessionRecord[] = []
  for (const record of records) {
    if (endedWithPreviousAppRun(record)) {
      probes.set(record.sessionId, { record, probe: { outcome: 'previous-app-run' } })
    } else {
      probed.push(record)
    }
  }
  const batched = args.probeMany && probed.length > 0 ? await args.probeMany(probed) : null
  for (const record of probed) {
    probes.set(record.sessionId, {
      record,
      probe:
        batched?.get(record.sessionId) ??
        (batched
          ? { outcome: 'indeterminate', reason: 'owner batch probe returned no result' }
          : await args.probe(record))
    })
  }
  return probes
}

export function applyAgentSessionRestartProbes(
  state: AgentSessionStoreState,
  probes: ReadonlyMap<string, RestartProbe>,
  now: number,
  endedWithPreviousAppRun: AgentSessionPreviousAppRunTest = () => false
): Map<string, AgentSessionRecord> {
  const reconciled = new Map<string, AgentSessionRecord>()
  for (const [sessionId, probed] of probes) {
    const record = state.records.get(sessionId)
    if (
      !record?.lease.unreconciled ||
      !agentSessionReconciliationTargetMatches(record, probed.record) ||
      // Asked again here: another writer's state may have replaced the loaded one since.
      (probed.probe.outcome === 'previous-app-run' && !endedWithPreviousAppRun(record))
    ) {
      continue
    }
    const next = applyAgentSessionRestartAdjudication({ record, probe: probed.probe, now })
    state.records.set(sessionId, next)
    reconciled.set(sessionId, next)
  }
  state.operations = pruneAgentSessionOperationRows(state.operations, now)
  return reconciled
}
