import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

type PersistedChat = {
  sessionId: string
  workspaceId: string
  workspaceKind: 'git-worktree' | 'folder'
  agent: 'codex' | 'claude'
}

/** The host's durable state as restore reads it: records by id, every provider supported. */
function persistedChats(chats: PersistedChat[] = []) {
  return {
    store: {
      getRecord: (sessionId: string) => {
        const chat = chats.find((candidate) => candidate.sessionId === sessionId)
        return chat
          ? {
              sessionId,
              provider: chat.agent,
              location: { workspaceId: chat.workspaceId, workspaceKind: chat.workspaceKind }
            }
          : null
      },
      isSessionTabVisible: () => false
    },
    adapter: { supportsCreate: () => true }
  }
}

describe('structured session cold restoration', () => {
  it('skips every heavy recovery step when no durable session store exists', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => false
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    setStructuredAgentSessionHost({ reconcileRestartLeases } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(reconcileRestartLeases).not.toHaveBeenCalled()
  })

  it('keeps historical journal parsing outside the terminal-safety fence', async () => {
    const runtime = new OrcaRuntimeService()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreReadableSessions = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    setStructuredAgentSessionHost({ reconcileRestartLeases, restoreReadableSessions } as never)

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensureHost).toHaveBeenCalledOnce()
    // Reconcile reads no census; the TUI owner recovery that does takes its own.
    expect(refresh).not.toHaveBeenCalled()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreReadableSessions).not.toHaveBeenCalled()
  })

  it('takes the TUI owner census only once the PTY provider can list daemon terminals', async () => {
    const provider = Promise.withResolvers<void>()
    const awaitLocalPtyProviderStartup = vi.fn(() => provider.promise)
    const runtime = new OrcaRuntimeService(null, undefined, { awaitLocalPtyProviderStartup })
    const refresh = vi.fn(async () => new Set<string>())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members exist on the runtime; they are protected, not absent.
    const internal = runtime as unknown as {
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      createStructuredAgentSessionRecoverTuiOwnerCallback(): (record: unknown) => Promise<unknown>
    }
    internal.refreshMobileSessionPtyRecords = refresh
    const recovery = internal.createStructuredAgentSessionRecoverTuiOwnerCallback()({
      lease: { ownerProcess: null },
      providerHandleChain: []
    })
    await Promise.resolve()
    expect(awaitLocalPtyProviderStartup).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()

    provider.resolve()

    await expect(recovery).rejects.toThrow('agent_session_identity_required')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('loads records, restores ownership, then projects tabs exactly once', async () => {
    const runtime = new OrcaRuntimeService()
    const hydrate = vi.fn()
    const refresh = vi.fn(async () => new Set<string>())
    const ensureHost = vi.fn(async () => undefined)
    const reconcileRestartLeases = vi.fn(async () => undefined)
    const restoreReadableSessions = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
        worktreeId?: string,
        options?: { allowAttachedWindow?: boolean; onlyRuntimeOwnedTerminals?: boolean }
      ): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set(['workspace-1'])
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = hydrate
    internal.refreshMobileSessionPtyRecords = refresh
    internal.ensureStructuredAgentSessionHost = ensureHost
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases,
      restoreReadableSessions,
      deps: persistedChats()
    } as never)

    const first = runtime.restoreStructuredAgentSessionTabs()
    const second = runtime.restoreStructuredAgentSessionTabs()
    expect(second).toBe(first)
    await Promise.all([first, second])
    await vi.waitFor(() => expect(restoreReadableSessions).toHaveBeenCalledOnce())

    expect(hydrate).toHaveBeenCalledWith('workspace-1', {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    expect(hydrate).toHaveBeenCalledWith()
    expect(refresh).not.toHaveBeenCalled()
    expect(reconcileRestartLeases).toHaveBeenCalledOnce()
    expect(restoreReadableSessions).toHaveBeenCalledOnce()
    expect(ensureHost).toHaveBeenCalled()
    expect(ensureHost.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileRestartLeases.mock.invocationCallOrder[0] ?? Infinity
    )
    // Tabs publish from the opened store; reconcile and the journal sweep run behind them.
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileRestartLeases.mock.invocationCallOrder[0] ?? Infinity
    )
    expect(reconcileRestartLeases.mock.invocationCallOrder[0]).toBeLessThan(
      restoreReadableSessions.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('prefers the durable visible-session index after a legacy profile drops agent tabs', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreReadableSessions = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      store: { getWorkspaceSession: () => unknown }
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.store = {
      getWorkspaceSession: () => ({
        activeRepoId: null,
        activeWorktreeId: 'workspace-1',
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { 'workspace-1': [] }
      })
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({
        present: true,
        sessionIds: ['session-survives-rollback']
      }),
      restoreReadableSessions,
      deps: persistedChats()
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    await vi.waitFor(() =>
      expect(restoreReadableSessions).toHaveBeenCalledWith(['session-survives-rollback'])
    )
  })

  it('treats an empty durable visible-session index as authoritative', async () => {
    const runtime = new OrcaRuntimeService()
    const restoreReadableSessions = vi.fn(async () => undefined)
    const internal = runtime as unknown as {
      store: { getWorkspaceSession: () => unknown }
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.store = {
      getWorkspaceSession: () => ({
        activeRepoId: null,
        activeWorktreeId: 'workspace-1',
        activeTabId: 'agent-session:closed-session',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        activeTabIdByWorktree: { 'workspace-1': 'agent-session:closed-session' },
        unifiedTabs: {
          'workspace-1': [
            {
              id: 'agent-session:closed-session',
              entityId: 'closed-session',
              groupId: 'group-1',
              worktreeId: 'workspace-1',
              contentType: 'agent-session',
              label: 'Codex Chat',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      })
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] }),
      restoreReadableSessions,
      deps: persistedChats()
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    await vi.waitFor(() => expect(restoreReadableSessions).toHaveBeenCalledWith([]))
  })

  it('normalizes a restored tab id and removes it when closed', async () => {
    const runtime = new OrcaRuntimeService()
    const closeSessionTab = vi.fn(async () => undefined)
    const closeStructuredSession = vi.fn(async () => {
      const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
      expect(snapshot.tabs.some((tab) => tab.type === 'agent-session')).toBe(false)
    })
    const setSessionTabVisibility = vi.fn(async () => undefined)
    runtime.setNotifier({ closeSessionTab } as never)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      close: closeStructuredSession,
      setSessionTabVisibility,
      getPersistedVisibleSessionTabIndex: () => ({
        present: true,
        sessionIds: ['agent-session:agent-session:restored-session']
      }),
      deps: persistedChats([
        {
          sessionId: 'agent-session:agent-session:restored-session',
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree',
          agent: 'codex'
        }
      ])
    } as never)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: 'workspace-1',
          publicationEpoch: 'renderer-restored',
          snapshotVersion: 1,
          activeGroupId: 'group-1',
          activeTabId: 'terminal-tab::leaf-1',
          activeTabType: 'terminal',
          tabGroups: [{ id: 'group-1', activeTabId: 'terminal-tab', tabOrder: ['terminal-tab'] }],
          tabs: [
            {
              type: 'terminal',
              id: 'terminal-tab::leaf-1',
              parentTabId: 'terminal-tab',
              leafId: 'leaf-1',
              title: 'Terminal',
              isActive: true
            },
            {
              type: 'terminal',
              id: 'terminal-tab::leaf-2',
              parentTabId: 'terminal-tab',
              leafId: 'leaf-2',
              title: 'Terminal',
              isActive: false
            }
          ]
        }
      ]
    })

    await runtime.restoreStructuredAgentSessionTabs()

    const restored = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(restored.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'terminal',
          id: 'terminal-tab::leaf-1'
        }),
        expect.objectContaining({
          type: 'terminal',
          id: 'terminal-tab::leaf-2'
        }),
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:restored-session',
          sessionId: 'restored-session'
        })
      ])
    )
    expect(restored.tabs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:agent-session:restored-session'
        })
      ])
    )
    expect(restored.tabGroups?.[0]?.tabOrder).toEqual([
      'terminal-tab',
      'agent-session:restored-session'
    ])

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:restored-session', {
      reason: 'user'
    })

    expect(closeSessionTab).toHaveBeenCalledWith(
      'structured-agent-session-restored-session',
      'workspace-1'
    )
    expect(closeStructuredSession).toHaveBeenCalledWith('restored-session')
    expect(setSessionTabVisibility).toHaveBeenCalledWith('restored-session', false)
    expect(setSessionTabVisibility.mock.invocationCallOrder[0]).toBeLessThan(
      closeStructuredSession.mock.invocationCallOrder[0]!
    )

    const closed = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(closed.tabs.map((tab) => tab.id)).toEqual([
      'terminal-tab::leaf-1',
      'terminal-tab::leaf-2'
    ])
    expect(closed.tabGroups?.[0]?.tabOrder).toEqual(['terminal-tab'])
  })

  it('publishes restored Claude tabs with the Claude title', async () => {
    const runtime = new OrcaRuntimeService()
    const publish = vi.spyOn(runtime, 'publishStructuredAgentSessionTab')
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore(): boolean
      getKnownWorkspaceSessionWorktreeIds(): Set<string>
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
      refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
      ensureStructuredAgentSessionHost(): Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
    internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
    internal.refreshMobileSessionPtyRecords = async () => new Set()
    internal.ensureStructuredAgentSessionHost = async () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore reads only the host members stubbed here.
    setStructuredAgentSessionHost({
      reconcileRestartLeases: async () => undefined,
      restoreReadableSessions: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({
        present: true,
        sessionIds: ['agent-session:agent-session:restored-claude']
      }),
      deps: persistedChats([
        {
          sessionId: 'agent-session:agent-session:restored-claude',
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree',
          agent: 'claude'
        }
      ])
    } as never)

    await runtime.restoreStructuredAgentSessionTabs()

    expect(publish).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'restored-claude',
      agent: 'claude',
      activate: false,
      notify: false
    })

    const restored = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(restored.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-session',
          id: 'agent-session:restored-claude',
          title: 'Claude Chat',
          agent: 'claude'
        })
      ])
    )
  })

  it('commits the host close when the renderer already removed the structured tab', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({
      closeSessionTab: vi.fn(async () => {
        throw new Error('session_tab_not_found')
      })
    } as never)
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: 'codex',
      activate: true
    })

    await runtime.closeMobileSessionTab('id:workspace-1', 'agent-session:session-1', {
      reason: 'user'
    })

    const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
    expect(snapshot.tabs).toEqual([])
  })
})
