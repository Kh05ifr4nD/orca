import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const { startNotebookKernelMock, resolveAuthorizedPathMock } = vi.hoisted(() => ({
  startNotebookKernelMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('./filesystem-auth', () => ({ resolveAuthorizedPath: resolveAuthorizedPathMock }))
vi.mock('../notebook/notebook-kernel', () => ({ startNotebookKernel: startNotebookKernelMock }))

import { registerNotebookHandlers } from './notebook'
import type { Store } from '../persistence'

function fakeKernel() {
  let onFrame: (frame: KernelFrame) => void = () => {}
  const kernel = { execute: vi.fn(), interrupt: vi.fn(), shutdown: vi.fn() }
  startNotebookKernelMock.mockImplementationOnce((options) => {
    onFrame = options.onFrame
    return { kernel, ready: Promise.resolve({ status: 'ready' }) }
  })
  return { kernel, emit: (frame: KernelFrame) => onFrame(frame) }
}

function fakeOwner() {
  return Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
}

describe('notebook IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => `/real${path}`)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only pass the store to the mocked authorizer.
    registerNotebookHandlers({} as Store)
  })

  it('starts one kernel per notebook in its folder and routes its frames to the owning window', async () => {
    const first = fakeKernel()
    const owner = fakeOwner()
    const start = handlers.get('notebook:startKernel')!
    await expect(
      start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    ).resolves.toEqual({ status: 'ready' })
    expect(startNotebookKernelMock).toHaveBeenCalledWith(
      expect.objectContaining({ python: '/py', cwd: '/real/repo' })
    )

    await handlers.get('notebook:execute')!({}, { filePath: '/repo/nb.ipynb', code: 'x' })
    expect(first.kernel.execute).toHaveBeenCalledWith('x')
    first.emit({ type: 'done', status: 'ok', execution_count: 1 })
    expect(owner.send).toHaveBeenCalledWith('notebook:kernelFrame', {
      filePath: '/repo/nb.ipynb',
      frame: { type: 'done', status: 'ok', execution_count: 1 }
    })

    fakeKernel()
    await start({ sender: owner }, { filePath: '/repo/nb.ipynb', python: '/py' })
    expect(first.kernel.shutdown).toHaveBeenCalledOnce()
  })

  it('shuts down a window’s kernels when the window goes away', async () => {
    const { kernel } = fakeKernel()
    const owner = fakeOwner()
    await handlers.get('notebook:startKernel')!(
      { sender: owner },
      { filePath: '/repo/nb.ipynb', python: '/py' }
    )
    owner.emit('destroyed')
    expect(kernel.shutdown).toHaveBeenCalledOnce()
  })
})
