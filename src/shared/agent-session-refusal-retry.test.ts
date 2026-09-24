import { describe, expect, it } from 'vitest'
import { agentSessionRefusalOperationState } from './agent-session-refusal-retry'

describe('agentSessionRefusalOperationState', () => {
  it('settles an unreadable journal, since asking again reads the same missing or damaged file', () => {
    for (const method of ['agentSession.history', 'agentSession.subscribe']) {
      expect(agentSessionRefusalOperationState(method, 'agent_session_journal_unreadable')).toBe(
        'settled-rejected'
      )
    }
  })
})
