export type HostDisplayResolutionInput = {
  personalLabel?: string | null
  machineName?: string | null
  hostname?: string | null
  platform?: NodeJS.Platform | null
  descriptorFresh: boolean
  previousPlatform?: NodeJS.Platform | null
  fallbackLabel: string
}

export type HostDisplayResolution = {
  primaryLabel: string
  descriptorName: string | null
  descriptorPlatform: NodeJS.Platform | null
  showDescriptor: boolean
  descriptorFresh: boolean
}

/** Resolves the label and machine descriptor without reading or mutating either store. */
export function resolveHostDisplay(input: HostDisplayResolutionInput): HostDisplayResolution {
  const personalLabel = normalize(input.personalLabel)
  const machineName = normalize(input.machineName)
  const hostname = normalize(input.hostname)
  const descriptorName = machineName ?? hostname
  const descriptorPlatform = input.platform ?? null
  const fallbackLabel = normalize(input.fallbackLabel) ?? 'Host'
  const primaryLabel = personalLabel ?? descriptorName ?? fallbackLabel
  const descriptorExists = descriptorName !== null || descriptorPlatform !== null
  const platformChanged =
    input.previousPlatform !== null &&
    input.previousPlatform !== undefined &&
    descriptorPlatform !== null &&
    input.previousPlatform !== descriptorPlatform
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
