import { hostPlatformDisplayName } from './host-platform-label'

export type HostDisplayResolutionInput = {
  personalLabel?: string | null
  machineName?: string | null
  platform?: NodeJS.Platform | null
  descriptorFresh: boolean
  fallbackLabel: string
}

export type HostDisplayResolution = {
  primaryLabel: string
  descriptorName: string | null
  descriptorPlatform: NodeJS.Platform | null
  /** "OS · machine name", or whichever half the host reported; null when neither. */
  descriptorLabel: string | null
  showDescriptor: boolean
  descriptorFresh: boolean
}

/** Resolves the label and machine descriptor without reading or mutating either store. */
export function resolveHostDisplay(input: HostDisplayResolutionInput): HostDisplayResolution {
  const personalLabel = normalize(input.personalLabel)
  const descriptorName = normalize(input.machineName)
  const descriptorPlatform = input.platform ?? null
  const fallbackLabel = normalize(input.fallbackLabel) ?? 'Host'
  const primaryLabel = personalLabel ?? descriptorName ?? fallbackLabel
  const descriptorLabel =
    [hostPlatformDisplayName(descriptorPlatform), descriptorName].filter(Boolean).join(' · ') ||
    null
  const personalLabelAgrees = personalLabel !== null && personalLabel === descriptorName
  const canCollapse = personalLabelAgrees && input.descriptorFresh

  return {
    primaryLabel,
    descriptorName,
    descriptorPlatform,
    descriptorLabel,
    showDescriptor: descriptorLabel !== null && !canCollapse,
    descriptorFresh: input.descriptorFresh
  }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
