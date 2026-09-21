import type { StoredHostProfile } from './types'

export function createHostNameAndEndpointUpdater(
  mutateStoredHosts: (update: (hosts: StoredHostProfile[]) => StoredHostProfile[]) => Promise<void>
): (hostId: string, updates: { name?: string; endpoint?: string }) => Promise<void> {
  return (hostId, updates) =>
    mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((host) => host.id === hostId)
      if (index === -1) {
        throw new Error('Host not found')
      }
      const next = hosts.slice()
      next[index] = {
        ...next[index]!,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.endpoint !== undefined ? { endpoint: updates.endpoint } : {})
      }
      return next
    })
}
