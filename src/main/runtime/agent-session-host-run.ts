import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { AgentSessionOwnerHostRun } from '../../shared/agent-session-record'
import { readLinuxPidNamespace } from '../agent-hooks/managed-hook-owner-identity'
import { isProcessPidPresent } from './agent-session-process-identity-probe'

/** This Orca process run; a lease stamp adds the fence the run granted. */
export type AgentSessionHostRun = Omit<AgentSessionOwnerHostRun, 'fence'>

let current: Promise<AgentSessionHostRun> | undefined

export function currentAgentSessionHostRun(): Promise<AgentSessionHostRun> {
  current ??= readAgentSessionHostRun()
  return current
}

async function readAgentSessionHostRun(): Promise<AgentSessionHostRun> {
  let machine = `${process.platform}:${hostname()}`
  if (process.platform === 'linux') {
    // Why: containers on one host share a hostname but not a pid space.
    const namespace = await readLinuxPidNamespace(process.pid)
    machine = namespace ? `${machine}:${namespace}` : machine
  }
  return { runId: randomUUID(), pid: process.pid, machine }
}

export function stampAgentSessionHostRun(
  run: AgentSessionHostRun,
  fence: number
): AgentSessionOwnerHostRun {
  return { runId: run.runId, pid: run.pid, machine: run.machine, fence }
}

/**
 * True only when the stamped run is not this one and is proven gone. A reused pid under a new run
 * id — a container's pid 1 — is this process, so the stamped run ended. Anything short of ESRCH
 * leaves the run possibly alive.
 */
export function agentSessionHostRunEnded(
  stamp: AgentSessionOwnerHostRun,
  run: AgentSessionHostRun,
  isPidPresent: (pid: number) => boolean
): boolean {
  return stamp.runId !== run.runId && (stamp.pid === run.pid || !isPidPresent(stamp.pid))
}

/** One answer per pid for the length of one reconcile. */
export function memoizeAgentSessionPidPresence(
  isPidPresent: (pid: number) => boolean = isProcessPidPresent
): (pid: number) => boolean {
  const answers = new Map<number, boolean>()
  return (pid) => {
    let present = answers.get(pid)
    if (present === undefined) {
      present = isPidPresent(pid)
      answers.set(pid, present)
    }
    return present
  }
}
