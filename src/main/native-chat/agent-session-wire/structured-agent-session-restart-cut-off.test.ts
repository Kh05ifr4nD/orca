// What a restart cut off, read back from the journal rows the teardown settled — and what counts as
// newer work that supersedes the offer once it has been read.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session-restart-activity'
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
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), failedCommand(11, 'child-1')]
      })
    ).toEqual([])
  })

  it('counts a cut-off reply, not its tool calls, when the lead was mid-reply', () => {
    const [candidate] = resumableSet({
      markers: [settledLead],
      items: [at(turnItem('turn-1', 'interrupted'), 11), failedCommand(12)]
    })

    expect(candidate?.activity).toEqual({ midReply: true, prompts: [], tasks: [] })
  })

  it('offers nothing when the journal shows nothing the restart cut off', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), subagents('completed', 12)]
      })
    ).toEqual([])
  })

  // An older crash left rows unverifiable too; only this teardown's settlement is this offer's.
  it('ignores rows settled before the cursor', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 9)]
      })
    ).toEqual([])
  })

  it('reads nothing against a cursor from another journal epoch', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 12)],
        epoch: 'epoch-2'
      })
    ).toEqual([])
  })

  // THE REPORTED REFUSAL: resuming made Claude open a turn of its own to post "didn't finish
  // before the previous session ended" and close it at once. It is not live and not the user's.
  it('is not superseded by a turn the provider opened and closed after the restart', () => {
    expect(
      resumableSet({
        markers: [marker({ journalCursor: CURSOR })],
        items: [
          at(turnItem('turn-1', 'interrupted'), 11),
          at(turnItem('wake-1', 'completed', 'turn:wake-1'), 13)
        ]
      })
    ).toHaveLength(1)
  })

  it('is superseded by a newer message from the user', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [at(turnItem('turn-1', 'completed'), 5), subagents('unverifiable', 12)],
        latestUserItemId: 'user-newer'
      })
    ).toEqual([])
  })

  it('is superseded while a turn is running after the restart', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [
          at(turnItem('turn-1', 'completed'), 5),
          subagents('unverifiable', 12),
          at(turnItem('turn-2', 'running'), 13)
        ]
      })
    ).toEqual([])
  })

  // Eviction cancels every prompt it cuts off, so a pending one is the resumed agent asking now.
  it('is superseded while the resumed agent waits on the user', () => {
    expect(
      resumableSet({
        markers: [settledLead],
        items: [
          at(turnItem('turn-1', 'completed'), 5),
          subagents('unverifiable', 12),
          at(pendingApproval(), 13)
        ]
      })
    ).toEqual([])
  })

  // Teardown confirms before eviction settles the child: its prompt is still pending then.
  it('confirms a lead blocked on a prompt before eviction cancels it', () => {
    expect(
      resumableSet({
        markers: [marker()],
        items: [turnItem('turn-1', 'running'), pendingApproval()],
        providerStopped: true
      })
    ).toHaveLength(1)
  })

  it('confirms a settled lead only when capture saw its children running', () => {
    const settled = { markers: [marker()], items: [turnItem('turn-1', 'completed')] }
    expect(resumableSet({ ...settled, providerStopped: true, childWorkAtStop: true })).toHaveLength(
      1
    )
    expect(resumableSet({ ...settled, providerStopped: true })).toEqual([])
  })

  // After reattach the provider restates the rows it lost in its own words; what the offer was
  // acted on for still stands, and only the lead is re-read.
  it('keeps what an acted-on offer was admitted for after the provider restates its rows', () => {
    const admitted: AgentSessionRestartActivity = {
      midReply: false,
      prompts: [],
      tasks: [{ kind: 'command', label: 'Watch CI' }]
    }
    const restated = [at(turnItem('turn-1', 'completed'), 5), backgroundCommand('done', 14)]
    expect(resumableSet({ markers: [settledLead], items: restated })).toEqual([])
    expect(resumableSet({ markers: [settledLead], items: restated, admitted })).toHaveLength(1)
  })
})
