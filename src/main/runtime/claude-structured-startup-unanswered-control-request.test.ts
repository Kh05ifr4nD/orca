// A Claude start has no deadline of its own, but each option write the restore replays, and
// startup's own settings read, is a control request under the ordinary request deadline. A CLI
// that answers initialize and then never answers one of those used to fault the whole session
// when that deadline fired: a start that was merely slow died with the deadline's error as its
// cause. Now the unanswered request is skipped and startup lands on the CLI's own values. Against
// the production runtime, adapter, record store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-startup-unanswered-control'
const CALLER = { callerKey: 'client-1' }
const DEADLINE_MS = 50

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

function record(host: StructuredAgentSessionHost) {
  return host.deps.store.getRecord(SESSION)
}

function statusRows(host: StructuredAgentSessionHost): string[] {
  return host
    .journalSnapshot(SESSION)
    .items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<void> {
  const body = hostTestMessage(text)
  await expect(
    host.send(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
        expectedRuntimeFence: record(host)?.lease.runtimeFence ?? 0,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      },
      body
    })
  ).resolves.toMatchObject({ ok: true })
}

describe('a Claude start whose CLI answers initialize but not a control request', () => {
  it('lands with the unanswered option write skipped, keeping the CLI value, instead of faulting at the deadline', async () => {
    claude.behave(SESSION, { optionWritesHang: true, controlTimeoutMs: DEADLINE_MS })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await claude.install()
    await expect(
      host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'sonnet' } }))
    ).resolves.toMatchObject({ ok: true })

    // The restore asked; the CLI never answered; startup went on without it.
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('set_model'))
    await vi.waitFor(
      () => expect(record(host)?.options).toEqual({ model: 'claude-sonnet-5', effort: 'high' }),
      { timeout: DEADLINE_MS * 40 }
    )
    expect(host.deps.adapter.readOptionRestoreFailures?.(SESSION)).toEqual(['model'])
    expect(record(host)?.lease.claimStatus).toBe('live')
    expect(statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)

    // The proven child takes the next message.
    await send(host, 'hello')
    await vi.waitFor(() => expect(claude.child(SESSION).calls).toContain('send'))
  })

  it("lands with effort unknown when startup's own settings read goes unanswered", async () => {
    claude.behave(SESSION, { startupSettingsReadHangs: true, controlTimeoutMs: DEADLINE_MS })
    const host = await claude.install()
    await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
      ok: true
    })

    await vi.waitFor(() => expect(record(host)?.options).toEqual({ model: 'claude-sonnet-5' }), {
      timeout: DEADLINE_MS * 40
    })
    expect(record(host)?.lease.claimStatus).toBe('live')
    expect(statusRows(host)).toEqual([])
    expect(claude.children(SESSION)).toHaveLength(1)
  })
})
