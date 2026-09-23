import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type { HostStatusReply } from './host-status-reply-schema'
import type { HostProfile } from './types'
import { recordHostDescriptor } from './host-descriptor-store'

export type PairingPendingResultDependencies = {
  saveHost: (host: HostProfile) => Promise<void>
  clearJournal: (journalId: string) => Promise<void>
  writeCredentialBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  recordHostDescriptor: typeof recordHostDescriptor
}

export type PairingPendingResult = {
  readonly hostId: string
  readonly host: HostProfile
  readonly machineName: string | null
  readonly hostPlatform: NodeJS.Platform | null
  readonly suggestedName: string
  finalize(name?: string): Promise<void>
  cancel(): Promise<void>
}

export function createPendingPairing(args: {
  host: HostProfile
  status: HostStatusReply | null
  isExisting: boolean
  dependencies: PairingPendingResultDependencies
  journal: MobileRelayPairingJournal | null
  credentialBundle: MobileRelayCredentialBundle | null
}): PairingPendingResult {
  const machineName = args.status?.machineName?.trim() || null
  const hostPlatform = args.status?.hostPlatform ?? null
  const suggestedName = args.isExisting ? args.host.name : (machineName ?? args.host.name)
  let settled = false
  return {
    hostId: args.host.id,
    host: args.host,
    machineName,
    hostPlatform,
    suggestedName,
    async finalize(name = suggestedName): Promise<void> {
      if (settled) {
        return
      }
      const normalizedName = name.trim() || suggestedName
      if (args.credentialBundle) {
        await args.dependencies.writeCredentialBundle(args.credentialBundle)
      }
      await args.dependencies.saveHost({ ...args.host, name: normalizedName })
      if (args.status) {
        args.dependencies.recordHostDescriptor(args.host.id, {
          machineName,
          platform: hostPlatform
        })
      }
      if (args.journal) {
        await args.dependencies.clearJournal(args.journal.metadata.journalId)
      }
      settled = true
    },
    async cancel(): Promise<void> {
      if (settled) {
        return
      }
      if (args.journal) {
        await args.dependencies.clearJournal(args.journal.metadata.journalId)
      }
      settled = true
    }
  }
}
