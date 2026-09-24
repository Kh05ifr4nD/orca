import type {
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { loadJournal } from '../agent-session-journal/journal-open'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { isUnusableSqliteDatabaseError } from '../../sqlite/sqlite-read-failure'

/** `journal-unreadable`: a journal file that is not a database, which neither a read nor an attach
 *  can open. `unavailable` covers everything a later ask can change: no record, a closed tab, or a
 *  journal the pane's own hold creates or rebuilds from provider history when it attaches. */
export type StructuredAgentSessionReadability = 'readable' | 'journal-unreadable' | 'unavailable'

export type RestoredStructuredAgentSessionRead = {
  journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
  hasProviderChild: false
  acquisitionGeneration: null
}

export async function restoreStructuredAgentSessionRead(
  store: AgentSessionRecordStore,
  journalRoot: string,
  sessionId: string
): Promise<
  RestoredStructuredAgentSessionRead | Exclude<StructuredAgentSessionReadability, 'readable'>
> {
  const record = store.getRecord(sessionId)
  if (!record) {
    return 'unavailable'
  }
  const params = attachParamsForRecord(record, {
    clientOperationId: `read-restore:${record.sessionId}`,
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const journalDir = journalDirectoryFor(journalRoot, {
    workspaceId: record.location.workspaceId,
    sessionId
  })
  let loaded: ReturnType<typeof loadJournal>
  try {
    loaded = loadJournal(journalDir, sessionId)
  } catch (error) {
    if (isUnusableSqliteDatabaseError(error)) {
      return 'journal-unreadable'
    }
    throw error
  }
  // Attach keeps a damaged journal's intact prefix and rebuilds the rest from provider history, and
  // founds the journal a chat whose first attach never got that far; a read can do neither.
  if (loaded?.corrupt || (!loaded && !findJournalFileFormatRemnant(journalDir))) {
    return 'unavailable'
  }
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    journalDir,
    // Omitted, not `null`: the store reads `null` as "replay already ran and
    // found nothing" and founds a fresh epoch. In process the probe above is the
    // previous statement, so the window is zero-width; this holds the line for a
    // database another process creates in between.
    ...(loaded ? { loaded } : {})
  })
  // Read restore opens the journal and nothing else: no adapter call, so no
  // provider child. Opening it can still write — a session whose history is in
  // the old format founds its epoch and commits the row explaining that here.
  return {
    journal,
    params,
    fence: record.lease.runtimeFence,
    hasProviderChild: false,
    acquisitionGeneration: null
  }
}

export function attachParamsForRecord(
  record: AgentSessionRecord,
  input: {
    clientOperationId: string
    expectedRuntimeFence: number
    runtimeKind?: AgentSessionOwnerRuntimeKind
  }
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: record.sessionId,
      clientOperationId: input.clientOperationId,
      expectedRuntimeFence: input.expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: record.location,
    provider: record.provider,
    agent: record.provider,
    accountHome: record.accountHome,
    runtimeKind: input.runtimeKind ?? record.lease.runtimeKind
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: record.sessionId,
        fields: attachFingerprintFields(params)
      })
    }
  }
}
