// Which durable teardown witnesses still describe resumable work.
//
// Every clause here exists to refuse, and the bias is deliberate: a session resumed that should not
// have been spends the user's tokens and can make an agent redo destructive work it already
// finished. A session missed is an annoyance. When any input is ambiguous this answers "no".
//
// Two INDEPENDENT records must concur. The marker is teardown's word that the session was working;
// the journal is the session's word on what was cut off — its interrupted turn, the prompts
// eviction cancelled, the children it marked unverifiable. One without the other proves nothing: a
// marker whose journal shows nothing cut off is a marker for work that did not exist, and a journal
// turn with no marker is the stale-`running`-row case this whole mechanism exists to refuse.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import {
  isExpiredAgentSessionResumeMarker,
  type AgentSessionResumeFailureOutcome,
  type AgentSessionResumeMarker,
  type AgentSessionResumeTrigger,
  type AgentSessionResumeWork
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session-restart-activity'
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'

export type StructuredAgentSessionResumeCandidate = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  work: AgentSessionResumeWork
  trigger: AgentSessionResumeTrigger
  recordedAt: number
  /** The prompt the row quotes, so the user recognises the chat before resuming it. */
  latestPrompt: string
  /** Which machine ran it, so the offer carries the same host badge the sidebar shows. */
  executionHostId: AgentSessionRecord['location']['executionHostId']
  /** Git worktree or folder workspace — the surface picks its glyph from this, never from a name. */
  workspaceKind: AgentSessionRecord['location']['workspaceKind']
  /** Model in force, read from the record's acknowledged options exactly as the status feed does.
   *  Absent until the host has read them. */
  model?: string
  /** What the restart cut off, read from the journal. Optional on the wire: an older host omits it. */
  activity?: AgentSessionRestartActivity
}

/** An offer that was acted on and did not end with the agent carrying on. Same row shape as the
 *  candidate so one surface renders both, plus what went wrong and when. */
export type StructuredAgentSessionResumeFailure = StructuredAgentSessionResumeCandidate & {
  failedAt: number
  outcome: AgentSessionResumeFailureOutcome
  /** The host's or provider's refusal code, verbatim, so it can be quoted in a report. */
  reason: string
  /** Whether naming it in an action would run it again. A continuation the chat already holds, or
   *  work that has since finished, makes a retry a no-op no matter what the reason says. */
  retryable: boolean
}

export type StructuredAgentSessionResumeSetInput = {
  markers: readonly AgentSessionResumeMarker[]
  getRecord: (sessionId: string) => AgentSessionRecord | null
  supportsRecord: (record: AgentSessionRecord) => boolean
  /** The turn record with this id, state included; null when the journal holds none. Deliberately
   *  not the live-turn reader: eviction has already rewritten that turn to `interrupted`. */
  journalTurn: (sessionId: string, turnId: string) => AgentJournalTurnLifecycle | null
  /** The newest turn record, for a send whose own turn cannot be told apart from later ones. */
  newestJournalTurn: (sessionId: string) => AgentJournalTurnLifecycle | null
  /** The journalled submission with that client message id, for work that never became a turn. */
  journalSubmission: (sessionId: string, clientMessageId: string) => AgentJournalSubmission | null
  /** Whether a root turn is running, or a prompt is waiting on the user, right now. */
  liveWork: (sessionId: string) => boolean
  /** What the restart cut off besides the lead's own reply, read from the journal. */
  cutOff: (marker: AgentSessionResumeMarker, midReply: boolean) => AgentSessionRestartActivity
  /**
   * Only teardown may judge before eviction settles the stopped child. Its prompts are still
   * pending and its turn still running then, and they are the work being cut off, not newer work.
   */
  providerStopped?: boolean
  /** Teardown only: the provider still ran children when the marker was captured, and eviction
   *  clears that roster before this can read it. */
  childWorkAtStop?: boolean
  latestPrompt: (sessionId: string) => string
  latestUserItemId: (sessionId: string) => string | null
  now: number
  /**
   * Whether the lease must be free.
   *
   * `may-be-held` is used for ONE thing: deciding whether a session whose own pane already
   * re-acquired it may be settled as resumed. Every other clause still applies — relaxing this one
   * must never become a way to act on a marker the rest of the predicate rejected.
   */
  leaseState?: 'must-be-released' | 'may-be-held'
}

/** Eviction rewrites `running` -> `interrupted` and never -> `completed`, so a completed turn is
 *  finished work and one still marked `running` was never settled by anyone. */
function turnWasCutOff(turn: AgentJournalTurnLifecycle | null, providerStopped = false): boolean {
  return (
    turn !== null &&
    (turn.state === 'interrupted' ||
      turn.state === 'unverifiable' ||
      (providerStopped && turn.state === 'running'))
  )
}

/** Delivery acknowledgements do not prove turn state: provider events may arrive without one.
 * A completed or running newest turn makes interruption ambiguous, even without a matching key. */
function submissionWorkWasCutOff(
  input: StructuredAgentSessionResumeSetInput,
  sessionId: string
): boolean {
  const turn = input.newestJournalTurn(sessionId)
  // No turn row at all: nothing finished, because finishing writes one.
  // Otherwise the newest turn decides, and it decides the same way whether or not it names this
  // submission — which is exactly why the link no longer has to be proved to answer safely.
  return turn === null || turnWasCutOff(turn, input.providerStopped)
}

/** Whether the lead's own reply was cut off: its turn, found by id, or the send that had not yet
 *  become one — followed forward to its turn, including lost acknowledgements. */
function leadWorkWasCutOff(
  input: StructuredAgentSessionResumeSetInput,
  marker: AgentSessionResumeMarker
): boolean {
  if (marker.work.kind === 'turn') {
    return turnWasCutOff(input.journalTurn(marker.sessionId, marker.work.id), input.providerStopped)
  }
  const submission = input.journalSubmission(marker.sessionId, marker.work.id)
  if (submission?.clientMessageId !== marker.work.id) {
    return false
  }
  if (submission.dispatchState === 'rejected') {
    return false
  }
  return submissionWorkWasCutOff(input, marker.sessionId)
}

/**
 * The work this marker is still owed, or null when nothing is: the lead's reply, a prompt, or a
 * child the restart stopped. Before eviction settles the child, a pending prompt or a captured
 * roster stands in for the rows the settlement is about to write.
 */
function owedWork(
  input: StructuredAgentSessionResumeSetInput,
  marker: AgentSessionResumeMarker
): AgentSessionRestartActivity | null {
  const midReply = leadWorkWasCutOff(input, marker)
  if (input.providerStopped) {
    return midReply || input.liveWork(marker.sessionId) || input.childWorkAtStop === true
      ? { midReply, prompts: [], tasks: [] }
      : null
  }
  const cutOff = input.cutOff(marker, midReply)
  return midReply || cutOff.prompts.length > 0 || cutOff.tasks.length > 0 ? cutOff : null
}

export function structuredAgentSessionResumableSet(
  input: StructuredAgentSessionResumeSetInput
): StructuredAgentSessionResumeCandidate[] {
  const candidates: StructuredAgentSessionResumeCandidate[] = []
  for (const marker of input.markers) {
    if (isExpiredAgentSessionResumeMarker(marker, input.now)) {
      continue
    }
    const record = input.getRecord(marker.sessionId)
    if (!record || !input.supportsRecord(record)) {
      continue
    }
    // The lease must be free and adjudicated. A contested or still-reconciling record is somebody
    // else's to resolve, and resuming into it is how a session gets two writers.
    if (input.leaseState !== 'may-be-held' && !isResumableStructuredAgentSessionRecord(record)) {
      continue
    }
    // A conversation that FORKED since teardown is not the one we marked. Compared by identity
    // root, because a resume legitimately advances Claude's leaf and that is not a fork.
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (!head || agentSessionProviderHandleRoot(head.handle) !== marker.providerHandleRoot) {
      continue
    }
    // At teardown a pending prompt is one the marker records and eviction is about to cancel.
    // Any later one is the resumed agent asking the user now, which a continuation must not bury.
    // Newer work supersedes the offer: the user's own message, or — once eviction has settled the
    // stopped child, which interrupts every turn and cancels every prompt — anything live at all.
    // A turn the provider opened and closed on its own after the restart is neither.
    if (
      input.latestUserItemId(marker.sessionId) !== marker.latestUserItemId ||
      (!input.providerStopped && input.liveWork(marker.sessionId))
    ) {
      continue
    }
    const owed = owedWork(input, marker)
    if (!owed) {
      continue
    }
    const model = normalizeOptionalField(record.options?.model, AGENT_MODEL_MAX_LENGTH)
    candidates.push({
      sessionId: marker.sessionId,
      workspaceId: record.location.workspaceId,
      agent: record.provider,
      work: marker.work,
      trigger: marker.trigger,
      recordedAt: marker.recordedAt,
      latestPrompt: input.latestPrompt(marker.sessionId),
      executionHostId: record.location.executionHostId,
      workspaceKind: record.location.workspaceKind,
      ...(model === undefined ? {} : { model }),
      activity: owed
    })
  }
  return candidates
}
