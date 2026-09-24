// Which chat tabs a restarted host publishes, decided from durable state alone.

import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'

/** The durable visible-tab index when the store keeps one; a profile that predates it falls back
 *  to the agent tabs its saved workspace session still lists. */
export function structuredAgentSessionStartupTabIds(
  visibleIndex: { present: boolean; sessionIds: readonly string[] },
  workspaceSession: WorkspaceSessionState | null
): readonly string[] {
  return visibleIndex.present
    ? visibleIndex.sessionIds
    : collectSavedStructuredAgentSessionIds(workspaceSession)
}

/** False once a close has dropped the chat from a durable index; a profile without one lists all. */
export function structuredAgentSessionTabStillListed(
  host: {
    getPersistedVisibleSessionTabIndex?: () => { present: boolean; sessionIds: readonly string[] }
  } | null,
  sessionId: string
): boolean {
  const index = host?.getPersistedVisibleSessionTabIndex?.()
  return !index?.present || index.sessionIds.includes(sessionId)
}

export type StructuredAgentSessionWorkspaceCatalog = {
  /** Null when the store cannot report repos: an unknown list must not read as "every repo is gone". */
  repoIds: ReadonlySet<string> | null
  folderWorkspaceIds: ReadonlySet<string> | null
}

/** A chat whose workspace was removed is not restored, for git worktrees and folders alike. */
export function structuredAgentSessionWorkspaceExists(
  location: Pick<AgentSessionExecutionLocation, 'workspaceId' | 'workspaceKind'>,
  catalog: StructuredAgentSessionWorkspaceCatalog
): boolean {
  if (location.workspaceKind === 'folder') {
    const scope = parseWorkspaceKey(location.workspaceId)
    return (
      scope?.type !== 'folder' ||
      catalog.folderWorkspaceIds === null ||
      catalog.folderWorkspaceIds.has(scope.folderWorkspaceId)
    )
  }
  const repoId = splitWorktreeIdForFilesystem(location.workspaceId)?.repoId
  return !repoId || catalog.repoIds === null || catalog.repoIds.has(repoId)
}

export function structuredAgentSessionWorkspaceCatalog(
  store: {
    getRepos?: () => readonly { id: string }[]
    getFolderWorkspaces?: () => readonly { id: string }[]
  } | null
): StructuredAgentSessionWorkspaceCatalog {
  const repos = store?.getRepos?.()
  const folders = store?.getFolderWorkspaces?.()
  return {
    repoIds: repos ? new Set(repos.map((repo) => repo.id)) : null,
    folderWorkspaceIds: folders ? new Set(folders.map((folder) => folder.id)) : null
  }
}

export function localStructuredAgentSessionWorkspaceSession(
  store: { getWorkspaceSession?: (hostId: string) => WorkspaceSessionState | null } | null
): WorkspaceSessionState | null {
  return store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
}
