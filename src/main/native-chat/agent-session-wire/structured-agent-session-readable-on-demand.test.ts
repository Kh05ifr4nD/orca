/**
 * Reading a persisted chat before the startup sweep reaches it.
 *
 * A restored chat pane subscribes as soon as its workspace paints, which can be long before the
 * startup sweep runs. The read opens the journal itself; the sweep still owns the handoff recovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import * as readRestore from './structured-agent-session-read-restore'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

const readable = { journal: {}, params: {}, fence: 1 } as never

function harness(options: {
  records: AgentSessionRecord[]
  visible?: { present: boolean; sessionIds: string[] }
  supports?: (record: AgentSessionRecord) => boolean
  reconcile?: (live: Map<string, unknown>) => Promise<null>
}) {
  const live = new Map<string, unknown>()
  const tasks = new StructuredAgentSessionTaskQueue()
  const onReadable = vi.fn((sessionId: string, restored: unknown) => live.set(sessionId, restored))
  const restoreHandoff = vi.fn(async () => undefined)
  const restorer = new StructuredAgentSessionReadableRestorer({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restorer reads only these three store methods.
    store: {
      getRecord: (sessionId: string) =>
        options.records.find((record) => record.sessionId === sessionId) ?? null,
      listRecords: () => options.records,
      getVisibleSessionTabIndex: () =>
        options.visible ?? {
          present: true,
          sessionIds: options.records.map((record) => record.sessionId)
        }
    } as unknown as AgentSessionRecordStore,
    journalRoot: '/journals',
    supportsRecord: options.supports ?? (() => true),
    reconcile: async () => (options.reconcile ? options.reconcile(live) : null),
    resolveRecovery: async () => undefined,
    serialize: (sessionId, task) => tasks.serialize(sessionId, task),
    hasSession: (sessionId) => live.has(sessionId),
    onReadable,
    retrySettlement: async () => true,
    restoreHandoff
  })
  return { restorer, live, tasks, onReadable, restoreHandoff }
}

function record(sessionId: string): AgentSessionRecord {
  return agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an on-demand read of a persisted chat', () => {
  beforeEach(() => {
    vi.spyOn(readRestore, 'restoreStructuredAgentSessionRead').mockResolvedValue(readable)
  })

  it('opens a visible chat without running the handoff recovery', async () => {
    const { restorer, live, restoreHandoff } = harness({ records: [record('session-1')] })

    await expect(restorer.ensureReadable('session-1')).resolves.toBe(true)

    expect(live.has('session-1')).toBe(true)
    expect(restoreHandoff).not.toHaveBeenCalled()
  })

  it('leaves the handoff to the startup sweep, which runs it exactly once', async () => {
    const { restorer, onReadable, restoreHandoff } = harness({ records: [record('session-1')] })

    await restorer.ensureReadable('session-1')
    await restorer.restore(['session-1'])

    expect(onReadable).toHaveBeenCalledOnce()
    expect(restoreHandoff).toHaveBeenCalledOnce()
    expect(readRestore.restoreStructuredAgentSessionRead).toHaveBeenCalledOnce()
  })

  it('opens the journal once when a read races the startup sweep', async () => {
    const opened = Promise.withResolvers<void>()
    vi.mocked(readRestore.restoreStructuredAgentSessionRead).mockImplementation(async () => {
      await opened.promise
      return readable
    })
    const { restorer, onReadable, restoreHandoff } = harness({ records: [record('session-1')] })

    const sweep = restorer.restore(['session-1'])
    const read = restorer.ensureReadable('session-1')
    opened.resolve()

    await expect(read).resolves.toBe(true)
    await sweep
    expect(readRestore.restoreStructuredAgentSessionRead).toHaveBeenCalledOnce()
    expect(onReadable).toHaveBeenCalledOnce()
    expect(restoreHandoff).toHaveBeenCalledOnce()
  })

  it('does not queue behind a provider start once another surface made the chat readable', async () => {
    // A hold opens the chat, then keeps the task queue for its whole provider start. A read that
    // saw the chat closed at its first check must not then wait that start out.
    const providerStart = Promise.withResolvers<void>()
    const { restorer, live, tasks } = harness({
      records: [record('session-1')],
      reconcile: async (sessions) => {
        sessions.set('session-1', readable)
        void tasks.serialize('session-1', () => providerStart.promise)
        return null
      }
    })

    try {
      await expect(restorer.ensureReadable('session-1')).resolves.toBe(true)
      expect(live.has('session-1')).toBe(true)
      expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
    } finally {
      providerStart.resolve()
    }
  })

  it('does not reopen a chat the user closed', async () => {
    // Close hides the tab before it drops the session, so a read retry landing after it must not
    // bring the chat back.
    const { restorer, live } = harness({
      records: [record('session-closed')],
      visible: { present: true, sessionIds: [] }
    })

    await expect(restorer.ensureReadable('session-closed')).resolves.toBe(false)

    expect(live.size).toBe(0)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })

  it('does not reopen a chat closed while the read was already past its visibility check', async () => {
    // Close hides the tab, then queues its eviction; a read held up in reconcile queues after it.
    const visible = { present: true, sessionIds: ['session-1'] }
    const reconciled = Promise.withResolvers<null>()
    const { restorer, live, tasks } = harness({
      records: [record('session-1')],
      visible,
      reconcile: () => reconciled.promise
    })

    const read = restorer.ensureReadable('session-1')
    visible.sessionIds = []
    const close = tasks.serialize('session-1', async () => undefined)
    reconciled.resolve(null)

    await expect(read).resolves.toBe(false)
    await close
    expect(live.size).toBe(0)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })

  it('reads any supported record when the store keeps no visible-tab index', async () => {
    const { restorer } = harness({
      records: [record('session-1')],
      visible: { present: false, sessionIds: [] }
    })

    await expect(restorer.ensureReadable('session-1')).resolves.toBe(true)
  })

  it('answers a live session without reopening it', async () => {
    const { restorer, live } = harness({ records: [], visible: { present: true, sessionIds: [] } })
    live.set('session-live', readable)

    await expect(restorer.ensureReadable('session-live')).resolves.toBe(true)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })

  it('refuses a record no adapter supports, and one this host has no record for', async () => {
    const { restorer } = harness({ records: [record('session-1')], supports: () => false })

    await expect(restorer.ensureReadable('session-1')).resolves.toBe(false)
    await expect(restorer.ensureReadable('session-absent')).resolves.toBe(false)
    expect(readRestore.restoreStructuredAgentSessionRead).not.toHaveBeenCalled()
  })
})
