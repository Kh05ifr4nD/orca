import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { clearIpynbOutputs, updateIpynbCellRun } from './ipynb-cell-mutations'
import { toStoredOutputs } from './ipynb-kernel-outputs'
import {
  failCell,
  forgetFinishedRuns,
  markRunCommitted,
  runCells,
  trustNotebook
} from './ipynb-kernel-session'
import {
  getCellRun,
  useNotebookKernelState,
  useUncommittedRunKeys,
  type QueuedCell
} from './ipynb-kernel-store'
import { parseIpynb } from './ipynb-parse'
import { getIpynbCellKey } from './useIpynbDocumentEditing'

type UseIpynbCellExecutionArgs = {
  filePath: string
  worktreeId: string
  /** The workspace root, where the search for a project `.venv` stops. */
  rootPath: string | null
  flushSourceDrafts: () => string
  applyContent: (content: string) => void
}

export function useIpynbCellExecution({
  filePath,
  worktreeId,
  rootPath,
  flushSourceDrafts,
  applyContent
}: UseIpynbCellExecutionArgs) {
  const kernel = useNotebookKernelState(filePath)
  const uncommittedRunKeys = useUncommittedRunKeys(filePath)
  const [pendingRun, setPendingRun] = useState<QueuedCell[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Why: runs can finish while this notebook is not the visible tab, so outputs wait in the kernel
  // session until the open document takes them in.
  useEffect(() => {
    if (uncommittedRunKeys.length === 0) {
      return
    }
    const latestContent = flushSourceDrafts()
    let nextContent = latestContent
    try {
      const cells = parseIpynb(latestContent).cells
      for (const key of uncommittedRunKeys) {
        const run = getCellRun(filePath, key)
        const index = cells.findIndex((cell, cellIndex) => getIpynbCellKey(cell, cellIndex) === key)
        if (run && index !== -1) {
          nextContent = updateIpynbCellRun(
            nextContent,
            index,
            toStoredOutputs(run.outputs),
            run.executionCount
          )
        }
      }
    } catch {
      // An unparseable document has no cells to take outputs; drop them.
    }
    for (const key of uncommittedRunKeys) {
      markRunCommitted(filePath, key)
    }
    if (nextContent !== latestContent) {
      applyContent(nextContent)
    }
  }, [applyContent, filePath, flushSourceDrafts, uncommittedRunKeys])

  const queueCells = async (cells: QueuedCell[]): Promise<void> => {
    if ((await runCells(filePath, cells, rootPath)) === 'choose-environment') {
      setPickerOpen(true)
    }
  }

  const run = (indexes: number[]): void => {
    const notebook = parseIpynb(flushSourceDrafts())
    const cells = indexes.flatMap((index) => {
      const cell = notebook.cells[index]
      return cell?.kind === 'code' ? [{ key: getIpynbCellKey(cell, index), code: cell.source }] : []
    })
    const [first] = cells
    if (!first) {
      return
    }
    if (getConnectionId(worktreeId)) {
      failCell(
        filePath,
        first.key,
        translate(
          'auto.components.editor.IpynbViewer.localOnly',
          'Notebook cells can only run for files on this computer.'
        )
      )
      return
    }
    if (notebook.language !== 'python') {
      failCell(
        filePath,
        first.key,
        translate(
          'auto.components.editor.IpynbViewer.pythonOnly',
          'Only Python notebooks can run in Orca.'
        )
      )
      return
    }
    if (!kernel.trusted) {
      setPendingRun(cells)
      return
    }
    void queueCells(cells)
  }

  const confirmPendingRun = (): void => {
    trustNotebook(filePath)
    setPendingRun(null)
    if (pendingRun) {
      void queueCells(pendingRun)
    }
  }

  const clearAllOutputs = (): void => {
    applyContent(clearIpynbOutputs(flushSourceDrafts()))
    forgetFinishedRuns(filePath)
  }

  return {
    pendingRun,
    cancelPendingRun: () => setPendingRun(null),
    confirmPendingRun,
    pickerOpen,
    setPickerOpen,
    runCell: (index: number) => run([index]),
    runAll: (cellCount: number) => run([...Array(cellCount).keys()]),
    clearAllOutputs
  }
}
