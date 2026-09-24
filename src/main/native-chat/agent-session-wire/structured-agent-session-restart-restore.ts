// What a restart owes a persisted session, and what it does NOT.
//
// It owes reconciliation — every lease loaded from disk names an owner from a process generation
// that no longer exists, and adjudicating that is startup's job. It owes an exit from any recovery
// stage the evidence now permits. And it owes a READABLE session: the journal open, history
// answerable, the tab restorable.
//
// It does not owe a provider child. This used to resume every record whose lease was `released`
// with no handoff in flight, which is the normal end state of a chat the user closed cleanly — so a
// healthy profile started an app-server per session it had ever used, in parallel, at every launch,
// with no client attached and nothing on screen. A child now exists because a surface asked for the
// session (see `structured-agent-session-holds`), not because a record survived on disk.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  restoreStructuredAgentSessionRead,
  type RestoredStructuredAgentSessionRead
} from './structured-agent-session-read-restore'

const JOURNAL_RESTORE_CONCURRENCY = 4

export type StructuredAgentSessionReadRestoreDeps = {
  store: AgentSessionRecordStore
  journalRoot: string
  reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  resolveRecovery: (sessionId: string) => Promise<unknown>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  onReadable: (sessionId: string, restored: RestoredStructuredAgentSessionRead) => void
  retrySettlement: (
    sessionId: string,
    params: RestoredStructuredAgentSessionRead['params']
  ) => Promise<boolean>
  restoreHandoff: (sessionId: string) => Promise<void>
}

/**
 * Makes one session readable: its journal open, history answerable. Never touches the handoff.
 *
 * A surface reading a persisted chat calls this alone — reading must not wait on, or run, the
 * handoff recovery below, which depends on startup's PTY census. The CALLER decides which records
 * are eligible — startup filters by `supportsRecord` before mapping, so an on-demand caller owes
 * the same check.
 */
export async function restoreStructuredAgentSessionReadPhase(
  input: StructuredAgentSessionReadRestoreDeps,
  sessionId: string
): Promise<void> {
  const unreconciled = await input.reconcile(sessionId)
  if (!unreconciled) {
    // A session latched in recovery exits here at startup, without waiting for a client.
    await input.resolveRecovery(sessionId)
  }
  await input.serialize(sessionId, async () => {
    if (input.hasSession(sessionId)) {
      // A surface that took a hold, or read it, mid-restore already opened this one.
      return
    }
    const restored = await restoreStructuredAgentSessionRead(
      input.store,
      input.journalRoot,
      sessionId
    )
    if (!restored) {
      return
    }
    input.onReadable(sessionId, restored)
    await input.retrySettlement(sessionId, restored.params)
  })
}

/** One session's whole share of the restart restore: readable, then its handoff re-proved. */
export async function restoreOneStructuredAgentSessionRead(
  input: StructuredAgentSessionReadRestoreDeps,
  sessionId: string
): Promise<void> {
  await restoreStructuredAgentSessionReadPhase(input, sessionId)
  await input.serialize(sessionId, async () => {
    // A missing or corrupt journal leaves nothing readable, and nothing to hand back.
    if (input.hasSession(sessionId)) {
      await input.restoreHandoff(sessionId)
    }
  })
}

export async function restoreStructuredAgentSessionsOnRestart(
  input: StructuredAgentSessionReadRestoreDeps & { records: AgentSessionRecord[] }
): Promise<void> {
  await mapWithConcurrency(input.records, JOURNAL_RESTORE_CONCURRENCY, ({ sessionId }) =>
    restoreOneStructuredAgentSessionRead(input, sessionId)
  )
}
