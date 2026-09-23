import { describe, expect, it } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { getBrowserUseCliUnavailableReason } from './browser-use-cli-unavailable-reason'

function cliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: false,
    launcherPath: null,
    installMethod: 'symlink',
    supported: true,
    state: 'not_installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('getBrowserUseCliUnavailableReason', () => {
  it('explains a failed status read instead of leaving the button silently disabled', () => {
    expect(
      getBrowserUseCliUnavailableReason({
        unverifiable: false,
        installDisabledReason: null,
        status: null
      })
    ).toBe('Failed to load CLI status.')
  })

  it('shows why a runtime that needs repair cannot register the CLI', () => {
    expect(
      getBrowserUseCliUnavailableReason({
        unverifiable: false,
        installDisabledReason: 'Select a WSL distro first.',
        status: null
      })
    ).toBe('Select a WSL distro first.')
  })

  it('uses the host detail only when registration is unsupported', () => {
    expect(
      getBrowserUseCliUnavailableReason({
        unverifiable: false,
        installDisabledReason: null,
        status: cliStatus({ supported: false, detail: 'Launcher missing.' })
      })
    ).toBe('Launcher missing.')
    expect(
      getBrowserUseCliUnavailableReason({
        unverifiable: false,
        installDisabledReason: null,
        status: cliStatus({ detail: 'Not on PATH yet.' })
      })
    ).toBeNull()
  })

  it('says a remote runtime manages registration on its own host', () => {
    expect(
      getBrowserUseCliUnavailableReason({
        unverifiable: true,
        installDisabledReason: null,
        status: null
      })
    ).toBe('CLI registration is managed on the Orca server that runs your agents.')
  })
})
