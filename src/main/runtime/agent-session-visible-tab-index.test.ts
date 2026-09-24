import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'

const A = 'session-aaaa'
const B = 'session-bbbb'
const C = 'session-cccc'
const D = 'session-dddd'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-visible-tab-index-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function record(sessionId: string) {
  return agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
}

/** A store file as a build that kept chat tabs only in the saved workspace session wrote it. */
async function writeStoreFile(
  records: ReturnType<typeof record>[],
  visibleSessionIds?: string[]
): Promise<string> {
  const raw = JSON.stringify({
    schemaVersion: 2,
    hostId: 'local',
    records: Object.fromEntries(records.map((entry) => [entry.sessionId, entry])),
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {},
    ...(visibleSessionIds ? { visibleSessionIds } : {})
  })
  await writeFile(agentSessionStorePath(directory), raw)
  return raw
}

async function visibleOnDisk(): Promise<unknown> {
  return JSON.parse(await readFile(agentSessionStorePath(directory), 'utf8')).visibleSessionIds
}

function open(savedTabSessionIds: () => readonly string[]) {
  return AgentSessionRecordStore.open({ directory, hostId: 'local', savedTabSessionIds })
}

describe('a store file without a visible-tab index', () => {
  it('writes the saved tabs that have records as the index when it loads', async () => {
    await writeStoreFile([record(A), record(B)])

    const store = await open(() => [A, B, C])

    expect(await visibleOnDisk()).toEqual([A, B])
    expect(store.listVisibleSessionIds()).toEqual([A, B])
  })

  it('keeps every saved tab when a committed /clear is the first write', async () => {
    const replacement = 'session-dddd-next'
    await writeStoreFile([record(A), record(B), record(D), record(replacement)])
    const store = await open(() => [A, B, D])

    await store.setConversationCommand(D, agentSessionLeaseFixture().runtimeFence, {
      command: 'clear',
      state: 'completed',
      replacementSessionId: replacement,
      operationId: 'op-1',
      callerKey: 'caller-1',
      phase: 'committed'
    })

    expect(await visibleOnDisk()).toEqual([A, B, replacement])
  })

  it('adopts the saved tabs again when another build rewrites the file without an index', async () => {
    await writeStoreFile([record(A), record(B)])
    let saved: readonly string[] = [A, B]
    const store = await open(() => saved)
    expect(await visibleOnDisk()).toEqual([A, B])

    // A build that keeps no index rewrote the file after its user opened C and closed B.
    await writeStoreFile([record(A), record(B), record(C)])
    saved = [A, C]
    await store.setSessionTabVisibility(A, true)

    expect(store.listVisibleSessionIds()).toEqual([A, C])
    expect(await visibleOnDisk()).toEqual([A, C])
  })

  it('adopts a saved Claude chat that has a record', async () => {
    // The fixture record is a Claude session.
    await writeStoreFile([record(A)])
    const tab: Tab = {
      id: `agent-session:${A}`,
      entityId: A,
      groupId: 'group-1',
      worktreeId: 'workspace-1',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      label: 'Claude Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: 'workspace-1',
      activeTabId: tab.id,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: { 'workspace-1': [tab] },
      activeTabIdByWorktree: { 'workspace-1': tab.id }
    }

    const store = await open(() => collectSavedStructuredAgentSessionIds(session))

    expect(store.listVisibleSessionIds()).toEqual([A])
    expect(await visibleOnDisk()).toEqual([A])
  })
})

describe('a store file with a visible-tab index', () => {
  it('keeps an empty index rather than adopting the saved tabs', async () => {
    const raw = await writeStoreFile([record(A), record(B)], [])

    const store = await open(() => [A, B])

    expect(store.listVisibleSessionIds()).toEqual([])
    await expect(readFile(agentSessionStorePath(directory), 'utf8')).resolves.toBe(raw)
  })
})
