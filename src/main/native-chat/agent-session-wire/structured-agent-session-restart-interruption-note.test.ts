// The note a cut-off turn gets when Orca itself went away, asserted where clients read it: the
// subscribe snapshot and live batches, not the journal file.

import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RESTART_INTERRUPTION_NOTE,
  AGENT_SESSION_RESTART_INTERRUPTION_PRESENTATION
} from '../../../shared/agent-session-restart-interruption'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

async function runTurn(state: 'running' | 'completed'): Promise<void> {
  const previous = hostTestState()
  await attach()
  // The chat has a tab, so the pane's read after the restart is one the host serves.
  await previous.store.setSessionTabVisibility(SESSION, true)
  const events = previous.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    { kind: 'turn', turnId: 'turn-1', state }
  )
  await previous.host.flushStreamedEvents(SESSION)
}

/** A crash: the process is gone without any teardown, so nothing settled its turn. */
async function crash(host: StructuredAgentSessionHost): Promise<void> {
  host['runtimeState'].stopLeaseRenewal()
  host['holds'].dispose()
  await Promise.all([...host['sessions'].values()].map((session) => session.journal.close()))
  host['sessions'].clear()
}

async function restart(how: 'quit' | 'crash'): Promise<StructuredAgentSessionHost> {
  const previous = hostTestState()
  await (how === 'quit'
    ? previous.host.flushAllStreamedEvents({ trigger: 'quit' })
    : crash(previous.host))
  const store = await AgentSessionRecordStore.open({
    directory: join(previous.root, 'store'),
    hostId: 'local',
    ownership: 'exclusive'
  })
  const host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: previous.root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  return host
}

function notesIn(events: readonly AgentSessionSubscribeEvent[]): unknown[] {
  const items = events.flatMap((event) =>
    event.type === 'snapshot' ? event.page.items : event.type === 'batch' ? event.batch.items : []
  )
  const ids = new Set(
    items
      .filter(
        (item) =>
          item.body.kind === 'status' &&
          item.body.presentation === AGENT_SESSION_RESTART_INTERRUPTION_PRESENTATION &&
          item.body.text === AGENT_SESSION_RESTART_INTERRUPTION_NOTE
      )
      .map((item) => item.itemId)
  )
  return [...ids]
}

async function readAfterRestart(host: StructuredAgentSessionHost) {
  await host.ensureReadable(SESSION)
  const events: AgentSessionSubscribeEvent[] = []
  const dispose = host.subscribe({ id: 'pane', sessionId: SESSION, emit: (e) => events.push(e) })
  dispose()
  return events
}

it.each(['quit', 'crash'] as const)(
  'shows one restart note on a turn a %s cut off, across repeated restarts',
  async (how) => {
    await runTurn('running')

    const first = await restart(how)
    expect(notesIn(await readAfterRestart(first))).toHaveLength(1)

    const second = await restart(how)
    expect(notesIn(await readAfterRestart(second))).toHaveLength(1)
  }
)

it.each(['quit', 'crash'] as const)(
  'writes no restart note for a turn that finished before the %s',
  async (how) => {
    await runTurn('completed')

    const host = await restart(how)

    expect(notesIn(await readAfterRestart(host))).toEqual([])
  }
)

it('delivers the note to a reader that subscribed while the restore was settling the turn', async () => {
  await runTurn('running')
  const host = await restart('crash')
  const events: AgentSessionSubscribeEvent[] = []
  const publishRestored = host['clientDelivery'].publishRestored
  // The pane subscribes the moment the session becomes readable, before the settlement lands.
  vi.spyOn(host['clientDelivery'], 'publishRestored').mockImplementation((sessionId) => {
    publishRestored(sessionId)
    host.subscribe({ id: 'pane', sessionId, emit: (event) => events.push(event) })
  })

  await host.restoreReadableSessions([SESSION])

  expect(events[0]?.type).toBe('snapshot')
  expect(notesIn(events.slice(0, 1))).toEqual([])
  expect(notesIn(events)).toHaveLength(1)
})
