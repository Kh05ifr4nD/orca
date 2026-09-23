// The page has no device storage grant for host display metadata; status reads refill its memory.
export const readPersistedHostDescriptor = (
  _hostId: string
): Promise<import('./host-descriptor-store').HostMachineDescriptor | null> => Promise.resolve(null)

export const writePersistedHostDescriptor = (
  _hostId: string,
  _descriptor: import('./host-descriptor-store').HostMachineDescriptor | null
): Promise<void> => Promise.resolve()
