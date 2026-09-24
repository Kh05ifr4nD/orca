// What a restart cut off, read back from the journal rows the teardown settled, for the offer's row
// to name. Display only: none of it decides whether the chat is offered.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  EPOCH,
  marker,
  NOW,
  pendingApproval,
  resumableSet,
  turnItem
} from './structured-agent-session-restart-resume-test-harness'

describe('what a restart cut off, read from the journal', () => {
  const CURSOR = { epoch: EPOCH, sequence: 10 }
  /** A marker from a build that records the journal cursor, anchored on a turn that had finished. */
  const settledLead = marker({ journalCursor: CURSOR })

  function at<T extends AgentJournalRenderItem>(item: T, sequence: number, agentId?: string): T {
    return { ...item, sequence, ...(agentId ? { agentId } : {}) }
  }

  function subagents(state: 'unverifiable' | 'completed', sequence: number) {
    return at(
      {
        itemId: 'subagents:turn-1',
        revision: 2,
        body: {
          kind: 'message',
          role: 'system',
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'turn-1',
              agents: [{ id: 'child-1', label: 'Review loop 4', state }]
            }
          ]
        },
        sequence: 0,
        observedAt: NOW
      } satisfies AgentJournalRenderItem,
      sequence
    )
  }

  function backgroundCommand(state: 'unverifiable' | 'done', sequence: number) {
    return at(
      {
        itemId: 'task:watch',
        revision: 2,
        body: {
          kind: 'message',
          role: 'system',
          blocks: [
            { type: 'background-task', taskId: 'watch', kind: 'command', label: 'Watch CI', state }
          ]
        },
        sequence: 0,
        observedAt: NOW
      } satisfies AgentJournalRenderItem,
      sequence
    )
  }

  function cancelledQuestion(sequence: number) {
    const body = pendingApproval().body
    return at(
      {
        itemId: 'question:1',
        revision: 2,
        body: {
          kind: 'question',
          question: 'Can I attach to production?',
          options: body.options,
          resolution: { ...body.resolution, state: 'cancelled' }
        },
        sequence: 0,
        observedAt: NOW
      } satisfies AgentJournalRenderItem,
      sequence
    )
  }

  function failedCommand(sequence: number, agentId?: string) {
    return at(
      {
        itemId: 'tool:1',
        revision: 2,
        body: {
          kind: 'tool-call',
          name: 'exec_command',
          input: { description: 'Deploy preview' },
          state: 'failed'
        },
        sequence: 0,
        observedAt: NOW
      } satisfies AgentJournalRenderItem,
      sequence,
      agentId
    )
  }

  // What the user hit: the lead had finished and its subagents had not.
  it('offers a settled lead whose subagents the restart stopped, naming them', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 12)]
    })

    expect(candidate?.activity).toEqual({
      midReply: false,
      prompts: [],
      tasks: [{ kind: 'agent', label: 'Review loop 4' }]
    })
  })

  it('names a background command and a cancelled prompt', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [
        at(turnItem('turn-1', 'completed'), 5),
        backgroundCommand('unverifiable', 11),
        cancelledQuestion(12)
      ]
    })

    expect(candidate?.activity).toEqual({
      midReply: false,
      prompts: [{ kind: 'question', label: 'Can I attach to production?' }],
      tasks: [{ kind: 'command', label: 'Watch CI' }]
    })
  })

  // A Codex command outlives its turn as a tool call; settlement fails it.
  it('names a root tool call the settlement failed when the lead had settled', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), failedCommand(11)]
    })

    expect(candidate?.activity?.tasks).toEqual([{ kind: 'command', label: 'Deploy preview' }])
  })

  it('leaves a subagent tool call to the subagent row that owns it', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), failedCommand(11, 'child-1')]
    })

    expect(candidate?.activity).toEqual({ midReply: false, prompts: [], tasks: [] })
  })

  it('counts a cut-off reply, not its tool calls, when the lead was mid-reply', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'interrupted'), 11), failedCommand(12)]
    })

    expect(candidate?.activity).toEqual({ midReply: true, prompts: [], tasks: [] })
  })

  // The offer was settled at teardown; a journal that names nothing just leaves the row bare.
  it('still offers the chat when the journal names nothing the restart cut off', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), subagents('completed', 12)]
    })

    expect(candidate?.activity).toEqual({ midReply: false, prompts: [], tasks: [] })
  })

  // An older crash left rows unverifiable too; only this teardown's settlement is this offer's.
  it('ignores rows settled before the cursor', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 9)]
    })

    expect(candidate?.activity?.tasks).toEqual([])
  })

  it('reads nothing against a cursor from another journal epoch, but keeps a cut-off reply', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'interrupted'), 11), subagents('unverifiable', 12)],
      epoch: 'epoch-2'
    })

    expect(candidate?.activity).toEqual({ midReply: true, prompts: [], tasks: [] })
  })

  // A send captured before its turn opened was the lead mid-reply by definition.
  it('names a send that never became a turn as mid-reply', () => {
    const [candidate] = resumableSet({
      markers: [marker({ journalCursor: CURSOR, work: { kind: 'submission', id: 'msg-1' } })],
      items: [at(turnItem('turn-0', 'completed'), 5)]
    })

    expect(candidate?.activity).toEqual({ midReply: true, prompts: [], tasks: [] })
  })

  // THE REPORTED REFUSAL: resuming made Claude open a turn of its own to post "didn't finish
  // before the previous session ended" and close it at once. Neither that turn nor one still
  // running is the user's, so neither withdraws the offer.
  it.each(['completed', 'running'] as const)(
    'is not withdrawn by a turn the provider opened after the restart (%s)',
    (state) => {
      expect(
        resumableSet({
          markers: [marker({ journalCursor: CURSOR })],
          items: [
            at(turnItem('turn-1', 'interrupted'), 11),
            at(turnItem('wake-1', state, 'turn:wake-1'), 13)
          ]
        })
      ).toHaveLength(1)
    }
  )

  it('is not withdrawn while the resumed agent waits on the user', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [
          at(turnItem('turn-1', 'completed'), 5),
          subagents('unverifiable', 12),
          at(pendingApproval(), 13)
        ]
      })
    ).toHaveLength(1)
  })

  it('is withdrawn by a newer message from the user', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 12)],
        latestUserItemId: 'user-newer'
      })
    ).toEqual([])
  })

  // Opening the chat reattaches it, and the provider restates the rows it lost in its own words.
  // The settlement's own rows still say what the restart cut off.
  it('still offers the work after the provider restates its rows', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), backgroundCommand('done', 14)],
      history: [backgroundCommand('unverifiable', 12)]
    })

    expect(candidate?.activity?.tasks).toEqual([{ kind: 'command', label: 'Watch CI' }])
  })

  it('names a stopped child once however many rows restate it', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 14)],
      history: [subagents('unverifiable', 12)]
    })

    expect(candidate?.activity?.tasks).toEqual([{ kind: 'agent', label: 'Review loop 4' }])
  })
})
