// Reading a restored chat right after a restart, before the startup sweep has run.
//
// Run against a real host and a store reopened from disk, because the claim is about what a fresh
// process can answer: the chat pane subscribes as soon as its workspace paints, long before the
// startup sweep opens every persisted journal.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_UNATTACHED_REFUSAL_CODE } from '../../../../shared/structured-agent-session-read-refusal'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const CLIENT = {
  clientId: 'desktop-renderer',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let root: string
let host: StructuredAgentSessionHost | null = null
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let structuredNativeChatEnabled = true
let requests = 0

function hostFor(store: AgentSessionRecordStore): StructuredAgentSessionHost {
  const adapter: StructuredAgentSessionAdapter = {
    acquire,
    closeSession: async () => true,
    dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
  return new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: join(root, 'journals'),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
}

/** Creates the chat, shows or hides its tab, then quits — the state a restart finds on disk. */
async function quitWithChat(visible: boolean): Promise<void> {
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const before = hostFor(store)
  expect(await before.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).toMatchObject({
    ok: true
  })
  await before.setSessionTabVisibility(SESSION, visible)
  await before.flushAllStreamedEvents()
}

/** The restarted process: a fresh store read from disk, a host that has run no sweep. */
async function restart(): Promise<RpcDispatcher> {
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  host = hostFor(store)
  setStructuredAgentSessionHost(host)
  acquire.mockClear()
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
    ...getDefaultSettings(root),
    hostSettingOverrides: {},
    experimentalStructuredNativeChat: structuredNativeChatEnabled
  })
  return new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
}

async function call(dispatcher: RpcDispatcher, method: string, params: unknown) {
  const replies: RpcResponse[] = []
  requests += 1
  await dispatcher.dispatchStreaming(
    { id: `request-${requests}`, authToken: 'token', method, params },
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
  return replies[0]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-restart-read-'))
  resetHostTestOperationIds()
  structuredNativeChatEnabled = true
  requests = 0
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host?.flushAllStreamedEvents()
  host = null
  await rm(root, { recursive: true, force: true })
})

describe('reading a restored chat before the startup sweep', () => {
  it('subscribes to a chat the user still shows, without starting a provider', async () => {
    await quitWithChat(true)
    const dispatcher = await restart()
    expect(host?.hasSession(SESSION)).toBe(false)

    const reply = await call(dispatcher, 'agentSession.subscribe', { sessionId: SESSION })

    expect(reply).toMatchObject({ ok: true, result: { type: 'snapshot' } })
    expect(host?.hasSession(SESSION)).toBe(true)
    expect(acquire).not.toHaveBeenCalled()
  })

  it('answers history for a chat the user still shows', async () => {
    await quitWithChat(true)
    const dispatcher = await restart()

    const reply = await call(dispatcher, 'agentSession.history', {
      sessionId: SESSION,
      direction: 'tail'
    })

    expect(reply).toMatchObject({ ok: true })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('still refuses a chat the user closed', async () => {
    await quitWithChat(false)
    const dispatcher = await restart()

    for (const reply of [
      await call(dispatcher, 'agentSession.subscribe', { sessionId: SESSION }),
      await call(dispatcher, 'agentSession.history', { sessionId: SESSION, direction: 'tail' })
    ]) {
      expect(reply).toMatchObject({
        ok: false,
        error: { code: AGENT_SESSION_UNATTACHED_REFUSAL_CODE }
      })
    }
    expect(host?.hasSession(SESSION)).toBe(false)
  })

  it('opens nothing while structured chat is off', async () => {
    await quitWithChat(true)
    structuredNativeChatEnabled = false
    const dispatcher = await restart()

    const reply = await call(dispatcher, 'agentSession.subscribe', { sessionId: SESSION })

    expect(reply).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(host?.hasSession(SESSION)).toBe(false)
  })
})
