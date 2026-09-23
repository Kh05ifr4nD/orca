import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { translate } from '@/i18n/i18n'

/** Why the Browser Use "Enable Orca CLI" button cannot act, so a disabled button is never silent. */
export function getBrowserUseCliUnavailableReason(input: {
  unverifiable: boolean
  installDisabledReason: string | null
  status: CliInstallStatus | null
}): string | null {
  if (input.unverifiable) {
    return translate(
      'auto.components.settings.BrowserUsePane.remoteManaged',
      'CLI registration is managed on the Orca server that runs your agents.'
    )
  }
  if (input.installDisabledReason) {
    return input.installDisabledReason
  }
  if (!input.status) {
    return translate(
      'auto.components.settings.BrowserUsePane.180a9abf3a',
      'Failed to load CLI status.'
    )
  }
  return input.status.supported ? null : input.status.detail
}
