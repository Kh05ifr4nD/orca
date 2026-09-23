import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { KernelFrameEvent, PythonEnvironment } from '../../../../shared/notebook-kernel-types'
import { applyKernelOutput, type NotebookOutput } from './ipynb-kernel-outputs'
import {
  getSession,
  runningCellKey,
  setEnvironment,
  store,
  updateSession,
  type CellRun,
  type NotebookKernelSession,
  type QueuedCell
} from './ipynb-kernel-store'

const INTERRUPT_STALL_MS = 10_000
export const IPYKERNEL_INSTALL_ARGS = '-m pip install -U ipykernel'

function startRun(): CellRun {
  return {
    outputs: [],
    clearOnNextOutput: false,
    executionCount: null,
    startedAt: Date.now(),
    finishedAt: null,
    committed: false
  }
}

/** Ends the executing run, if any, and drops every queued cell. */
function stopRuns(session: NotebookKernelSession, extraOutputs: NotebookOutput[] = []) {
  const key = runningCellKey(session)
  const run = key === null ? null : session.runs[key]
  return {
    queue: [],
    interruptStalled: false,
    runs:
      key === null || !run
        ? session.runs
        : {
            ...session.runs,
            [key]: { ...run, outputs: [...run.outputs, ...extraOutputs], finishedAt: Date.now() }
          }
  }
}

/** Orca's own notices (no Python, install failures) are written as markdown outputs of the cell. */
function noticeOutput(markdown: string): NotebookOutput {
  return { output_type: 'display_data', data: { 'text/markdown': markdown }, metadata: {} }
}

function fenced(text: string): string {
  return text ? `\n\n\`\`\`\n${text}\n\`\`\`` : ''
}

/** Reports a failure in the first queued cell (a toast when nothing was queued) and drops the queue. */
function failQueue(filePath: string, message: string, detail = ''): void {
  const [head] = getSession(filePath).queue
  if (!head) {
    toast.error(message, { description: detail.slice(-500) })
  }
  updateSession(filePath, ({ runs }) => ({
    status: 'off',
    queue: [],
    runs: head
      ? {
          ...runs,
          [head.key]: {
            ...startRun(),
            outputs: [noticeOutput(message + fenced(detail))],
            finishedAt: Date.now()
          }
        }
      : runs
  }))
}

function pump(filePath: string): void {
  const session = getSession(filePath)
  const [next, ...queue] = session.queue
  if (session.status !== 'ready' || !next || runningCellKey(session) !== null) {
    return
  }
  updateSession(filePath, ({ runs }) => ({ queue, runs: { ...runs, [next.key]: startRun() } }))
  void window.api.notebook.execute({ filePath, code: next.code })
}

async function start(filePath: string): Promise<void> {
  const environment = store.getState().environments[filePath]
  if (!environment) {
    return
  }
  updateSession(filePath, () => ({ status: 'starting' }))
  const result = await window.api.notebook.startKernel({ filePath, python: environment.path })
  if (!store.getState().sessions[filePath]) {
    return
  }
  if (result.status === 'ready') {
    updateSession(filePath, () => ({ status: 'ready' }))
    pump(filePath)
  } else if (result.status === 'missing-ipykernel') {
    updateSession(filePath, () => ({ status: 'missing-ipykernel' }))
  } else {
    failQueue(
      filePath,
      translate(
        'auto.components.editor.IpynbViewer.kernelStartFailed',
        'The kernel failed to start.'
      ),
      result.detail
    )
  }
}

export function trustNotebook(filePath: string): void {
  updateSession(filePath, () => ({ trusted: true }))
}

/**
 * Queues cells to run, starting a kernel when there is none. Resolves to `'choose-environment'`
 * when the user has to pick an interpreter first.
 */
export async function runCells(
  filePath: string,
  cells: QueuedCell[],
  rootPath: string | null
): Promise<'choose-environment' | void> {
  updateSession(filePath, (session) => {
    const running = runningCellKey(session)
    const fresh = cells.filter(
      (cell) => cell.key !== running && !session.queue.some((queued) => queued.key === cell.key)
    )
    return { queue: [...session.queue, ...fresh] }
  })
  const { status } = getSession(filePath)
  if (status === 'ready') {
    pump(filePath)
    return
  }
  if (status !== 'off' && status !== 'dead') {
    return
  }
  if (!store.getState().environments[filePath]) {
    const found = await window.api.notebook.listPythonEnvironments({ filePath, rootPath })
    const [recommended] = found.workspace
    if (!recommended) {
      if (found.path.length > 0) {
        return 'choose-environment'
      }
      failQueue(
        filePath,
        translate(
          'auto.components.editor.IpynbViewer.noPython',
          'Python was not found on this computer. Install it from [python.org](https://www.python.org/downloads/), then run the cell again.'
        )
      )
      return
    }
    setEnvironment(filePath, recommended)
  }
  await start(filePath)
}

export function restartKernel(filePath: string): void {
  updateSession(filePath, stopRuns)
  void start(filePath)
}

/** Switching interpreters restarts a running kernel; otherwise queued cells wait for the new one. */
export function selectEnvironment(filePath: string, environment: PythonEnvironment): void {
  setEnvironment(filePath, environment)
  const { status } = getSession(filePath)
  if (status === 'off' || status === 'missing-ipykernel') {
    void start(filePath)
  } else {
    restartKernel(filePath)
  }
}

export function interruptKernel(filePath: string): void {
  const key = runningCellKey(getSession(filePath))
  void window.api.notebook.interrupt({ filePath })
  setTimeout(() => {
    if (key !== null && runningCellKey(getSession(filePath)) === key) {
      updateSession(filePath, () => ({ interruptStalled: true }))
    }
  }, INTERRUPT_STALL_MS)
}

export async function installIpykernel(filePath: string): Promise<void> {
  const environment = store.getState().environments[filePath]
  if (!environment) {
    return
  }
  updateSession(filePath, () => ({ status: 'installing' }))
  const result = await window.api.notebook.installIpykernel({ python: environment.path })
  if (!store.getState().sessions[filePath]) {
    return
  }
  if (result.ok) {
    await start(filePath)
    return
  }
  failQueue(
    filePath,
    translate(
      'auto.components.editor.IpynbViewer.installFailed',
      'Installing ipykernel failed. Run `{{command}}` yourself, or create a virtual environment for this project with `python3 -m venv .venv` and choose it as the kernel.',
      { command: `"${environment.path}" ${IPYKERNEL_INSTALL_ARGS}` }
    ),
    result.detail
  )
}

/** Drops cells waiting on an interpreter choice or ipykernel when the user backs out. */
export function cancelPendingStart(filePath: string): void {
  const { status } = getSession(filePath)
  if (status === 'off' || status === 'missing-ipykernel') {
    updateSession(filePath, () => ({ status: 'off', queue: [] }))
  }
}

/** Records a notice for a cell that cannot run, e.g. in an SSH workspace. */
export function failCell(filePath: string, key: string, markdown: string): void {
  updateSession(filePath, ({ runs }) => ({
    runs: {
      ...runs,
      [key]: { ...startRun(), outputs: [noticeOutput(markdown)], finishedAt: Date.now() }
    }
  }))
}

export function markRunCommitted(filePath: string, key: string): void {
  updateSession(filePath, ({ runs }) => {
    const run = runs[key]
    return run ? { runs: { ...runs, [key]: { ...run, outputs: [], committed: true } } } : {}
  })
}

/** Forgets finished runs, e.g. after Clear All Outputs; the executing run keeps streaming. */
export function forgetFinishedRuns(filePath: string): void {
  updateSession(filePath, ({ runs }) => ({
    runs: Object.fromEntries(Object.entries(runs).filter(([, run]) => run.finishedAt === null))
  }))
}

function handleFrame({ filePath, frame }: KernelFrameEvent): void {
  const session = store.getState().sessions[filePath]
  if (!session) {
    return
  }
  if (frame.type === 'exit') {
    const died = translate('auto.components.editor.IpynbViewer.kernelDied', 'The kernel died.')
    updateSession(filePath, (current) => ({
      ...stopRuns(current, [noticeOutput(died + fenced(frame.detail))]),
      status: 'dead'
    }))
    return
  }
  const key = runningCellKey(session)
  if (key === null) {
    return
  }
  if (frame.type === 'done') {
    updateSession(filePath, ({ queue, runs }) => ({
      // Like Jupyter, an error (including an interrupt) cancels the cells queued after it.
      queue: frame.status === 'ok' ? queue : [],
      interruptStalled: false,
      runs: {
        ...runs,
        [key]: { ...runs[key], executionCount: frame.execution_count, finishedAt: Date.now() }
      }
    }))
    pump(filePath)
    return
  }
  updateSession(filePath, ({ runs }) => ({
    runs: { ...runs, [key]: applyKernelOutput(runs[key], frame.type, frame.content) }
  }))
}

// Kernels only exist once this module has loaded with the notebook viewer, so it subscribes here.
window.api.notebook.onKernelFrame(handleFrame)
// A kernel shuts down once its notebook's tab closes, however it closed.
useAppStore.subscribe((state, previous) => {
  if (state.openFiles === previous.openFiles) {
    return
  }
  for (const filePath of Object.keys(store.getState().sessions)) {
    if (!state.openFiles.some((file) => file.filePath === filePath)) {
      void window.api.notebook.shutdownKernel({ filePath })
      store.setState(({ sessions }) => {
        const { [filePath]: _closed, ...rest } = sessions
        return { sessions: rest }
      })
    }
  }
})
