import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider
  }))
}

export type PersistedStructuredAgentSessionTab = StructuredAgentSessionTab & {
  workspaceKind: AgentSessionRecord['location']['workspaceKind']
}

/** Tab existence from durable state: every requested id with a record this host serves, whether or
 *  not its journal opens. A chat that cannot be read keeps its tab and explains itself there. */
export function listPersistedStructuredAgentSessionTabs(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter'>,
  sessionIds: readonly string[]
): PersistedStructuredAgentSessionTab[] {
  const tabs = new Map<string, PersistedStructuredAgentSessionTab>()
  for (const sessionId of sessionIds) {
    const record = deps.store.getRecord(sessionId)
    if (!record || tabs.has(sessionId) || !adapterSupportsRecord(deps.adapter, record)) {
      continue
    }
    tabs.set(sessionId, {
      sessionId,
      workspaceId: record.location.workspaceId,
      workspaceKind: record.location.workspaceKind,
      agent: record.provider
    })
  }
  return [...tabs.values()]
}
