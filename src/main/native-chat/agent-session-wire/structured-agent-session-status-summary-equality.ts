// Which status-summary changes reach every session list. The summary is broadcast to remote
// subscribers too, so only a change a session list shows may re-send it.

import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { structuredStatusChildrenEqual } from './structured-agent-session-status-child-work'

export function structuredStatusSummariesEqual(
  a: AgentSessionStatusSummary,
  b: AgentSessionStatusSummary
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.status === b.status &&
    a.hostExecutionOwned === b.hostExecutionOwned &&
    a.rewindBlockedReason === b.rewindBlockedReason &&
    // Settled activity changes ranking; streaming active turns must stay quiet.
    (a.status !== 'idle' || a.updatedAt === b.updatedAt) &&
    a.latestPrompt === b.latestPrompt &&
    a.model === b.model &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.turnOutcome === b.turnOutcome &&
    agentSessionBackgroundTasksEqual(a.backgroundTasks, b.backgroundTasks) &&
    structuredStatusChildrenEqual(a.children, b.children) &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}
