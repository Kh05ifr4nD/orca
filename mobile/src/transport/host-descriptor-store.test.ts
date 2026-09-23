import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }))

import {
  forgetHostDescriptor,
  recordHostDescriptor,
  resetHostDescriptorStoreForTests,
  useHostDescriptor
} from './host-descriptor-store'

const KEY = 'orca:host-descriptor:v1:host-1'

type Deferred = {
  resolve: (value: string | null) => void
  promise: Promise<string | null>
}

function deferred(): Deferred {
  let resolve: (value: string | null) => void = () => {}
  const promise = new Promise<string | null>((settle) => {
    resolve = settle
  })
  return { resolve, promise }
}

describe('host descriptor store', () => {
  let renderer: ReactTestRenderer | null = null
  const seen: Record<string, ReturnType<typeof useHostDescriptor>[]> = {}

  function Row({ hostId }: { hostId: string }): null {
    const snapshot = useHostDescriptor(hostId)
    ;(seen[hostId] ??= []).push(snapshot)
    return null
  }

  beforeEach(() => {
    resetHostDescriptorStoreForTests()
    vi.clearAllMocks()
    asyncStorageMock.getItem.mockResolvedValue(null)
    asyncStorageMock.setItem.mockResolvedValue(undefined)
    asyncStorageMock.removeItem.mockResolvedValue(undefined)
    for (const hostId of Object.keys(seen)) {
      delete seen[hostId]
    }
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('loads a last-known descriptor without calling it fresh', async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === KEY ? JSON.stringify({ machineName: 'Studio', platform: 'darwin' }) : null
    )
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })

    expect(seen['host-1']?.at(-1)).toEqual({
      descriptor: { machineName: 'Studio', platform: 'darwin' },
      fresh: false
    })
  })

  it('lets a live reply win over a load still in flight and marks it fresh', async () => {
    const stored = deferred()
    asyncStorageMock.getItem.mockReturnValue(stored.promise)
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })

    await act(async () => {
      recordHostDescriptor('host-1', { machineName: 'New', platform: 'linux' })
      stored.resolve(JSON.stringify({ machineName: 'Old', platform: 'win32' }))
      await stored.promise
    })

    expect(seen['host-1']?.at(-1)).toEqual({
      descriptor: { machineName: 'New', platform: 'linux' },
      fresh: true
    })
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({ machineName: 'New', platform: 'linux' })
    )
  })

  it('persists a readable reply with missing fields as a clear descriptor', async () => {
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })
    await act(async () => {
      recordHostDescriptor('host-1', { machineName: null, platform: null })
    })

    expect(seen['host-1']?.at(-1)).toEqual({
      descriptor: { machineName: null, platform: null },
      fresh: true
    })
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      KEY,
      JSON.stringify({ machineName: null, platform: null })
    )
  })

  it('forgets a removed host and ignores its late load', async () => {
    const stored = deferred()
    asyncStorageMock.getItem.mockReturnValue(stored.promise)
    await act(async () => {
      renderer = create(createElement(Row, { hostId: 'host-1' }))
    })
    await act(async () => {
      await forgetHostDescriptor('host-1')
      stored.resolve(JSON.stringify({ machineName: 'Old', platform: 'darwin' }))
      await stored.promise
    })

    expect(seen['host-1']?.at(-1)).toEqual({ descriptor: null, fresh: false })
    expect(asyncStorageMock.removeItem).toHaveBeenCalledWith(KEY)
  })

  it("does not re-render another host's row", async () => {
    await act(async () => {
      renderer = create(
        createElement(
          'rows',
          null,
          createElement(Row, { hostId: 'host-1' }),
          createElement(Row, { hostId: 'host-2' })
        )
      )
    })
    const host2Renders = seen['host-2']?.length ?? 0
    await act(async () => {
      recordHostDescriptor('host-1', { machineName: 'Desk', platform: 'darwin' })
    })

    expect(seen['host-2']).toHaveLength(host2Renders)
  })
})
