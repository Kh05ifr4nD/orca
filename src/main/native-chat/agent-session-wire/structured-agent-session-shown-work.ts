// Whether a structured session is doing work, asked the one way the product answers it.
//
// The status feed publishes the lead's journal status beside the provider's live background roster,
// and the store ingest folds the two into the row the sidebar shows. Every host decision that turns
// on "is this session working" — keeping an unheld session alive, marking it at teardown — composes
// the same two inputs through the same fold, so none can keep or offer a different set of sessions
// than the one the user saw working.

import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-background-task-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'

export function structuredAgentSessionShowsWork(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  backgroundTasks: readonly AgentSessionBackgroundTask[] | null | undefined
): boolean {
  const status = projectStructuredAgentSessionStatus(journal.items, journal.submissions)
  return (
    structuredAgentSessionAgentStatus({
      status,
      ...(backgroundTasks ? { backgroundTasks: [...backgroundTasks] } : {})
    }).state !== 'done'
  )
}
