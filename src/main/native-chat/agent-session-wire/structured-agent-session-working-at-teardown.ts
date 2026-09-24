// Which sessions were genuinely working when this process went away.
//
// Read off the LIVE host state, never off a persisted status field. That distinction is the whole
// safety argument: a `running` turn row left behind by an older crash is still sitting in that
// session's journal, and a rule that trusted it would hand a provider child back to work nobody is
// doing. A crashed generation leaves no entry in this map, so it can never produce a marker.
//
// "Working" is what the sidebar showed, not the lead alone: a lead mid-turn, a lead blocked on the
// user, or a settled lead whose subagents, commands or monitors were still running all count. The
// marker records only that, and where; what was cut off is read back from the journal.

import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import { latestStructuredAgentSessionUserItem } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger,
  AgentSessionResumeWork
} from '../../../shared/agent-session-resume-marker'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-background-task-wire'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from '../../../shared/structured-agent-session-live-turn'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionShowsWork } from './structured-agent-session-shown-work'

/** A send Orca journaled that the provider has neither opened a turn for nor refused. Mirrors the
 *  projection's own unanswered-dispatch rule, which is what makes that window read as `working`. */
function pendingSubmissionInFlight(
  submissions: readonly AgentJournalSubmission[]
): AgentJournalSubmission | null {
  for (let index = submissions.length - 1; index >= 0; index -= 1) {
    const submission = submissions[index]
    if (
      submission &&
      submission.recovered !== true &&
      (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown')
    ) {
      return submission
    }
  }
  return null
}

/** The work identity to record: a running turn if one exists, else the send still awaiting one. */
export function structuredAgentSessionWorkInFlight(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionResumeWork | null {
  const turnId = activeStructuredAgentSessionTurnId(items)
  if (turnId) {
    return { kind: 'turn', id: turnId }
  }
  const submission = pendingSubmissionInFlight(submissions)
  return submission ? { kind: 'submission', id: submission.clientMessageId } : null
}

/**
 * The identity a marker carries: the lead's work in flight, else its newest turn. A settled lead
 * whose children were the work anchors there, so user work after it supersedes the offer, and the
 * journal later reads that turn as finished rather than cut off.
 */
export function structuredAgentSessionResumeWork(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): AgentSessionResumeWork | null {
  const inFlight = structuredAgentSessionWorkInFlight(items, submissions)
  if (inFlight) {
    return inFlight
  }
  const newest = newestStructuredAgentSessionTurn(items)
  return newest ? { kind: 'turn', id: newest.turnId } : null
}

type WorkingCandidateSession = {
  journal: AgentSessionJournal
  /** Only this host generation's own child counts. A restored-for-reading journal has none. */
  hasProviderChild: boolean
  fence?: number
}

export type StructuredAgentSessionTeardownCapture = {
  markers: AgentSessionResumeMarker[]
  /** Sessions whose provider still ran children at capture. Eviction clears that roster before a
   *  marker is confirmed, so this is the one moment it can be read. Never persisted. */
  withChildWork: ReadonlySet<string>
}

export function structuredAgentSessionsWorkingAtTeardown(input: {
  sessions: ReadonlyMap<string, WorkingCandidateSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  /** The provider's live child roster, the same one the status feed publishes. */
  backgroundTasks: (sessionId: string) => readonly AgentSessionBackgroundTask[] | null | undefined
  trigger: AgentSessionResumeTrigger
  /** Stable teardown identity for continuation deduplication, not launch ancestry. */
  teardownId: string
  now: number
}): StructuredAgentSessionTeardownCapture {
  const markers: AgentSessionResumeMarker[] = []
  const withChildWork = new Set<string>()
  for (const [sessionId, session] of input.sessions) {
    if (!session.hasProviderChild) {
      continue
    }
    // A journal this host cannot read tells us nothing about what the turn was doing.
    if (session.journal.isReadOnly) {
      continue
    }
    const snapshot = session.journal.snapshot()
    const roster = input.backgroundTasks(sessionId)
    if (!structuredAgentSessionShowsWork(snapshot, roster, session.fence)) {
      continue
    }
    const work = structuredAgentSessionResumeWork(snapshot.items, snapshot.submissions)
    if (!work) {
      continue
    }
    const head = agentSessionProviderHandleChainHead(
      input.getRecord(sessionId)?.providerHandleChain ?? []
    )
    if (!head) {
      continue
    }
    if (agentChildWorkLiveness(roster ?? undefined) !== null) {
      withChildWork.add(sessionId)
    }
    markers.push({
      sessionId,
      work,
      latestUserItemId: latestStructuredAgentSessionUserItem(snapshot.items)?.itemId ?? null,
      recordedAt: input.now,
      trigger: input.trigger,
      teardownId: input.teardownId,
      // Root, not key: the close path advances Claude's leaf moments after this runs, and a key
      // comparison would then refuse the session forever.
      providerHandleRoot: agentSessionProviderHandleRoot(head.handle),
      // Before the stop: closing the child is itself what settles its children's rows.
      journalCursor: snapshot.cursor
    })
  }
  return { markers, withChildWork }
}
