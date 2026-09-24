// The real Claude adapter wired to a host status store, so a test drives provider frames in and
// reads the child records the host would hold.

import { expect } from 'vitest'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import type { AgentChildWorkRecord } from '../../shared/agent-status-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { buildJournalItemRow } from '../native-chat/agent-session-journal/journal-row-builders'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

export const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

type Delivery = { kind: 'journal' | 'publish' | 'evidence'; detail: string }

export async function producer() {
  const claude = fakeClaude()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: (() => {
      let minted = 0
      return () => `child-${++minted}`
    })()
  })
  const deliveries: Delivery[] = []
  /** The producer linkage the journal stamped on each child row. */
  const stamps: { providerParentRef?: string; attempt?: number }[] = []
  const evidenceLog: AgentChildWorkEvidence[][] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    onChildWorkEvidence: (sessionId, evidence) => {
      expect(sessionId).toBe('session-1')
      deliveries.push({ kind: 'evidence', detail: evidence.map((edge) => edge.type).join(',') })
      evidenceLog.push(evidence)
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
    }
  })
  // A real reducer behind the sink, so a test can project the session's own status from its rows.
  const rows = createJournalReducerState('session-1', 'epoch-1')
  let seq = 0
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => {
      deliveries.push({ kind: 'journal', detail: JSON.stringify(identity) })
      if (options?.agentId !== undefined) {
        stamps.push(options)
      }
      const linkage = agentJournalLinkageFields(options)
      applyJournalRow(
        rows,
        buildJournalItemRow({ state: rows, identity, body, seq: ++seq, fence: 7, ts: seq, linkage })
      )
    },
    appendTombstone: () => {},
    // Production's journal publication is what republishes the parent's own row.
    publish: () => deliveries.push({ kind: 'publish', detail: '' })
  }
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const send = (message: Record<string, unknown>): Delivery[] => {
    const from = deliveries.length
    claude.connections[0]!.handlers.onMessage?.(message)
    return deliveries.slice(from)
  }
  const records = (): AgentChildWorkRecord[] => store.getChildren(parent)
  const byDescription = (description: string) =>
    records().find((record) => record.description === description)
  const journalItems = () => renderJournalState(rows).items
  return { adapter, claude, store, send, records, byDescription, evidenceLog, stamps, journalItems }
}
