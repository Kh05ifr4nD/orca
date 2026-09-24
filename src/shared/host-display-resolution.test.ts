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

  it('falls back from machine name to Host N', () => {
    expect(resolveHostDisplay({ ...base, platform: 'linux' }).primaryLabel).toBe('Host 2')
    expect(
      resolveHostDisplay({ ...base, machineName: 'build-box', platform: 'linux' }).primaryLabel
    ).toBe('build-box')
  })

  it('labels whichever descriptor half an older host reported', () => {
    expect(resolveHostDisplay({ ...base, personalLabel: 'Desk' })).toMatchObject({
      descriptorLabel: null,
      showDescriptor: false
    })
    expect(
      resolveHostDisplay({ ...base, personalLabel: 'Desk', platform: 'win32' }).descriptorLabel
    ).toBe('Windows')
    expect(
      resolveHostDisplay({
        ...base,
        personalLabel: 'Desk',
        machineName: 'Studio',
        platform: 'darwin'
      }).descriptorLabel
    ).toBe('macOS · Studio')
  })
})
