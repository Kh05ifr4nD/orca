import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as GitRunner from '../git/runner'
import type * as BundledRipgrepPath from '../ripgrep/bundled-ripgrep-path'
import { isFileListingCancellation } from '../../shared/file-listing-cancellation'
import { RipgrepUnavailableError } from '../../shared/ripgrep-process-availability'

const {
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  resolveAuthorizedPathMock,
  wslAwareSpawnMock
} = vi.hoisted(() => ({
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { searchQuickOpenFilePaths } from './filesystem-search-file-paths'

function createMockProcess(spawned = true): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  ;(child as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (child as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(child as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).kill = vi.fn()
  ;(child as unknown as Record<string, unknown>).exitCode = null
  ;(child as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(child, 'pid', { configurable: true, value: spawned ? 1 : undefined })
  return child
}

const BUNDLED_ERROR = "Orca's bundled search tool (ripgrep) could not start"

function createSpawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn rg ${code}`), { code })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('searchQuickOpenFilePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : '/bundled/rg'
    )
  })

  it('finds fuzzy matches after 100k paths without returning excluded worktrees', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 's4354tgt',
      limit: 2,
      excludePaths: ['/repo/nested']
    })
    await flushMicrotasks()

    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    expect(wslAwareSpawnMock.mock.calls[0][0]).toBe('/bundled/rg')
    expect(wslAwareSpawnMock.mock.calls[0][1]).toContain('--no-ignore-vcs')
    ;(child.stdout as unknown as EventEmitter).emit(
      'data',
      `${Array.from({ length: 100_100 }, (_, index) => `data/payload-${index}.bin`).join('\n')}\n`
    )
    ;(child.stdout as unknown as EventEmitter).emit(
      'data',
      'nested/src/sta-4354-target.ts\nsrc/sta-4354-target.ts\n'
    )
    child.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      paths: ['src/sta-4354-target.ts'],
      totalCount: 1,
      truncated: false
    })
  })

  it('kills the host scan when a superseded query aborts', async () => {
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32,
      signal: controller.signal
    })
    await flushMicrotasks()

    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('spawns the bundled Linux rg inside the registered WSL runtime', async () => {
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    const child = createMockProcess()
    wslAwareSpawnMock.mockReturnValue(child)

    const promise = searchQuickOpenFilePaths('C:\\repo', {} as Store, {
      query: 'target',
      limit: 32
    })
    await flushMicrotasks()
    ;(child.stdout as unknown as EventEmitter).emit('data', 'src/target.ts\n')
    child.emit('close', 0, null)

    await expect(promise).resolves.toMatchObject({ paths: ['src/target.ts'] })
    expect(bundledRipgrepCommandMock).toHaveBeenCalledWith({ wsl: true })
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      '/bundled/linux/rg',
      expect.any(Array),
      expect.objectContaining({ cwd: 'C:\\repo', wslDistro: 'Ubuntu' })
    )
  })

  it('retries a transient rg spawn failure instead of reporting the bundled rg broken', async () => {
    const failed = createMockProcess(false)
    const succeeded = createMockProcess()
    wslAwareSpawnMock.mockReturnValueOnce(failed).mockReturnValueOnce(succeeded)
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'sta4354gitignored',
      limit: 32
    })
    await flushMicrotasks()

    failed.emit('error', createSpawnError('EAGAIN'))
    await flushMicrotasks()

    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2)
    ;(succeeded.stdout as unknown as EventEmitter).emit(
      'data',
      'data/chunk-077568/sta-4354-gitignored-target.bin\n'
    )
    succeeded.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      paths: ['data/chunk-077568/sta-4354-gitignored-target.bin'],
      totalCount: 1,
      truncated: false
    })
  })

  it('retries a synchronous transient rg spawn failure', async () => {
    const succeeded = createMockProcess()
    wslAwareSpawnMock.mockImplementationOnce(() => {
      throw createSpawnError('ENOMEM')
    })
    wslAwareSpawnMock.mockReturnValueOnce(succeeded)

    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32
    })
    await flushMicrotasks()
    ;(succeeded.stdout as unknown as EventEmitter).emit('data', 'src/target.ts\n')
    succeeded.emit('close', 0, null)

    await expect(promise).resolves.toMatchObject({ paths: ['src/target.ts'] })
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2)
  })

  it('reports the bundled-ripgrep error when rg genuinely cannot start', async () => {
    const child = createMockProcess(false)
    wslAwareSpawnMock.mockReturnValue(child)
    // Why a root that exists: an ENOENT spawn error is also what a vanished workspace looks like,
    // so this stays about the binary only while the search root is actually reachable.
    resolveAuthorizedPathMock.mockImplementation(async () => process.cwd())
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32
    })
    await flushMicrotasks()

    child.emit('error', createSpawnError('ENOENT'))

    await expect(promise).rejects.toThrow(BUNDLED_ERROR)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
  })

  it('reports the bundled-ripgrep error when rg is unavailable on the retry', async () => {
    const failed = createMockProcess(false)
    wslAwareSpawnMock.mockReturnValueOnce(failed).mockImplementationOnce(() => {
      throw new RipgrepUnavailableError()
    })
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32
    })
    await flushMicrotasks()

    failed.emit('error', createSpawnError('EAGAIN'))

    await expect(promise).rejects.toThrow(BUNDLED_ERROR)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a transient spawn failure after the query was superseded', async () => {
    const child = createMockProcess(false)
    wslAwareSpawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32,
      signal: controller.signal
    })
    await flushMicrotasks()

    controller.abort()
    child.emit('error', createSpawnError('EAGAIN'))

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
  })

  it('reports cancellation when the query is superseded after a transient spawn failure', async () => {
    const child = createMockProcess(false)
    wslAwareSpawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const promise = searchQuickOpenFilePaths('/repo', {} as Store, {
      query: 'target',
      limit: 32,
      signal: controller.signal
    })
    await flushMicrotasks()

    // Abort lands after the scan rejected but before the retry decision resumes.
    child.emit('error', createSpawnError('EAGAIN'))
    controller.abort()

    await expect(promise).rejects.toSatisfy(isFileListingCancellation)
    expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not start a host scan for empty or oversized queries', async () => {
    await expect(
      searchQuickOpenFilePaths('/repo', {} as Store, { query: '   ', limit: 32 })
    ).resolves.toEqual({ paths: [], totalCount: 0, truncated: false })
    await expect(
      searchQuickOpenFilePaths('/repo', {} as Store, {
        query: 'é'.repeat(1_025),
        limit: 32
      })
    ).resolves.toEqual({ paths: [], totalCount: 0, truncated: false })

    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })
})
