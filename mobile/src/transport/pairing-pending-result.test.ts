import { describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { createPendingPairing } from './pairing-pending-result'
import type { HostProfile } from './types'

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Host 2',
  endpoint: 'ws://192.168.1.2:6768',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 1
}

function pendingPairing(overrides: { saveHost?: (host: HostProfile) => Promise<void> } = {}) {
  const events: string[] = []
  const dependencies = {
    saveHost: vi.fn(
      overrides.saveHost ??
        (async (host: HostProfile) => {
          events.push(`save-host:${host.name}`)
        })
    ),
    clearJournal: vi.fn(async () => {
      events.push('clear-journal')
    }),
    writeCredentialBundle: vi.fn(async () => {
      events.push('write-credential')
    }),
    recordHostDescriptor: vi.fn()
  }
  const pairing = createPendingPairing({
    host: HOST,
    status: { machineName: ' Studio ', hostPlatform: 'darwin' },
    isExisting: false,
    dependencies,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only journalId is read.
    journal: { metadata: { journalId: 'journal-1' } } as MobileRelayPairingJournal,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bundle is only forwarded.
    credentialBundle: {} as MobileRelayCredentialBundle
  })
  return { pairing, dependencies, events }
}

describe('pending pairing', () => {
  it('suggests the machine name and saves an empty label under it', async () => {
    const { pairing, events } = pendingPairing()
    expect(pairing.suggestedName).toBe('Studio')

    await pairing.finalize('   ')

    expect(events).toEqual(['write-credential', 'save-host:Studio', 'clear-journal'])
  })

  it('keeps a failed save pending so Save can be retried', async () => {
    let attempts = 0
    const { pairing, events } = pendingPairing({
      saveHost: async (host) => {
        attempts++
        if (attempts === 1) {
          throw new Error('storage unavailable')
        }
        events.push(`save-host:${host.name}`)
      }
    })

    await expect(pairing.finalize('Desk')).rejects.toThrow('storage unavailable')
    await pairing.finalize('Desk')

    expect(events).toEqual([
      'write-credential',
      'write-credential',
      'save-host:Desk',
      'clear-journal'
    ])
  })

  it('does not let Cancel or unmount clear the journal under a save in flight', async () => {
    let releaseSave!: () => void
    const { pairing, dependencies } = pendingPairing({
      saveHost: () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve
        })
    })

    const saving = pairing.finalize('Desk')
    await vi.waitFor(() => expect(dependencies.saveHost).toHaveBeenCalledOnce())
    await pairing.cancel()
    expect(dependencies.clearJournal).not.toHaveBeenCalled()

    releaseSave()
    await saving
    expect(dependencies.clearJournal).toHaveBeenCalledOnce()
  })

  it('cancels without saving, never rejects, and ignores a later save', async () => {
    const { pairing, dependencies } = pendingPairing()
    dependencies.clearJournal.mockRejectedValueOnce(new Error('keychain locked'))

    await expect(pairing.cancel()).resolves.toBeUndefined()
    await pairing.finalize('Desk')

    expect(dependencies.saveHost).not.toHaveBeenCalled()
    expect(dependencies.writeCredentialBundle).not.toHaveBeenCalled()
  })
})
