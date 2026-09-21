export type HostDisplayResolutionInput = {
  personalLabel?: string | null
  machineName?: string | null
  hostname?: string | null
  platform?: string | null
  descriptorFresh: boolean
  previousPlatform?: string | null
  fallbackLabel: string
}

export type HostDisplayResolution = {
  primaryLabel: string
  descriptorName: string | null
  descriptorPlatform: string | null
  showDescriptor: boolean
  descriptorFresh: boolean
}

/** Resolves the label and machine descriptor without reading or mutating either store. */
export function resolveHostDisplay(input: HostDisplayResolutionInput): HostDisplayResolution {
  const personalLabel = normalize(input.personalLabel)
  const machineName = normalize(input.machineName)
  const hostname = normalize(input.hostname)
  const descriptorName = machineName ?? hostname
  const descriptorPlatform = normalize(input.platform)
  const fallbackLabel = normalize(input.fallbackLabel) ?? 'Host'
  const primaryLabel = personalLabel ?? descriptorName ?? fallbackLabel
  const descriptorExists = descriptorName !== null || descriptorPlatform !== null
  const platformChanged =
    normalize(input.previousPlatform) !== null &&
    descriptorPlatform !== null &&
    normalize(input.previousPlatform) !== descriptorPlatform
  const personalLabelAgrees = personalLabel !== null && personalLabel === descriptorName
  const canCollapse = personalLabelAgrees && input.descriptorFresh && !platformChanged

  return {
    primaryLabel,
    descriptorName,
    descriptorPlatform,
    showDescriptor: descriptorExists && !canCollapse,
    descriptorFresh: input.descriptorFresh
  }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
