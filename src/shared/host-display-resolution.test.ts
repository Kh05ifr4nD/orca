import { describe, expect, it } from 'vitest'
import { resolveHostDisplay } from './host-display-resolution'

const base = {
  descriptorFresh: true,
  fallbackLabel: 'Host 2'
}

describe('resolveHostDisplay', () => {
  it('keeps a personal label first and shows a disagreeing machine descriptor', () => {
    expect(
      resolveHostDisplay({
        ...base,
        personalLabel: 'Windows-Low Spec',
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
    ).toMatchObject({
      primaryLabel: 'Windows-Low Spec',
      descriptorName: 'm4airs-Air',
      descriptorPlatform: 'darwin',
      showDescriptor: true
    })
  })

  it('collapses a fresh descriptor that agrees with the personal label', () => {
    expect(
      resolveHostDisplay({
        ...base,
        personalLabel: 'Studio Mac',
        machineName: 'Studio Mac',
        platform: 'darwin'
      }).showDescriptor
    ).toBe(false)
  })

  it('does not collapse equal strings when the platform changed', () => {
    expect(
      resolveHostDisplay({
        ...base,
        personalLabel: 'Studio Mac',
        machineName: 'Studio Mac',
        platform: 'darwin',
        previousPlatform: 'win32'
      }).showDescriptor
    ).toBe(true)
  })

  it('marks an old descriptor as last-known data for the caller', () => {
    expect(
      resolveHostDisplay({
        ...base,
        descriptorFresh: false,
        personalLabel: 'Desk',
        machineName: 'Desk',
        platform: 'darwin'
      })
    ).toMatchObject({ primaryLabel: 'Desk', showDescriptor: true, descriptorFresh: false })
  })

  it('falls back from machine name to hostname and then Host N', () => {
    expect(resolveHostDisplay({ ...base, platform: 'linux' }).primaryLabel).toBe('Host 2')
    expect(
      resolveHostDisplay({ ...base, hostname: 'build-box', platform: 'linux' }).primaryLabel
    ).toBe('build-box')
  })
})
