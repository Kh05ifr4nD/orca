import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { setStoredAgentSessionHandoffStage } from './agent-session-handoff-record-transitions'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import type { UserDataOwnership } from '../startup/single-instance-lock'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }

let directory: string
let counter = 0

function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter).padStart(32, '0')}`
}

/** Exclusive unless a test says otherwise: a restart of the only process on the profile. */
function open(ownership: UserDataOwnership = 'exclusive'): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local', ownership })
}

function reserve(
  store: AgentSessionRecordStore,
  overrides: Partial<AgentSessionReserveRequest> = {}
): Promise<unknown> {
  return store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  })
}

async function establishOwner(
  store: AgentSessionRecordStore,
  options: { runtimeKind?: 'native' | 'tui'; ownerHostId?: string } = {}
): Promise<AgentSessionRecord> {
  await reserve(store, { runtimeKind: options.runtimeKind ?? 'native' })
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence: 1,
    process: {
      hostId: options.ownerHostId ?? 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-a'
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId: SESSION,
    fence: 1,
    link: {
      linkId: 'link-1',
      handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: 'leaf-1' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: NOW
    },
    now: NOW
  })
}

const previousAppRunEviction = {
  runtimeFence: 2,
  claimStatus: 'released',
  ownerProcess: null,
  reservedSpawnToken: null,
  handoffStage: null,
  unreconciled: false,
  settlementRetryRequired: true,
  settlementRetryId: `restart-eviction:${SESSION}:2`,
  deathEvidence: { kind: 'previous-app-run' }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-previous-app-run-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('restart assumes a native owner ended with the previous app run', () => {
  it('evicts a live native owner without probing it', async () => {
    await establishOwner(await open())
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)
    const probeMany = vi.fn(async () => new Map<string, AgentSessionOwnerProbe>())

    await restarted.reconcileOnRestart({ probe, probeMany, now: NOW + 1_000 })

    expect(probe).not.toHaveBeenCalled()
    expect(probeMany).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject(previousAppRunEviction)
  })

  it('evicts a native reservation the host cannot attribute instead of latching recovery', async () => {
    await reserve(await open())
    const restarted = await open()
    const probe = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'no scan' }))

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).not.toHaveBeenCalled()
    // A reservation never proved a child, so there is no generation's journal work to settle.
    const {
      settlementRetryRequired: _required,
      settlementRetryId: _id,
      ...released
    } = previousAppRunEviction
    const lease = restarted.getRecord(SESSION)?.lease
    expect(lease).toMatchObject(released)
    expect(lease?.settlementRetryRequired).toBeUndefined()
  })

  it('frees a conflicted native owner so the session can be opened again', async () => {
    const first = await open()
    await establishOwner(first)
    await first.markClaimConflicted(SESSION, NOW)
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject(previousAppRunEviction)
  })

  it('stops a native owner that was preparing a handoff', async () => {
    const first = await open()
    await establishOwner(first)
    await setStoredAgentSessionHandoffStage(first, {
      sessionId: SESSION,
      fence: 1,
      stage: 'preparing',
      handoffOperationId: 'handoff-1',
      now: NOW
    })
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 2,
      handoffStage: 'old-owner-stopped',
      ownerProcess: null,
      claimStatus: 'released',
      deathEvidence: { kind: 'previous-app-run' }
    })
  })

  it('still probes a TUI owner, which the terminal daemon keeps across restarts', async () => {
    await establishOwner(await open(), { runtimeKind: 'tui' })
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'live',
      deathEvidence: null
    })
  })

  it('still probes a native owner recorded on another host', async () => {
    await establishOwner(await open(), { ownerHostId: 'ssh:build-box' })
    const restarted = await open()
    const probe = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'remote' }))

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      handoffStage: 'recovering'
    })
  })

  it('probes a native owner when another process may hold the same profile', async () => {
    // A dev run or a bypassed launch took no single-instance lock, so a live peer may own this.
    await establishOwner(await open())
    const restarted = await open('shared')
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      handoffStage: 'recovering',
      deathEvidence: null
    })
  })

  it('opens a store as shared unless its opener proves it holds the profile alone', async () => {
    await establishOwner(await open())
    const restarted = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })

    expect(probe).toHaveBeenCalledOnce()
  })

  it('probes leases from another writer once that state replaces the loaded one', async () => {
    await establishOwner(await open())
    const restarted = await open()
    // A concurrent instance on the same profile commits after this one loaded.
    await (await open()).setSessionTabVisibility(SESSION, true)
    const probe = vi.fn(async () => MATCHED)

    await restarted.reconcileOnRestart({ probe, now: NOW + 1_000 })
    expect(probe).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({ unreconciled: true })

    await restarted.reconcileOnRestart({ probe, now: NOW + 2_000 })
    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      handoffStage: 'recovering',
      deathEvidence: null
    })
  })
})

describe('death evidence kinds', () => {
  it('loads a record carrying a kind this build does not know, intact', async () => {
    const first = await open()
    await establishOwner(first)
    await first.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })
    const path = agentSessionStorePath(directory)
    const persisted = JSON.parse(await readFile(path, 'utf-8'))
    persisted.records[SESSION].lease.deathEvidence.kind = 'written-by-a-newer-build'
    await writeFile(path, JSON.stringify(persisted))

    const reopened = await open()

    expect(reopened.isSessionUnreadable(SESSION)).toBe(false)
    expect(reopened.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'written-by-a-newer-build'
    })
  })
})
