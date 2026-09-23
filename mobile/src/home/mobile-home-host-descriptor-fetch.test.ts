import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const recordHostDescriptorMock = vi.hoisted(() => vi.fn())
const requestMock = vi.hoisted(() => vi.fn())

vi.mock('../transport/host-descriptor-store', () => ({
  recordHostDescriptor: (...args: unknown[]) => recordHostDescriptorMock(...args)
}))
vi.mock('../transport/host-status-probe-operations', () => ({
  hostStatusProbe: { request: (...args: unknown[]) => requestMock(...args) },
  readHostStatusGates: (reply: unknown) => reply
}))

import { fetchMobileHomeHostDescriptor } from './mobile-home-host-descriptor-fetch'

describe('home host descriptor fetch', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked probe never reads the client.
  const client = {} as RpcClient

  beforeEach(() => {
    recordHostDescriptorMock.mockReset()
    requestMock.mockReset()
  })

  it('records both fields from the readable reply', async () => {
    requestMock.mockResolvedValue({ machineName: ' Studio ', hostPlatform: 'darwin' })
    fetchMobileHomeHostDescriptor(client, 'host-1', () => false)
    await vi.waitFor(() => expect(recordHostDescriptorMock).toHaveBeenCalledOnce())
    expect(recordHostDescriptorMock).toHaveBeenCalledWith('host-1', {
      machineName: 'Studio',
      platform: 'darwin'
    })
  })

  it('does not let a replaced client publish a late answer', async () => {
    requestMock.mockResolvedValue({ machineName: 'Studio', hostPlatform: 'darwin' })
    fetchMobileHomeHostDescriptor(client, 'host-1', () => true)
    await Promise.resolve()
    expect(recordHostDescriptorMock).not.toHaveBeenCalled()
  })

  it('leaves the record alone when status is unreadable or refused', async () => {
    requestMock.mockResolvedValue(null)
    fetchMobileHomeHostDescriptor(client, 'host-1', () => false)
    await Promise.resolve()
    expect(recordHostDescriptorMock).not.toHaveBeenCalled()

    requestMock.mockRejectedValue(new Error('refused'))
    fetchMobileHomeHostDescriptor(client, 'host-1', () => false)
    await Promise.resolve()
    expect(recordHostDescriptorMock).not.toHaveBeenCalled()
  })
})
