import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import {
  claudeBackgroundTaskBody,
  claudeBackgroundTaskIdentity
} from '../../claude/claude-background-task-row-journal'
import {
  codexSubagentGroupBody,
  codexSubagentGroupIdentity
} from '../../codex/codex-subagent-roster'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { createTrackedJournalOpener } from './journal-store-test-open'

const EPOCH = 'epoch-1'
const GROUP_ID = 'thread-1:turn-1'
const ROSTER_ITEM = agentJournalItemKey(codexSubagentGroupIdentity(GROUP_ID))
const CHILD = { agentId: 'task-1', producerKind: 'agent' } as const

function text(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function roster(state: NativeChatSubagentEntry['state']): AgentJournalItemBody {
  return codexSubagentGroupBody(GROUP_ID, [{ id: 'a', label: 'review', state, startedAt: 1 }])
}

/** Row `seq` lands at `ts = 1_000 + seq`, so every row is newer than the last. */
function base(seq: number, linkage: AgentJournalProducerLinkage = {}) {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq, ...linkage }
}

function item(seq: number, itemId: string, body: AgentJournalItemBody, linkage = {}): JournalRow {
  return { kind: 'item', itemId, revision: seq, body, ...base(seq, linkage) }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

describe("the session's clock counts only its own agent's rows", () => {
  it.each([
    ['claude', 'claude:claude-session:child-1'],
    ['codex', 'codex:thread-child:child-turn:0']
  ])("holds on a %s subagent's rows, and resumes on the session's next own row", (_, childItem) => {
    const own = item(1, 'own-1', text('delegating'))
    const child = [
      item(2, childItem, text('reading'), CHILD),
      item(3, childItem, text('still reading'), CHILD)
    ]
    const held = fold([own, ...child])
    // Ordering still counts every row; only the clock is the session's.
    expect(held.lastSequence).toBe(3)
    expect(held.lastActivityAt).toBe(own.ts)

    const resumed = fold([own, ...child, item(4, 'own-2', text('done'))])
    expect(resumed.lastActivityAt).toBe(1_004)
  })

  it("holds on a subagent's lifecycle batch, and moves on the session's own", () => {
    const batch = (seq: number, linkage = {}): JournalRow => ({
      kind: 'lifecycle-batch',
      settlementId: `settle-${seq}`,
      mutations: [{ kind: 'item', itemId: `i-${seq}`, revision: 1, body: text('settled') }],
      ...base(seq, linkage)
    })
    expect(fold([batch(1, CHILD)]).lastActivityAt).toBe(0)
    expect(fold([batch(1)]).lastActivityAt).toBe(1_001)
  })

  it('holds on every revision of a subagent roster, which the session writes about its children', () => {
    const own = item(1, 'own-1', text('delegating'))
    const state = fold([
      own,
      item(2, ROSTER_ITEM, roster('working')),
      item(3, ROSTER_ITEM, roster('completed'))
    ])
    expect(state.lastSequence).toBe(3)
    expect(state.lastActivityAt).toBe(own.ts)
  })

  it("holds on a roster's removal, and moves on the removal of the session's own row", () => {
    const own = item(1, 'own-1', text('delegating'))
    const rosterRow = item(2, ROSTER_ITEM, roster('working'))
    const tombstone = (seq: number, itemId: string): JournalRow => ({
      kind: 'tombstone',
      itemId,
      revision: seq,
      ...base(seq)
    })
    expect(fold([own, rosterRow, tombstone(3, ROSTER_ITEM)]).lastActivityAt).toBe(own.ts)
    expect(fold([own, rosterRow, tombstone(3, 'own-1')]).lastActivityAt).toBe(1_003)
  })

  it("holds on a subagent row's removal: a tombstone names no producer, the row it removes does", () => {
    const own = item(1, 'own-1', text('delegating'))
    const child = item(2, 'child-1', text('reading'), CHILD)
    const removal: JournalRow = { kind: 'tombstone', itemId: 'child-1', revision: 3, ...base(3) }
    expect(fold([own, child, removal]).lastActivityAt).toBe(own.ts)
  })

  it('holds on a batch that only revises rosters, and moves on one that carries anything else', () => {
    const batch = (mutations: Extract<JournalRow, { kind: 'lifecycle-batch' }>['mutations']) =>
      fold([{ kind: 'lifecycle-batch', settlementId: 'settle-1', mutations, ...base(1) }])
    const rosterMutation = {
      kind: 'item' as const,
      itemId: ROSTER_ITEM,
      revision: 1,
      body: roster('unverifiable')
    }
    expect(batch([rosterMutation]).lastActivityAt).toBe(0)
    expect(
      batch([rosterMutation, { kind: 'item', itemId: 'turn', revision: 1, body: text('ended') }])
        .lastActivityAt
    ).toBe(1_001)
  })

  it("moves on the session's own system rows that are not a roster", () => {
    const status: AgentJournalItemBody = {
      kind: 'message',
      role: 'system',
      blocks: [{ type: 'text', text: 'Compacted' }]
    }
    expect(fold([item(1, 'status-1', status)]).lastActivityAt).toBe(1_001)
  })
})

describe('reopening a journal whose roster was left running', () => {
  let root: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()
  const open = () =>
    journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root,
      now: () => (clock += 1_000),
      mintEpoch: () => `epoch-${clock}`
    })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-session-clock-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('settles a live background task without dating the session to the restart', async () => {
    const live = await open()
    await live.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'watch the build' }] },
      { fence: 0 }
    )
    await live.appendItem(
      claudeBackgroundTaskIdentity('task-1'),
      claudeBackgroundTaskBody({
        type: 'background-task',
        taskId: 'task-1',
        kind: 'command',
        label: 'npm test --watch',
        state: 'working'
      }),
      { fence: 0 }
    )
    const ownClock = live.lastActivityAt()
    await live.close()

    const reopened = await open()
    // A control: the reopen DID write the task's settling revision.
    expect(reopened.snapshot().items.at(-1)?.revision).toBe(2)
    expect(reopened.lastActivityAt()).toBe(ownClock)
  })

  it('settles the roster without dating the session to the restart', async () => {
    const live = await open()
    await live.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
      { fence: 0 }
    )
    await live.appendItem(codexSubagentGroupIdentity(GROUP_ID), roster('working'), { fence: 0 })
    const ownClock = live.lastActivityAt()
    await live.close()

    const reopened = await open()
    // A control: the reopen DID write the roster's settling revision.
    expect(reopened.snapshot().items.at(-1)?.revision).toBe(2)
    expect(reopened.lastActivityAt()).toBe(ownClock)
  })
})
