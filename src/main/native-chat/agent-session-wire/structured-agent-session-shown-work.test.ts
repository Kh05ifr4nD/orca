import { describe, expect, it } from 'vitest'
import { structuredAgentSessionShowsWork } from './structured-agent-session-shown-work'
import { submission } from './structured-agent-session-restart-resume-test-harness'

describe('whether a session shows as working', () => {
  // The status feed scopes unanswered sends to the lease fence; a stale one would otherwise keep an
  // unheld session's provider alive forever while the sidebar shows it idle.
  it('does not count a send left pending under an older lease fence', () => {
    const journal = { items: [], submissions: [submission('msg-1', 'pending')] }
    expect(structuredAgentSessionShowsWork(journal, undefined, 2)).toBe(false)
    expect(structuredAgentSessionShowsWork(journal, undefined, 1)).toBe(true)
  })

  it('counts a settled lead whose monitor still runs', () => {
    const journal = { items: [], submissions: [] }
    expect(
      structuredAgentSessionShowsWork(
        journal,
        [{ id: 'watch', kind: 'monitor', description: 'Watch CI', state: 'working' }],
        1
      )
    ).toBe(true)
    expect(structuredAgentSessionShowsWork(journal, [], 1)).toBe(false)
  })
})
