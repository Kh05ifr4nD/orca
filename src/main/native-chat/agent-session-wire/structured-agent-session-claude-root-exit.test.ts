import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeReleasedChildCleanup } from '../../claude/claude-released-child-cleanup'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude,
  identityFor
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { evictHeldStructuredAgentSession } from './structured-agent-session-host-lifetime'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const NOW = 1_788_727_031_330
const roots: string[] = []
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const LOCATION = {
  executionHostId: 'local',
  workspaceId: 'folder-1',
  workspaceKind: 'folder',
  wslDistro: null
} as const

const IDENTITY = { ...identityFor(), hostId: 'local', workspaceId: 'folder-1' }

/** A live Claude claim evicted while its close could only observe the root leave. */
async function evictAfterRootExit(options: { exitFirst: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-root-exit-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
  const claude = fakeClaude({
    unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' }
  })
  const unverified: unknown[] = []
  const cleanup = new ClaudeReleasedChildCleanup({
    retryDelaysMs: [],
    report: (report) => unverified.push(report)
  })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: root,
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumed: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {},
    releasedChildCleanup: cleanup
  })
  const reservation = await store.reserveOwner({
    sessionId: 'session-1',
    location: LOCATION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  const fence = reservation.record.lease.runtimeFence
  const acquisition = await adapter.acquire({ identity: IDENTITY, fence, spawnToken: 'spawn-1' })
  await store.commitProcessIdentity({
    sessionId: 'session-1',
    fence,
    process: acquisition.process,
    now: NOW
  })
  await store.proveOwner({ sessionId: 'session-1', fence, link: acquisition.link, now: NOW })
  const journal = await journals.open({ identity: IDENTITY, journalDir: join(root, 'journal') })
  const close = vi.spyOn(journal, 'close')
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: 'session-1',
      clientOperationId: `${NOW}-00000000000000000000000000000001`,
      expectedRuntimeFence: fence,
      payloadFingerprint: 'create'
    },
    location: LOCATION,
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    runtimeKind: 'native',
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  }
  const sessions = new Map<string, StructuredAgentSessionHostSession>([
    [
      'session-1',
      {
        journal,
        params,
        fence,
        hasProviderChild: true,
        acquisitionGeneration: acquisition.acquisitionGeneration ?? null
      }
    ]
  ])
  const deps = { store, adapter, journalRoot: root, claimKeyId: 'key-1' }
  const runtimeState = new StructuredAgentSessionHostRuntimeState(deps)

  if (options.exitFirst) {
    claude.connections[0]!.handlers.onExit?.(new Error('provider exited'))
  }
  await evictHeldStructuredAgentSession(
    { deps, runtimeState, sessions, now: () => NOW + 30 * 60_000, forgetStatus: vi.fn() },
    'session-1'
  )
  return { adapter, claude, store, sessions, close, cleanup, unverified }
}

describe('Claude root-exit eviction', () => {
  it('releases a captured live claim after the provider root exits', async () => {
    const { adapter, store, sessions, close } = await evictAfterRootExit({ exitFirst: true })

    expect(store.getRecord('session-1')?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    expect(sessions.size).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    // The release is the close decision: the adapter keeps no session for a close to retry.
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
  })

  it.each([
    ['an orderly close', false],
    ['a provider that exited first', true]
  ])('resumes in the same run after %s left the tree unverifiable', async (_label, exitFirst) => {
    const { adapter, claude, store, cleanup, unverified } = await evictAfterRootExit({ exitFirst })
    const released = store.getRecord('session-1')!.lease
    expect(released.claimStatus).toBe('released')

    await expect(
      adapter.acquire({
        identity: IDENTITY,
        fence: released.runtimeFence + 1,
        spawnToken: 'spawn-2'
      })
    ).resolves.toMatchObject({ link: { handle: { sessionId: PROVIDER_SESSION_ID } } })
    expect(claude.connections).toHaveLength(2)

    // The old tree is reported unverified, never claimed gone, and nothing waited on it.
    await cleanup.closeAll()
    expect(unverified).toEqual([
      { sessionId: 'session-1', pid: 4321, verdict: { root: 'exited', tree: 'unverifiable' } }
    ])
  })
})
