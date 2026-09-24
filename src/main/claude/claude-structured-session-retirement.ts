import type { ClaudeReleasedChildCleanup } from './claude-released-child-cleanup'
import { settleClaudeExitedSession } from './claude-structured-session-close'
import type {
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

export type ClaudeSessionRetirementInput = {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  exits: Map<string, ClaudeSessionExit>
  cleanup: ClaudeReleasedChildCleanup
  onBackgroundTasksChanged?: ClaudeStructuredSessionAdapterDeps['onBackgroundTasksChanged']
}

function retire(input: ClaudeSessionRetirementInput, session: ClaudeSession): void {
  session.unbindReadingControl?.()
  settleClaudeExitedSession(session)
  if (session.backgroundTasks.clear()) {
    input.onBackgroundTasksChanged?.(input.sessionId, null)
  }
  input.cleanup.adopt(input.sessionId, session.connection)
}

/**
 * The host's lease release is the one decision that a child is closed. The session leaves the
 * index here, whatever its tree proof said, and any unproven descendants become cleanup that no
 * acquisition waits on. Returns the retired session so a resume can reuse its provider handle.
 */
export function retireClaudeReleasedSession(
  input: ClaudeSessionRetirementInput
): ClaudeSession | undefined {
  const session = input.sessions.get(input.sessionId)
  if (session) {
    input.sessions.delete(input.sessionId)
    retire(input, session)
  }
  const exit = input.exits.get(input.sessionId)
  if (exit) {
    input.exits.delete(input.sessionId)
    retire(input, exit.session)
  }
  return session ?? exit?.session
}

/**
 * An acquisition at a later fence than the indexed child's proves the host already released that
 * child's lease, so its tree proof is no longer a precondition. A root not yet seen to exit still
 * goes through the close ladder: a newer fence is not evidence that a process died.
 */
export function retireClaudeSessionSupersededByFence(
  input: ClaudeSessionRetirementInput & { fence: number }
): ClaudeSession | undefined {
  const indexed = input.sessions.get(input.sessionId) ?? input.exits.get(input.sessionId)?.session
  if (!indexed || indexed.fence >= input.fence || indexed.connection.exitVerdict.root === 'live') {
    return undefined
  }
  return retireClaudeReleasedSession(input)
}
