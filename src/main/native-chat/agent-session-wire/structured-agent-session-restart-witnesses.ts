// Teardown's word on which sessions were genuinely working when the app went away.
//
// Captured from the live runtime at teardown, confirmed per session once its child has stopped,
// and only then written. A marker is never derived from a persisted `running` row, which survives
// a crash and would resurrect work nobody is doing.
//
// Confirmation runs after the child's last events are journaled and before eviction settles what
// it left running, so that is where the marker takes its final work identity. Its journal cursor
// stays the capture's: the child's own close already settled rows the offer has to read.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { StructuredAgentSessionRestartCandidateReader } from './structured-agent-session-restart-candidates'
import {
  structuredAgentSessionResumeWork,
  structuredAgentSessionsWorkingAtTeardown
} from './structured-agent-session-working-at-teardown'

export type StructuredAgentSessionRestartWitnesses = {
  capture: (trigger: AgentSessionResumeTrigger) => void
  confirmStopped: (sessionId: string) => void
  record: () => Promise<void>
  /** An explicit action on the offer supersedes witnesses this host has not yet written. */
  clear: () => void
}

export function createStructuredAgentSessionRestartWitnesses(deps: {
  sessions: Parameters<typeof structuredAgentSessionsWorkingAtTeardown>[0]['sessions']
  getRecord: (sessionId: string) => AgentSessionRecord | null
  backgroundTasks: Parameters<typeof structuredAgentSessionsWorkingAtTeardown>[0]['backgroundTasks']
  derive: StructuredAgentSessionRestartCandidateReader
  capsule?: Pick<AgentSessionRecoveryCapsule, 'record'>
  teardownId: string
  now: () => number
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartWitnesses {
  let captured = new Map<string, AgentSessionResumeMarker>()
  let withChildWork: ReadonlySet<string> = new Set()
  const confirmed = new Map<string, AgentSessionResumeMarker>()
  const clear = (): void => {
    confirmed.clear()
    captured.clear()
    withChildWork = new Set()
  }
  return {
    capture: (trigger) => {
      clear()
      const capture = structuredAgentSessionsWorkingAtTeardown({
        sessions: deps.sessions,
        getRecord: deps.getRecord,
        backgroundTasks: deps.backgroundTasks,
        trigger,
        teardownId: deps.teardownId,
        now: deps.now()
      })
      captured = new Map(capture.markers.map((marker) => [marker.sessionId, marker]))
      withChildWork = capture.withChildWork
    },
    confirmStopped: (sessionId) => {
      const marker = captured.get(sessionId)
      captured.delete(sessionId)
      const journal = deps.sessions.get(sessionId)?.journal
      if (!marker || !journal) {
        return
      }
      try {
        const snapshot = journal.snapshot()
        // A send captured before its turn opened is followed to that turn, and a turn that
        // finished before the child stopped becomes the anchor it is.
        const stopped: AgentSessionResumeMarker = {
          ...marker,
          work:
            structuredAgentSessionResumeWork(snapshot.items, snapshot.submissions) ?? marker.work
        }
        const options = { providerStopped: true, childWorkAtStop: withChildWork.has(sessionId) }
        if (deps.derive([stopped], 'may-be-held', options).length === 1) {
          confirmed.set(sessionId, stopped)
        }
      } catch {
        console.warn('[structured-agent-session] recovery witness validation failed')
      }
    },
    record: async () => {
      await deps.enqueue(async () => {
        await deps.capsule?.record([...confirmed.values()], deps.now())
      })
    },
    clear
  }
}
