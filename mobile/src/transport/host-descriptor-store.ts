import { useCallback, useSyncExternalStore } from 'react'

export type HostMachineDescriptor = {
  machineName: string | null
  platform: NodeJS.Platform | null
}

// Why memory only: the host reports this on every status read, so a stored copy would only be a
// second answer that can disagree with it. Freshness is the reader's connection state.
const descriptorByHostId = new Map<string, HostMachineDescriptor>()
const listenersByHostId = new Map<string, Set<() => void>>()

/** Records every readable status reply, including one that omitted either descriptor field. */
export function recordHostDescriptor(hostId: string, descriptor: HostMachineDescriptor): void {
  const previous = descriptorByHostId.get(hostId)
  if (
    previous?.machineName === descriptor.machineName &&
    previous.platform === descriptor.platform
  ) {
    return
  }
  descriptorByHostId.set(hostId, descriptor)
  for (const listener of listenersByHostId.get(hostId) ?? []) {
    listener()
  }
}

function subscribe(hostId: string, listener: () => void): () => void {
  const listeners = listenersByHostId.get(hostId) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByHostId.set(hostId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByHostId.delete(hostId)
    }
  }
}

/** The descriptor this host last reported to this app process, or null before any read. */
export function useHostDescriptor(hostId: string | undefined): HostMachineDescriptor | null {
  const read = useCallback(
    () => (hostId ? (descriptorByHostId.get(hostId) ?? null) : null),
    [hostId]
  )
  const subscribeToHost = useCallback(
    (listener: () => void) => (hostId ? subscribe(hostId, listener) : () => {}),
    [hostId]
  )
  return useSyncExternalStore(subscribeToHost, read, read)
}

export function resetHostDescriptorStoreForTests(): void {
  descriptorByHostId.clear()
  listenersByHostId.clear()
}
