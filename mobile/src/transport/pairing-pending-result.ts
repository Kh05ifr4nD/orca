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
  /** Rejects on a failed save and leaves the pairing pending, so Save can be retried. */
  finalize(name?: string): Promise<void>
  /** No-op once a save has started; never rejects. */
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
  // Why: a save in flight owns the outcome — Cancel or unmount must not clear the journal under it.
  let phase: 'pending' | 'saving' | 'saved' | 'cancelled' = 'pending'
  let saving: Promise<void> | null = null

  async function save(name: string): Promise<void> {
    if (args.credentialBundle) {
      await args.dependencies.writeCredentialBundle(args.credentialBundle)
    }
    await args.dependencies.saveHost({ ...args.host, name: name.trim() || suggestedName })
    if (args.status) {
      args.dependencies.recordHostDescriptor(args.host.id, { machineName, platform: hostPlatform })
    }
    if (args.journal) {
      // Why not awaited into the result: the host is saved; launch recovery clears a leftover journal.
      await args.dependencies.clearJournal(args.journal.metadata.journalId).catch(() => {})
    }
  }

  return {
    hostId: args.host.id,
    host: args.host,
    machineName,
    hostPlatform,
    suggestedName,
    finalize(name = suggestedName): Promise<void> {
      if (phase === 'saved' || phase === 'cancelled') {
        return Promise.resolve()
      }
      if (saving) {
        return saving
      }
      phase = 'saving'
      saving = save(name).then(
        () => {
          phase = 'saved'
          saving = null
        },
        (error: unknown) => {
          phase = 'pending'
          saving = null
          throw error
        }
      )
      return saving
    },
    async cancel(): Promise<void> {
      if (phase !== 'pending') {
        return
      }
      phase = 'cancelled'
      if (args.journal) {
        // Why swallowed: Cancel must always leave the screen; launch recovery owns a leftover journal.
        await args.dependencies.clearJournal(args.journal.metadata.journalId).catch(() => {})
      }
    }
  }
}
