import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { listPersistedStructuredAgentSessionTabs } from '../native-chat/agent-session-wire/structured-agent-session-host-tabs'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { OrcaRuntimeService } from './orca-runtime'
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

  it('clears the durable index for a chat closed before startup built the host', async () => {
    const setSessionTabVisibility = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const runtime = restartedRuntime({
      ensureHost: async () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a tab close reads only these two host members.
        setStructuredAgentSessionHost({ setSessionTabVisibility, close } as never)
      }
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'closed-early',
      agent: 'codex',
      activate: false
    })

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:closed-early', {
      reason: 'user'
    })

    expect(setSessionTabVisibility).toHaveBeenCalledWith('closed-early', false)
    expect(await publishedChatIds(runtime, 'workspace-1')).toEqual([])
  })
})
