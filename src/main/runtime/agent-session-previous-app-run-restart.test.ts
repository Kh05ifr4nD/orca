import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  reserveStoredAgentSessionHandoffOwner,
  setStoredAgentSessionHandoffStage,
  stopStoredAgentSessionOwnerForHandoff
} from './agent-session-handoff-record-transitions'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { currentAgentSessionHostRun, type AgentSessionHostRun } from './agent-session-host-run'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }

let directory: string
let counter = 0
let runs = 0
/** Pids of runs still alive; every other stamped pid reads as gone. */
let livePids: Set<number>

function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter).padStart(32, '0')}`
}

function hostRun(overrides: Partial<AgentSessionHostRun> = {}): AgentSessionHostRun {
  runs += 1
  return { runId: `run-${runs}`, pid: 40_000 + runs, machine: 'test-os:test-box', ...overrides }
}

/** A fresh app run unless a test names one. */
function open(run: AgentSessionHostRun = hostRun()): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local', hostRun: run })
}

function reconcile(
  store: AgentSessionRecordStore,
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>,
  probeMany?: () => Promise<Map<string, AgentSessionOwnerProbe>>
): Promise<unknown> {
  return store.reconcileOnRestart({
    probe,
    probeMany,
    now: NOW + 1_000,
    isPidPresent: (pid) => livePids.has(pid)
  })
}

type PersistedLease = {
  runtimeFence?: number
  ownerHostRun?: unknown
  deathEvidence?: { kind?: string }
}

async function editPersistedLease(edit: (lease: PersistedLease) => void): Promise<void> {
  const path = agentSessionStorePath(directory)
  const persisted = JSON.parse(await readFile(path, 'utf-8'))
  edit(persisted.records[SESSION].lease)
  await writeFile(path, JSON.stringify(persisted))
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
  livePids = new Set()
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

    await reconcile(restarted, probe, probeMany)

    expect(probe).not.toHaveBeenCalled()
    expect(probeMany).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject(previousAppRunEviction)
  })

  it('evicts a native reservation the host cannot attribute instead of latching recovery', async () => {
    await reserve(await open())
    const restarted = await open()
    const probe = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'no scan' }))

    await reconcile(restarted, probe)

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

    await reconcile(restarted, probe)

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

    await reconcile(restarted, probe)

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

    await reconcile(restarted, probe)

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

    await reconcile(restarted, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      handoffStage: 'recovering'
    })
  })

  it('evicts under a new run id that reuses the stamped pid, as a restarted container does', async () => {
    const previous = hostRun({ pid: 1 })
    await establishOwner(await open(previous))
    const restarted = await open(hostRun({ pid: 1 }))
    livePids.add(1)
    const probe = vi.fn(async () => MATCHED)

    await reconcile(restarted, probe)

    expect(probe).not.toHaveBeenCalled()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject(previousAppRunEviction)
  })

  it('probes, and keeps, the live lease of a second process sharing the store', async () => {
    // A dev desktop takes no single-instance lock, so a peer on this profile may be running.
    const peerRun = hostRun()
    const peer = await open(peerRun)
    await establishOwner(peer)
    livePids.add(peerRun.pid)
    const second = await open()
    const probe = vi.fn(async () => MATCHED)

    await reconcile(second, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(second.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'live',
      deathEvidence: null
    })
    expect(peer.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('probes a lease this run granted itself', async () => {
    const run = hostRun()
    await establishOwner(await open(run))
    const reopened = await open(run)
    const probe = vi.fn(async () => MATCHED)

    await reconcile(reopened, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      deathEvidence: null
    })
  })

  it('probes a lease whose stamp names an older fence, as an older build re-reserving leaves it', async () => {
    await reserve(await open())
    // An older build keeps unknown lease fields when it moves the fence.
    await editPersistedLease((lease) => {
      lease.runtimeFence = 2
    })
    const restarted = await open()
    const probe = vi.fn(async () => ({ outcome: 'indeterminate' as const, reason: 'no scan' }))

    await reconcile(restarted, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 2,
      claimStatus: 'reserved',
      deathEvidence: null
    })
  })

  it('probes a lease an older build granted without a stamp', async () => {
    await establishOwner(await open())
    await editPersistedLease((lease) => {
      delete lease.ownerHostRun
    })
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)

    await reconcile(restarted, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      deathEvidence: null
    })
  })

  it('probes a lease stamped on another machine, whose pid means nothing here', async () => {
    await establishOwner(await open(hostRun({ machine: 'test-os:other-box' })))
    const restarted = await open()
    const probe = vi.fn(async () => MATCHED)

    await reconcile(restarted, probe)

    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 1,
      deathEvidence: null
    })
  })

  it('probes each stamped pid once per reconcile', async () => {
    const run = hostRun()
    const store = await open(run)
    await establishOwner(store)
    await reserve(store, { sessionId: 'session-bravo', spawnToken: 'spawn-b' })
    const restarted = await open()
    const isPidPresent = vi.fn(() => false)

    await restarted.reconcileOnRestart({
      probe: async () => MATCHED,
      now: NOW + 1_000,
      isPidPresent
    })

    expect(isPidPresent).toHaveBeenCalledOnce()
    expect(isPidPresent).toHaveBeenCalledWith(run.pid)
  })
})

describe('the host run a lease is stamped with', () => {
  it('names the run that granted each fence', async () => {
    const first = hostRun()
    const store = await open(first)
    await reserve(store)
    expect(store.getRecord(SESSION)?.lease.ownerHostRun).toEqual({ ...first, fence: 1 })

    const second = hostRun()
    const restarted = await open(second)
    await reconcile(restarted, async () => MATCHED)
    await reserve(restarted, { expectedFence: 2, spawnToken: 'spawn-b' })

    expect(restarted.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      ownerHostRun: { ...second, fence: 3 }
    })
  })

  it('stamps a handoff reservation with the fence it grants', async () => {
    const run = hostRun()
    const store = await open(run)
    await establishOwner(store)
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: SESSION,
      fence: 1,
      stage: 'preparing',
      handoffOperationId: 'handoff-1',
      now: NOW
    })
    await stopStoredAgentSessionOwnerForHandoff(store, {
      sessionId: SESSION,
      expectedFence: 1,
      operationId: 'handoff-1',
      now: NOW
    })
    await reserveStoredAgentSessionHandoffOwner(store, {
      sessionId: SESSION,
      expectedFence: 2,
      runtimeKind: 'native',
      spawnToken: 'spawn-b',
      operationId: 'handoff-1',
      claimKeyId: 'key-1',
      now: NOW
    })

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 3,
      ownerHostRun: { ...run, fence: 3 }
    })
  })

  it('leaves a TUI reservation unstamped, since the terminal daemon owns that process', async () => {
    const store = await open()
    await reserve(store, { runtimeKind: 'tui' })

    expect(store.getRecord(SESSION)?.lease.ownerHostRun).toBeUndefined()
  })

  it("defaults to this process's own run", async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })

    expect(store.hostRun).toEqual(await currentAgentSessionHostRun())
    expect(store.hostRun).toMatchObject({
      pid: process.pid,
      machine: expect.stringMatching(new RegExp(`^${process.platform}:`))
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
    await editPersistedLease((lease) => {
      lease.deathEvidence = { ...lease.deathEvidence, kind: 'written-by-a-newer-build' }
    })

    const reopened = await open()

    expect(reopened.isSessionUnreadable(SESSION)).toBe(false)
    expect(reopened.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'written-by-a-newer-build'
    })
  })
})
