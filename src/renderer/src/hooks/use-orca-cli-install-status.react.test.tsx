// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { notifyOrchestrationSetupStateChanged } from '@/lib/orchestration-setup-state'
import type { OrcaCliSkillRuntime } from '@/lib/orca-cli-install-status'
import { notifyOrcaCliInstallStateChanged } from '@/lib/orca-cli-install-state-event'
import {
  _orcaCliInstallStatusStoreForTests,
  useOrcaCliInstallStatus,
  type OrcaCliInstallStatusState
} from './use-orca-cli-install-status'

let mockRuntimeTarget: RuntimeClientTarget | null = { kind: 'local' }
vi.mock('./use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => mockRuntimeTarget
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestState: OrcaCliInstallStatusState | null = null
const getInstallStatus = vi.fn<() => Promise<CliInstallStatus>>()
const getWslInstallStatus =
  vi.fn<(args?: { distro?: string | null }) => Promise<CliInstallStatus>>()

const HOST_RUNTIME: OrcaCliSkillRuntime = { installDisabledReason: null }
let now = 1_000_000

function advancePastFreshWindow(): void {
  now += 5_000
}

function cliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: null,
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function Probe(props: { runtime: OrcaCliSkillRuntime; enabled?: boolean }): null {
  latestState = useOrcaCliInstallStatus(props.runtime, { enabled: props.enabled })
  return null
}

const instanceStates: OrcaCliInstallStatusState[] = []

function Instance(props: { index: number }): null {
  instanceStates[props.index] = useOrcaCliInstallStatus(HOST_RUNTIME)
  return null
}

async function renderInstances(count: number): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Instance key={index} index={index} />
        ))}
      </>
    )
  })
}

async function render(runtime: OrcaCliSkillRuntime, enabled?: boolean): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe runtime={runtime} enabled={enabled} />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 4; tick += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  _orcaCliInstallStatusStoreForTests.reset()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  mockRuntimeTarget = { kind: 'local' }
  getInstallStatus.mockReset()
  getWslInstallStatus.mockReset()
  Reflect.set(window, 'api', { cli: { getInstallStatus, getWslInstallStatus } })
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
  latestState = null
  instanceStates.length = 0
  Reflect.deleteProperty(window, 'api')
  Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
  vi.restoreAllMocks()
})

describe('useOrcaCliInstallStatus', () => {
  it('reads the host CLI and reports it registered only when it is on PATH', async () => {
    getInstallStatus.mockResolvedValue(cliStatus({ pathConfigured: false }))
    await render(HOST_RUNTIME)
    await flush()

    expect(getInstallStatus).toHaveBeenCalledTimes(1)
    expect(latestState).toMatchObject({ checked: true, loading: false, registered: false })

    getInstallStatus.mockResolvedValue(cliStatus())
    advancePastFreshWindow()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    expect(latestState?.registered).toBe(true)
  })

  it('reads the WSL CLI for the runtime distro', async () => {
    getWslInstallStatus.mockResolvedValue(cliStatus())
    await render({
      installDisabledReason: null,
      agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL' }
    })
    await flush()

    expect(getWslInstallStatus).toHaveBeenCalledWith({ distro: 'Ubuntu' })
    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState?.registered).toBe(true)
  })

  it('treats a runtime that needs repair as checked with no status', async () => {
    await render({ installDisabledReason: 'Install WSL first' })
    await flush()

    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState).toMatchObject({ status: null, checked: true, registered: false })
  })

  it('settles as checked when the read fails', async () => {
    getInstallStatus.mockRejectedValue(new Error('ipc down'))
    await render(HOST_RUNTIME)
    await flush()

    expect(latestState).toMatchObject({ status: null, checked: true, registered: false })
  })

  it('re-reads when setup state changes and drops a stale earlier response', async () => {
    const first = deferred<CliInstallStatus>()
    getInstallStatus.mockReturnValueOnce(first.promise)
    getInstallStatus.mockResolvedValueOnce(cliStatus())
    await render(HOST_RUNTIME)
    await act(async () => {
      notifyOrchestrationSetupStateChanged()
    })
    await flush()
    expect(latestState?.registered).toBe(true)

    first.resolve(cliStatus({ state: 'not_installed' }))
    await flush()

    expect(getInstallStatus).toHaveBeenCalledTimes(2)
    expect(latestState?.registered).toBe(true)
  })

  it('re-reads every mounted instance when the CLI install state changes', async () => {
    getInstallStatus.mockResolvedValueOnce(cliStatus({ state: 'not_installed' }))
    getInstallStatus.mockResolvedValueOnce(cliStatus())
    await render(HOST_RUNTIME)
    await flush()
    expect(latestState?.registered).toBe(false)

    await act(async () => {
      notifyOrcaCliInstallStateChanged()
    })
    await flush()

    expect(getInstallStatus).toHaveBeenCalledTimes(2)
    expect(latestState?.registered).toBe(true)
  })

  it('shares one read across mounted instances for mount, focus, and install events', async () => {
    getInstallStatus.mockResolvedValue(cliStatus({ state: 'not_installed' }))
    await renderInstances(3)
    await flush()
    expect(getInstallStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(getInstallStatus).toHaveBeenCalledTimes(1)

    advancePastFreshWindow()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(getInstallStatus).toHaveBeenCalledTimes(2)

    getInstallStatus.mockResolvedValue(cliStatus())
    await act(async () => {
      notifyOrcaCliInstallStateChanged()
    })
    await flush()
    expect(getInstallStatus).toHaveBeenCalledTimes(3)
    expect(instanceStates.map((state) => state.registered)).toEqual([true, true, true])
  })

  it('does not let a state-change event join a read that started before it', async () => {
    const stale = deferred<CliInstallStatus>()
    getInstallStatus.mockReturnValueOnce(stale.promise)
    getInstallStatus.mockResolvedValueOnce(cliStatus())
    await renderInstances(2)
    expect(getInstallStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      notifyOrcaCliInstallStateChanged()
    })
    await flush()
    expect(getInstallStatus).toHaveBeenCalledTimes(2)
    expect(instanceStates.map((state) => state.registered)).toEqual([true, true])

    stale.resolve(cliStatus({ state: 'not_installed' }))
    await flush()
    expect(instanceStates.map((state) => state.registered)).toEqual([true, true])
  })

  it('shows the last answer for the same target while it re-reads on re-enable', async () => {
    const second = deferred<CliInstallStatus>()
    getInstallStatus.mockResolvedValueOnce(cliStatus())
    getInstallStatus.mockReturnValueOnce(second.promise)
    await render(HOST_RUNTIME, true)
    await flush()
    expect(latestState).toMatchObject({ checked: true, registered: true })

    await render(HOST_RUNTIME, false)
    expect(latestState).toMatchObject({ checked: false, registered: false })

    advancePastFreshWindow()
    await render(HOST_RUNTIME, true)
    expect(getInstallStatus).toHaveBeenCalledTimes(2)
    expect(latestState).toMatchObject({ checked: true, loading: true, registered: true })

    second.resolve(cliStatus({ state: 'not_installed' }))
    await flush()
    expect(latestState).toMatchObject({ checked: true, loading: false, registered: false })
  })

  it('never shows another target answer when the install target changes', async () => {
    const wslRead = deferred<CliInstallStatus>()
    getInstallStatus.mockResolvedValue(cliStatus())
    getWslInstallStatus.mockReturnValueOnce(wslRead.promise)
    await render(HOST_RUNTIME)
    await flush()
    expect(latestState).toMatchObject({ checked: true, registered: true })

    await render({
      installDisabledReason: null,
      agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL' }
    })
    expect(latestState).toMatchObject({ status: null, checked: false, registered: false })

    wslRead.resolve(cliStatus({ state: 'not_installed' }))
    await flush()
    expect(latestState).toMatchObject({ checked: true, registered: false })
  })

  it('does not probe while disabled', async () => {
    await render(HOST_RUNTIME, false)
    await flush()

    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState).toMatchObject({ checked: false, loading: false })
  })

  it('reports a remote runtime as unverifiable without reading the local CLI', async () => {
    mockRuntimeTarget = { kind: 'environment', environmentId: 'env-1' }
    await render(HOST_RUNTIME)
    await flush()

    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState).toMatchObject({ checked: true, registered: false, unverifiable: true })
  })

  it('reports a paired web client as unverifiable', async () => {
    Reflect.set(globalThis, '__ORCA_WEB_CLIENT__', true)
    await render(HOST_RUNTIME)
    await flush()

    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState).toMatchObject({ checked: true, unverifiable: true })
  })

  it('stays unchecked until the runtime owner resolves', async () => {
    mockRuntimeTarget = null
    await render(HOST_RUNTIME)
    await flush()

    expect(getInstallStatus).not.toHaveBeenCalled()
    expect(latestState).toMatchObject({ checked: false, unverifiable: false })
  })
})
