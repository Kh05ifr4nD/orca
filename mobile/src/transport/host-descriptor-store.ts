import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  readPersistedHostDescriptor,
  writePersistedHostDescriptor
} from './host-descriptor-persistence'

export type HostMachineDescriptor = {
  machineName: string | null
  platform: NodeJS.Platform | null
}

export type HostDescriptorSnapshot = {
  descriptor: HostMachineDescriptor | null
  fresh: boolean
}

const descriptorByHostId = new Map<string, HostMachineDescriptor>()
const freshHostIds = new Set<string>()
const loadStartedHostIds = new Set<string>()
const adoptableLoadHostIds = new Set<string>()
const listenersByHostId = new Map<string, Set<() => void>>()
const snapshotByHostId = new Map<string, HostDescriptorSnapshot>()

function publish(hostId: string): void {
  for (const listener of listenersByHostId.get(hostId) ?? []) {
    listener()
  }
}

/** Records every readable status reply, including one that omitted either descriptor field. */
export function recordHostDescriptor(hostId: string, descriptor: HostMachineDescriptor): void {
  loadStartedHostIds.add(hostId)
  adoptableLoadHostIds.delete(hostId)
  const wasFresh = freshHostIds.has(hostId)
  freshHostIds.add(hostId)
  const previous = descriptorByHostId.get(hostId)
  if (
    previous?.machineName === descriptor.machineName &&
    previous.platform === descriptor.platform
  ) {
    if (!wasFresh) {
      publish(hostId)
    }
    return
  }
  descriptorByHostId.set(hostId, descriptor)
  publish(hostId)
  void writePersistedHostDescriptor(hostId, descriptor)
}

export function forgetHostDescriptor(hostId: string): Promise<void> {
  loadStartedHostIds.add(hostId)
  adoptableLoadHostIds.delete(hostId)
  freshHostIds.delete(hostId)
  descriptorByHostId.delete(hostId)
  publish(hostId)
  return writePersistedHostDescriptor(hostId, null)
}

function loadHostDescriptor(hostId: string): void {
  if (loadStartedHostIds.has(hostId)) {
    return
  }
  loadStartedHostIds.add(hostId)
  adoptableLoadHostIds.add(hostId)
  void readPersistedHostDescriptor(hostId).then((descriptor) => {
    if (!adoptableLoadHostIds.delete(hostId) || descriptor === null || freshHostIds.has(hostId)) {
      return
    }
    descriptorByHostId.set(hostId, descriptor)
    publish(hostId)
  })
}

function readHostDescriptorSnapshot(hostId: string | undefined): HostDescriptorSnapshot {
  if (!hostId) {
    return EMPTY_SNAPSHOT
  }
  const descriptor = descriptorByHostId.get(hostId) ?? null
  const fresh = freshHostIds.has(hostId)
  const previous = snapshotByHostId.get(hostId)
  if (previous && previous.descriptor === descriptor && previous.fresh === fresh) {
    return previous
  }
  const next = { descriptor, fresh }
  snapshotByHostId.set(hostId, next)
  return next
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

export function useHostDescriptor(hostId: string | undefined): HostDescriptorSnapshot {
  const read = useCallback<() => HostDescriptorSnapshot>(
    () => readHostDescriptorSnapshot(hostId),
    [hostId]
  )
  const subscribeToHost = useCallback(
    (listener: () => void) => (hostId ? subscribe(hostId, listener) : () => {}),
    [hostId]
  )
  const snapshot = useSyncExternalStore(subscribeToHost, read, read)
  useEffect(() => {
    if (hostId) {
      loadHostDescriptor(hostId)
    }
  }, [hostId])
  return snapshot
}

export function resetHostDescriptorStoreForTests(): void {
  descriptorByHostId.clear()
  freshHostIds.clear()
  loadStartedHostIds.clear()
  adoptableLoadHostIds.clear()
  listenersByHostId.clear()
  snapshotByHostId.clear()
}

const EMPTY_SNAPSHOT: HostDescriptorSnapshot = { descriptor: null, fresh: false }
