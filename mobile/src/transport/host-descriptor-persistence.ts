import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { NODE_PLATFORM_NAMES } from './mobile-runtime-host-platform'
import type { HostMachineDescriptor } from './host-descriptor-store'

const STORAGE_KEY_PREFIX = 'orca:host-descriptor:v1:'
const storedDescriptorSchema = z.object({
  machineName: z.string().nullable(),
  platform: z.enum(NODE_PLATFORM_NAMES).nullable()
})

export async function readPersistedHostDescriptor(
  hostId: string
): Promise<HostMachineDescriptor | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(hostId))
    const parsed = storedDescriptorSchema.safeParse(raw ? JSON.parse(raw) : null)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writePersistedHostDescriptor(
  hostId: string,
  descriptor: HostMachineDescriptor | null
): Promise<void> {
  try {
    if (descriptor) {
      await AsyncStorage.setItem(storageKey(hostId), JSON.stringify(descriptor))
    } else {
      await AsyncStorage.removeItem(storageKey(hostId))
    }
  } catch {
    // Display metadata must never affect host connectivity.
  }
}

function storageKey(hostId: string): string {
  return `${STORAGE_KEY_PREFIX}${hostId}`
}
