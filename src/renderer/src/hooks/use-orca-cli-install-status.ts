import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { ORCHESTRATION_SETUP_STATE_EVENT } from '@/lib/orchestration-setup-state'
import {
  getOrcaCliInstallTargetKey,
  readOrcaCliInstallStatus,
  type OrcaCliSkillRuntime
} from '@/lib/orca-cli-install-status'
import { ORCA_CLI_INSTALL_STATE_EVENT } from '@/lib/orca-cli-install-state-event'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'

export type OrcaCliInstallStatusState = {
  status: CliInstallStatus | null
  checked: boolean
  loading: boolean
  registered: boolean
  /** This client cannot read the CLI on the host where agents run (paired web client or remote runtime). */
  unverifiable: boolean
  refresh: () => void
}

type CliStatusSnapshot = {
  status: CliInstallStatus | null
  checked: boolean
  loading: boolean
}

type TargetEntry = {
  snapshot: CliStatusSnapshot
  settledAt: number | null
  inFlightReadId: number | null
  runtimeReaders: Set<() => OrcaCliSkillRuntime>
}

// Why: focus and visibilitychange both fire on return; one read answers both.
const FOCUS_REREAD_FRESH_MS = 1_000
const UNCHECKED_SNAPSHOT: CliStatusSnapshot = Object.freeze({
  status: null,
  checked: false,
  loading: false
})
// Why: several readers stay mounted app-wide and a WSL read spawns wsl.exe, so
// every reader shares one status and one read per install target.
const targets = new Map<string, TargetEntry>()
const storeSubscribers = new Set<() => void>()
let interestedReaderCount = 0
let nextReadId = 0

function getTarget(key: string): TargetEntry {
  let entry = targets.get(key)
  if (!entry) {
    entry = {
      snapshot: UNCHECKED_SNAPSHOT,
      settledAt: null,
      inFlightReadId: null,
      runtimeReaders: new Set()
    }
    targets.set(key, entry)
  }
  return entry
}

function publish(entry: TargetEntry, snapshot: CliStatusSnapshot): void {
  entry.snapshot = snapshot
  for (const subscriber of storeSubscribers) {
    subscriber()
  }
}

function readTarget(key: string, force: boolean): void {
  const entry = targets.get(key)
  const readRuntime = entry?.runtimeReaders.values().next().value
  if (!entry || !readRuntime) {
    return
  }
  if (!force && entry.inFlightReadId !== null) {
    return
  }
  if (!force && entry.settledAt !== null && Date.now() - entry.settledAt < FOCUS_REREAD_FRESH_MS) {
    return
  }
  const readId = ++nextReadId
  entry.inFlightReadId = readId
  if (!entry.snapshot.loading) {
    publish(entry, { ...entry.snapshot, loading: true })
  }
  // Why: a forced read supersedes an earlier one, whose older answer must not land.
  const settle = (status: CliInstallStatus | null): void => {
    if (entry.inFlightReadId !== readId) {
      return
    }
    entry.inFlightReadId = null
    entry.settledAt = Date.now()
    publish(entry, { status, checked: true, loading: false })
  }
  readOrcaCliInstallStatus(readRuntime()).then(settle, () => settle(null))
}

function readInterestedTargets(force: boolean): void {
  for (const [key, entry] of targets) {
    if (entry.runtimeReaders.size > 0) {
      readTarget(key, force)
    }
  }
}

function handleWindowFocus(): void {
  readInterestedTargets(false)
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    readInterestedTargets(false)
  }
}

function handleCliStateChange(): void {
  readInterestedTargets(true)
}

/** Registers interest in a target; the first reader installs one set of listeners for all. */
function watchTarget(key: string, readRuntime: () => OrcaCliSkillRuntime): () => void {
  const entry = getTarget(key)
  entry.runtimeReaders.add(readRuntime)
  interestedReaderCount += 1
  if (interestedReaderCount === 1) {
    // Why: users register the CLI from Settings or a shell, so re-read on return.
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleCliStateChange)
    window.addEventListener(ORCA_CLI_INSTALL_STATE_EVENT, handleCliStateChange)
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  readTarget(key, false)
  return () => {
    entry.runtimeReaders.delete(readRuntime)
    interestedReaderCount -= 1
    if (interestedReaderCount === 0) {
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleCliStateChange)
      window.removeEventListener(ORCA_CLI_INSTALL_STATE_EVENT, handleCliStateChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }
}

function subscribeStore(subscriber: () => void): () => void {
  storeSubscribers.add(subscriber)
  return () => {
    storeSubscribers.delete(subscriber)
  }
}

/** Runtime-aware read of whether agents can run the `orca` command. */
export function useOrcaCliInstallStatus(
  activeSkillRuntime: OrcaCliSkillRuntime,
  { enabled = true }: { enabled?: boolean } = {}
): OrcaCliInstallStatusState {
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  // Why: the local CLI says nothing about a host this window only reaches over RPC.
  const unverifiable =
    isPairedWebClientWindow() || (runtimeTarget !== null && runtimeTarget.kind !== 'local')
  const probeEnabled = enabled && runtimeTarget !== null && !unverifiable
  const probeKey = getOrcaCliInstallTargetKey(activeSkillRuntime)
  // Why: the status is keyed by target, not by the caller's runtime object identity.
  const runtimeRef = useRef(activeSkillRuntime)
  // Why: reads start from effects and event handlers, so the ref is current by then without a render-time write.
  useEffect(() => {
    runtimeRef.current = activeSkillRuntime
  }, [activeSkillRuntime])

  useEffect(() => {
    if (!probeEnabled) {
      return
    }
    return watchTarget(probeKey, () => runtimeRef.current)
  }, [probeEnabled, probeKey])

  const getSnapshot = (): CliStatusSnapshot =>
    probeEnabled ? (targets.get(probeKey)?.snapshot ?? UNCHECKED_SNAPSHOT) : UNCHECKED_SNAPSHOT
  const current = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot)
  const refresh = useCallback((): void => {
    if (probeEnabled) {
      readTarget(probeKey, true)
    }
  }, [probeEnabled, probeKey])

  return {
    status: current.status,
    checked: unverifiable || current.checked,
    loading: probeEnabled && (!current.checked || current.loading),
    registered: isOrcaCliAvailableOnPath(current.status),
    unverifiable,
    refresh
  }
}

export const _orcaCliInstallStatusStoreForTests = {
  reset(): void {
    targets.clear()
    nextReadId = 0
  }
}
