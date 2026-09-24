import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { listPersistedStructuredAgentSessionTabs } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { OrcaRuntimeService } from './orca-runtime'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import { structuredAgentSessionWorkspaceExists } from './structured-agent-session-startup-tabs'

afterEach(() => setStructuredAgentSessionHost(null))

type RuntimeInternals = {
  store: unknown
  hasPersistedStructuredAgentSessionStore(): boolean
  getKnownWorkspaceSessionWorktreeIds(): Set<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
  ensureStructuredAgentSessionHost(): Promise<void>
}

function restartedRuntime(
  options: {
    store?: unknown
    ensureHost?: () => Promise<void>
  } = {}
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  const internal = runtime as unknown as RuntimeInternals
  internal.store = options.store ?? null
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
  internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
  internal.ensureStructuredAgentSessionHost = options.ensureHost ?? (async () => undefined)
  return runtime
}

function chat(
  sessionId: string,
  workspaceId: string,
  workspaceKind: 'git-worktree' | 'folder' = 'git-worktree'
) {
  return { sessionId, workspaceId, workspaceKind, agent: 'codex' as const }
}

/** A restarted host's durable state: its visible index and the records behind it. */
function persistedHost(
  chats: ReturnType<typeof chat>[],
  options: { visible?: (sessionId: string) => boolean } = {}
) {
  return {
    // No journal has opened yet, so the host holds no loaded session to list.
    listSessionTabs: () => [],
    getPersistedVisibleSessionTabIndex: () => ({
      present: true,
      sessionIds: chats.map((entry) => entry.sessionId)
    }),
    deps: {
      store: {
        getRecord: (sessionId: string) => {
          const entry = chats.find((candidate) => candidate.sessionId === sessionId)
          return entry
            ? {
                ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
                location: {
                  executionHostId: 'local',
                  wslDistro: null,
                  workspaceId: entry.workspaceId,
                  workspaceKind: entry.workspaceKind
                }
              }
            : null
        },
        isSessionTabVisible: options.visible ?? (() => true)
      },
      adapter: { supportsCreate: () => true }
    }
  }
}

/** A saved workspace session listing these chats as tabs of one worktree. */
function savedSession(sessionIds: readonly string[]) {
  return {
    activeRepoId: null,
    activeWorktreeId: 'workspace-1',
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    unifiedTabs: {
      'workspace-1': sessionIds.map((sessionId, sortOrder) => ({
        id: `agent-session:${sessionId}`,
        entityId: sessionId,
        groupId: 'group-1',
        worktreeId: 'workspace-1',
        contentType: 'agent-session',
        label: 'Codex Chat',
        customLabel: null,
        color: null,
        sortOrder,
        createdAt: 1
      }))
    }
  }
}

let legacyDirectory: string | null = null
afterEach(async () => {
  if (legacyDirectory) {
    await rm(legacyDirectory, { recursive: true, force: true })
    legacyDirectory = null
  }
})

/** A real store written by a build that kept chat tabs only in the saved workspace session. */
async function legacyIndexProfile(saved: readonly string[]) {
  legacyDirectory = await mkdtemp(join(tmpdir(), 'orca-startup-tabs-'))
  await writeFile(
    agentSessionStorePath(legacyDirectory),
    JSON.stringify({
      schemaVersion: 2,
      hostId: 'local',
      records: Object.fromEntries(
        saved.map((sessionId) => [
          sessionId,
          agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
        ])
      ),
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    })
  )
  const store = await AgentSessionRecordStore.open({
    directory: legacyDirectory,
    hostId: 'local',
    savedTabSessionIds: () => saved
  })
  const runtime = restartedRuntime({
    store: { getRepo: () => undefined, getWorkspaceSession: () => savedSession(saved) }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore and close read only the host members stubbed here.
  setStructuredAgentSessionHost({
    listSessionTabs: () => [],
    getPersistedVisibleSessionTabIndex: () => store.getVisibleSessionTabIndex(),
    setSessionTabVisibility: (sessionId: string, visible: boolean) =>
      store.setSessionTabVisibility(sessionId, visible),
    close: async () => undefined,
    reconcileRestartLeases: async () => undefined,
    restoreReadableSessions: async () => undefined,
    deps: { store, adapter: { supportsCreate: () => true } }
  } as never)
  return { store, runtime }
}

async function publishedChatIds(runtime: OrcaRuntimeService, workspaceId: string) {
  const snapshot = await runtime.listMobileSessionTabs(`id:${workspaceId}`)
  return snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.id)
}

describe('restored chat tabs come from durable state', () => {
  it('lists every visible chat with a supported record, whether or not its journal opens', () => {
    const records = new Map<string, AgentSessionRecord>([
      [
        'kept',
        {
          ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'kept' })),
          provider: 'codex'
        }
      ],
      [
        'unsupported',
        {
          ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'unsupported' })),
          provider: 'claude'
        }
      ]
    ])

    const tabs = listPersistedStructuredAgentSessionTabs(
      {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing reads only getRecord.
        store: { getRecord: (sessionId: string) => records.get(sessionId) ?? null } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: support reads only supportsCreate.
        adapter: {
          supportsCreate: (_location: unknown, provider: string) => provider === 'codex'
        } as never
      },
      ['kept', 'unsupported', 'no-record', 'kept']
    )

    expect(tabs.map((tab) => tab.sessionId)).toEqual(['kept'])
  })

  it('publishes the tabs before reconcile or any journal has settled', async () => {
    const runtime = restartedRuntime()
    const never = new Promise<void>(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      ...persistedHost([chat('unreadable', 'workspace-1')]),
      reconcileRestartLeases: () => never,
      restoreReadableSessions: () => never
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(await publishedChatIds(runtime, 'workspace-1')).toEqual(['agent-session:unreadable'])
  })

  it('writes the visibility index only for a chat it does not already list', async () => {
    const runtime = restartedRuntime()
    const setSessionTabVisibility = vi.fn(async () => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      ...persistedHost([chat('listed', 'workspace-1'), chat('new', 'workspace-1')], {
        visible: (sessionId) => sessionId === 'listed'
      }),
      setSessionTabVisibility,
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(setSessionTabVisibility.mock.calls).toEqual([['new', true]])
  })

  it('drops a chat whose workspace is gone and keeps folder-workspace chats', async () => {
    const runtime = restartedRuntime({
      store: {
        getRepos: () => [{ id: 'repo-live' }],
        getFolderWorkspaces: () => [{ id: 'folder-live' }]
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      ...persistedHost([
        chat('in-repo', 'repo-live::/work/a'),
        chat('removed-repo', 'repo-gone::/work/b'),
        chat('in-folder', 'folder:folder-live', 'folder'),
        chat('removed-folder', 'folder:folder-gone', 'folder')
      ]),
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined
    } as never)

    const publish = vi.spyOn(runtime, 'publishStructuredAgentSessionTab')

    await runtime.restoreStructuredAgentSessionTabs()

    expect(publish.mock.calls.map(([tab]) => tab.sessionId)).toEqual(['in-repo', 'in-folder'])
  })

  it('keeps every chat when the store cannot say which workspaces exist', () => {
    const unknown = { repoIds: null, folderWorkspaceIds: null }
    expect(
      structuredAgentSessionWorkspaceExists(chat('a', 'repo::/work', 'git-worktree'), unknown)
    ).toBe(true)
    expect(structuredAgentSessionWorkspaceExists(chat('b', 'folder:f', 'folder'), unknown)).toBe(
      true
    )
  })

  it('closes a restored chat the renderer shows before startup has published it', async () => {
    const setSessionTabVisibility = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const runtime = restartedRuntime({
      ensureHost: async () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a tab close reads only these host members.
        setStructuredAgentSessionHost({
          ...persistedHost([chat('closed-early', 'workspace-1')]),
          setSessionTabVisibility,
          close
        } as never)
      }
    })

    // No host and no published tab: only the renderer's saved session is showing this chat.
    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:closed-early', {
      reason: 'user'
    })

    expect(setSessionTabVisibility).toHaveBeenCalledWith('closed-early', false)
    expect(close).toHaveBeenCalledWith('closed-early')
  })

  it('does not publish a chat whose close landed while earlier tabs were publishing', async () => {
    const runtime = restartedRuntime()
    const listed = new Set(['new', 'closed-mid'])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      ...persistedHost([chat('new', 'workspace-1'), chat('closed-mid', 'workspace-1')], {
        visible: (sessionId) => sessionId !== 'new'
      }),
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...listed] }),
      // Publishing the first tab writes the index; the user's close of the second lands meanwhile.
      setSessionTabVisibility: vi.fn(async (sessionId: string) => {
        if (sessionId === 'new') {
          listed.delete('closed-mid')
        }
      }),
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(await publishedChatIds(runtime, 'workspace-1')).toEqual(['agent-session:new'])
  })

  it.each([
    ['publishing alone', null],
    ['a close landing before publication', 'saved-chat-b']
  ])(
    'restores every saved chat on a profile whose store predates the tab index, after %s',
    async (_case, closedFirst) => {
      const saved = ['saved-chat-a', 'saved-chat-b', 'saved-chat-c']
      const { store, runtime } = await legacyIndexProfile(saved)
      if (closedFirst) {
        // The first write to the index; it must drop only its own tab.
        await runtime.closeMobileSessionTab('id:workspace-1', `agent-session:${closedFirst}`, {
          reason: 'user'
        })
      }

      await runtime.restoreStructuredAgentSessionTabs()

      const kept = saved.filter((sessionId) => sessionId !== closedFirst)
      expect(await publishedChatIds(runtime, 'workspace-1')).toEqual(
        kept.map((sessionId) => `agent-session:${sessionId}`)
      )
      expect(store.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: kept })
    }
  )

  it('runs the journal sweep again on the next restore after its reconcile failed', async () => {
    const runtime = restartedRuntime()
    const reconcileRestartLeases = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('execution_owner_reconciling'))
      .mockResolvedValue(undefined)
    const restoreReadableSessions = vi.fn(async () => undefined)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      ...persistedHost([chat('restored', 'workspace-1')]),
      reconcileRestartLeases,
      restoreReadableSessions
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()
    await vi.waitFor(() => expect(logged).toHaveBeenCalled())
    expect(restoreReadableSessions).not.toHaveBeenCalled()

    await runtime.restoreStructuredAgentSessionTabs()

    await vi.waitFor(() => expect(restoreReadableSessions).toHaveBeenCalledWith(['restored']))
    logged.mockRestore()
  })
})
