// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIpynb } from './ipynb-parse'

const { getConnectionIdMock, notebookApi } = vi.hoisted(() => {
  const notebookApi = {
    listPythonEnvironments: vi.fn(),
    startKernel: vi.fn(),
    execute: vi.fn(),
    shutdownKernel: vi.fn(),
    onKernelFrame: vi.fn(() => () => {})
  }
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook: notebookApi } })
  return { getConnectionIdMock: vi.fn((): string | null => null), notebookApi }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionId: getConnectionIdMock }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

import { useIpynbCellExecution } from './useIpynbCellExecution'

function notebookContent(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [
      { id: 'md', cell_type: 'markdown', metadata: {}, source: ['# hi'] },
      {
        id: 'run',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ['print(42)']
      }
    ]
  })
}

function renderExecution(filePath: string, applyContent = vi.fn()) {
  let content = notebookContent()
  applyContent.mockImplementation((next: string) => {
    content = next
  })
  const hook = renderHook(() =>
    useIpynbCellExecution({
      filePath,
      worktreeId: 'worktree-a',
      rootPath: '/repo',
      flushSourceDrafts: () => content,
      applyContent
    })
  )
  return { hook, applyContent, content: () => content }
}

describe('notebook cell execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnectionIdMock.mockReturnValue(null)
    notebookApi.listPythonEnvironments.mockResolvedValue({
      workspace: [{ path: '/repo/.venv/bin/python', name: '.venv', version: '3.12.1' }],
      path: []
    })
    notebookApi.startKernel.mockResolvedValue({ status: 'ready' })
  })

  it('asks for trust before running, then runs the cell in a kernel', async () => {
    const { hook } = renderExecution('/repo/trust.ipynb')

    act(() => hook.result.current.runCell(1))
    expect(hook.result.current.pendingRun).toEqual([{ key: 'run', code: 'print(42)' }])
    expect(notebookApi.startKernel).not.toHaveBeenCalled()

    act(() => hook.result.current.confirmPendingRun())
    await waitFor(() =>
      expect(notebookApi.execute).toHaveBeenCalledWith({
        filePath: '/repo/trust.ipynb',
        code: 'print(42)'
      })
    )
    expect(notebookApi.startKernel).toHaveBeenCalledWith({
      filePath: '/repo/trust.ipynb',
      python: '/repo/.venv/bin/python'
    })
  })

  it('writes a local-only notice into the cell for SSH workspaces without starting a kernel', async () => {
    getConnectionIdMock.mockReturnValue('ssh-connection')
    const { hook, content } = renderExecution('/remote/notebook.ipynb')

    act(() => hook.result.current.runCell(1))
    await waitFor(() => expect(parseIpynb(content()).cells[1]?.outputs).toHaveLength(1))
    expect(JSON.stringify(parseIpynb(content()).cells[1]?.outputs)).toContain(
      'only run for files on this computer'
    )
    expect(hook.result.current.pendingRun).toBeNull()
    expect(notebookApi.startKernel).not.toHaveBeenCalled()
  })
})
