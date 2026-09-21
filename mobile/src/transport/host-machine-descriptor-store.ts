import type { StoredHostProfile } from './types'

export function createHostMachineDescriptorUpdater(
  mutateStoredHosts: (update: (hosts: StoredHostProfile[]) => StoredHostProfile[]) => Promise<void>
): (
  hostId: string,
  descriptor: {
    machineName: string | null
    machinePlatform: NodeJS.Platform | null
    seenAt: number
  }
) => Promise<void> {
  return (hostId, descriptor) =>
    mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((host) => host.id === hostId)
      if (index === -1) {
        return hosts
      }
      const next = hosts.slice()
      const current = next[index]!
      next[index] = {
        ...current,
        ...(descriptor.machineName
          ? { machineName: descriptor.machineName }
          : { machineName: undefined }),
        ...(descriptor.machinePlatform
          ? { machinePlatform: descriptor.machinePlatform }
          : { machinePlatform: undefined }),
        machineDescriptorSeenAt: descriptor.seenAt
      }
      return next
    })
}
