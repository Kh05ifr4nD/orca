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
 * Retires the indexed child only when its fence is at or below the one the host no longer grants to
 * it. Two facts deliver that: an acknowledged release names its fence, and an acquisition at fence
 * F means F-1 is gone. The lease grants a later fence either after a release or over an unreleased
 * lease whose owner probe proved the recorded process dead, so neither is evidence about THIS
 * connection: a root not yet seen to exit here still goes through the close ladder. A stale
 * acknowledgement can never reach a child acquired at a newer fence.
 */
export function retireClaudeSessionReleasedThrough(
  input: ClaudeSessionRetirementInput & { releasedFence: number }
): ClaudeSession | undefined {
  const indexed = input.sessions.get(input.sessionId) ?? input.exits.get(input.sessionId)?.session
  if (
    !indexed ||
    indexed.fence > input.releasedFence ||
    indexed.connection.exitVerdict.root === 'live'
  ) {
    return undefined
  }
  return retireClaudeReleasedSession(input)
}
