// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  subscribeStatus: vi.fn(),
  unsubscribe: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.rpc,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

// After a restart action leaves a chat failed, the user's reply in that chat must retire the status
// bar entry without the user reopening anything, and nothing may run while nothing failed.

const failure = {
  sessionId: 'a',
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'update',
  latestPrompt: 'Fix it',
  recordedAt: 1,
  failedAt: 2,
  outcome: 'refused',
  reason: 'agent_session_restart_work_superseded'
}

function summary(
  status: AgentSessionStatusSummary['status'],
  latestPrompt: string,
  updatedAt: number
): AgentSessionStatusSummary {
  return {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    status,
    latestPrompt,
    updatedAt
  }
}

function hostEmit(): (event: AgentSessionStatusEvent) => void {
  const call = mocks.subscribeStatus.mock.calls[0]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return call[1]
}

function offerReads(): number {
  return mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.restartResumable')
    .length
}

/** Lists one failed chat, then answers every later read with `later`. */
async function listFailure(later: { failed: unknown[] } = { failed: [] }): Promise<void> {
  mocks.rpc
    .mockResolvedValueOnce({ sessions: [], failed: [failure] })
    .mockResolvedValue({ sessions: [], ...later })
  await refreshNativeChatRestartOffer()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
  _resetNativeChatRestartOffer()
  resetStructuredAgentSessionStatusFeedsForTests()
})

afterEach(() => {
  _resetNativeChatRestartOffer()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.useRealTimers()
})

it('opens no status stream while nothing failed', async () => {
  mocks.rpc.mockResolvedValue({ sessions: [], failed: [] })
  await refreshNativeChatRestartOffer()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.subscribeStatus).not.toHaveBeenCalled()
})

it('re-reads once when the user replies in a failed chat, then lets the stream go', async () => {
  await listFailure()
  expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
  const later = Date.now() + 10_000
  hostEmit()({ type: 'status', session: summary('working', 'Carry on please', later) })
  hostEmit()({ type: 'status', session: summary('idle', 'Carry on please', later + 1) })
  expect(offerReads()).toBe(1)

  await vi.advanceTimersByTimeAsync(500)

  expect(offerReads()).toBe(2)
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('does not re-read for an agent streaming in a failed chat or for news older than the list', async () => {
  await listFailure({ failed: [failure] })
  const later = Date.now() + 10_000
  // Already reflected in the listing the store holds.
  hostEmit()({ type: 'snapshot', sessions: [summary('working', 'Replayed note', 1)] })
  hostEmit()({ type: 'status', session: summary('working', 'Replayed note', later) })
  await vi.advanceTimersByTimeAsync(500)
  expect(offerReads()).toBe(1)

  hostEmit()({ type: 'status', session: summary('idle', 'Replayed note', later + 1) })
  await vi.advanceTimersByTimeAsync(500)
  // Still failed, so the watch stays for the user's own reply.
  expect(offerReads()).toBe(2)
  expect(mocks.unsubscribe).not.toHaveBeenCalled()
})
