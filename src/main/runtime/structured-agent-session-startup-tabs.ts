// Which chat tabs a restarted host publishes, decided from durable state alone.

import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

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
