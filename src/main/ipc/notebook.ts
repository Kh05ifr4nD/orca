import { dirname } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { runProcess } from '../../shared/child-process/run-process'
import { startNotebookKernel, type NotebookKernel } from '../notebook/notebook-kernel'
import { describePython, listPythonEnvironments } from '../notebook/python-environments'
import type {
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironment,
  PythonEnvironments
} from '../../shared/notebook-kernel-types'

const INSTALL_TIMEOUT_MS = 10 * 60_000
const INSTALL_DETAIL_CHARS = 4000

/** One kernel per notebook file, owned by the window that started it. */
const kernels = new Map<string, { kernel: NotebookKernel; owner: WebContents }>()
const watchedOwners = new WeakSet<WebContents>()

function stopKernel(filePath: string): void {
  kernels.get(filePath)?.kernel.shutdown()
  kernels.delete(filePath)
}

// Why: a closed window can leave the app running on macOS; its kernels must not outlive it.
function stopKernelsWithOwner(owner: WebContents): void {
  if (watchedOwners.has(owner)) {
    return
  }
  watchedOwners.add(owner)
  owner.once('destroyed', () => {
    for (const [filePath, entry] of kernels) {
      if (entry.owner === owner) {
        stopKernel(filePath)
      }
    }
  })
}

export function registerNotebookHandlers(store: Store): void {
  ipcMain.handle(
    'notebook:listPythonEnvironments',
    async (
      _event,
      args: { filePath: string; rootPath: string | null }
    ): Promise<PythonEnvironments> => {
      await resolveAuthorizedPath(args.filePath, store)
      // Why the unresolved path: rootPath is in the same (possibly symlinked) form, e.g. /tmp.
      return listPythonEnvironments(args.filePath, args.rootPath)
    }
  )

  ipcMain.handle(
    'notebook:describePython',
    (_event, args: { path: string }): Promise<PythonEnvironment | null> => describePython(args.path)
  )

  ipcMain.handle(
    'notebook:startKernel',
    async (event, args: { filePath: string; python: string }): Promise<KernelStartResult> => {
      // Why: run from the notebook's folder so relative imports and data paths resolve as on disk.
      const cwd = dirname(await resolveAuthorizedPath(args.filePath, store))
      stopKernel(args.filePath)
      const owner = event.sender
      const { kernel, ready } = startNotebookKernel({
        python: args.python,
        cwd,
        onFrame: (frame) => {
          if (frame.type === 'exit' && kernels.get(args.filePath)?.kernel === kernel) {
            kernels.delete(args.filePath)
          }
          if (!owner.isDestroyed()) {
            owner.send('notebook:kernelFrame', {
              filePath: args.filePath,
              frame
            } satisfies KernelFrameEvent)
          }
        }
      })
      kernels.set(args.filePath, { kernel, owner })
      stopKernelsWithOwner(owner)
      const result = await ready
      if (result.status !== 'ready' && kernels.get(args.filePath)?.kernel === kernel) {
        kernels.delete(args.filePath)
      }
      return result
    }
  )

  ipcMain.handle(
    'notebook:installIpykernel',
    async (_event, args: { python: string }): Promise<{ ok: boolean; detail: string }> => {
      try {
        const result = await runProcess({
          program: args.python,
          args: ['-m', 'pip', 'install', '-U', 'ipykernel'],
          timeoutMs: INSTALL_TIMEOUT_MS
        })
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(-INSTALL_DETAIL_CHARS)
        return { ok: result.code === 0, detail }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.handle('notebook:execute', (_event, args: { filePath: string; code: string }): void => {
    kernels.get(args.filePath)?.kernel.execute(args.code)
  })

  ipcMain.handle('notebook:interrupt', (_event, args: { filePath: string }): void => {
    kernels.get(args.filePath)?.kernel.interrupt()
  })

  ipcMain.handle('notebook:shutdownKernel', (_event, args: { filePath: string }): void => {
    stopKernel(args.filePath)
  })
}
