import { describe, expect, it } from 'vitest'
import { resumeActivityLabel } from './native-chat-resume-activity-label'

describe('resumeActivityLabel', () => {
  it('says nothing for an offer from a host that recorded no activity', () => {
    expect(resumeActivityLabel(undefined)).toBeNull()
  })

  it('names a lead that was mid-reply', () => {
    expect(resumeActivityLabel({ midReply: true, prompts: [], tasks: [] })?.summary).toBe(
      'Was mid-reply'
    )
  })

  // The prompt is what the user was being asked, so it replaces the mid-reply wording.
  it('names the prompt a waiting chat lost', () => {
    expect(
      resumeActivityLabel({
        midReply: true,
        prompts: [{ kind: 'approval', label: 'Bash' }],
        tasks: []
      })?.summary
    ).toBe('Waiting for your approval: Bash')
  })

  it('tells subagents apart from monitoring, as the sidebar does', () => {
    expect(
      resumeActivityLabel({
        midReply: false,
        prompts: [],
        tasks: [
          { kind: 'agent', label: 'Review loop 4' },
          { kind: 'command', label: 'Watch CI' }
        ]
      })
    ).toEqual({
      summary: 'Subagent running: Review loop 4 · Monitoring: Watch CI',
      detail: 'Review loop 4\nWatch CI'
    })
  })

  it('counts several of a kind instead of naming them', () => {
    expect(
      resumeActivityLabel({
        midReply: false,
        prompts: [],
        tasks: [
          { kind: 'agent', label: 'One' },
          { kind: 'agent', label: 'Two' },
          { kind: 'monitor', label: '' },
          { kind: 'workflow', label: 'Deploy' }
        ]
      })?.summary
    ).toBe('2 subagents running · Monitoring 2 background tasks')
  })
})
