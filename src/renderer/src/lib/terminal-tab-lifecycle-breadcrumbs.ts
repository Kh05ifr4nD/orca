import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import { redactPtyIdForDiagnostics } from '../../../shared/pty-delivery-diagnostics'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import { hashCrashBreadcrumbId } from './crash-breadcrumb-id-hash'

// Crumbs for tabs that vanish or lose focus without a user action (pty-exit close, disposed-spawn
// kill, automatic active-tab moves). Store-free so the transport and store slices can import it.

export const TERMINAL_TAB_LIFECYCLE_BREADCRUMB_WINDOW_MS = 60_000
/** Per crumb name per window; the 30-slot crash ring must survive a remount storm. */
export const TERMINAL_TAB_LIFECYCLE_BREADCRUMB_LIMIT = 10
const MAX_TRACKED_SPAWNS = 256

type RateWindow = { startMs: number; emitted: number; suppressed: number }
const rateWindowsByName = new Map<string, RateWindow>()
const spawnedAtMsByPtyId = new Map<string, number>()

function recordRateLimited(name: string, data: CrashReportBreadcrumbData): void {
  const nowMs = Date.now()
  let rate = rateWindowsByName.get(name)
  const elapsedMs = rate ? nowMs - rate.startMs : -1
  if (!rate || elapsedMs < 0 || elapsedMs >= TERMINAL_TAB_LIFECYCLE_BREADCRUMB_WINDOW_MS) {
    rate = { startMs: nowMs, emitted: 0, suppressed: rate?.suppressed ?? 0 }
    rateWindowsByName.set(name, rate)
  }
  if (rate.emitted >= TERMINAL_TAB_LIFECYCLE_BREADCRUMB_LIMIT) {
    rate.suppressed += 1
    return
  }
  rate.emitted += 1
  const suppressedSinceLast = rate.suppressed
  rate.suppressed = 0
  recordRendererCrashBreadcrumb(
    name,
    suppressedSinceLast > 0 ? { ...data, suppressedSinceLast } : data
  )
}

function hashOrNull(id: string | null | undefined): string | null {
  return id ? hashCrashBreadcrumbId(id) : null
}

export function notePtySpawnedForBreadcrumbs(ptyId: string): void {
  spawnedAtMsByPtyId.delete(ptyId)
  spawnedAtMsByPtyId.set(ptyId, Date.now())
  if (spawnedAtMsByPtyId.size > MAX_TRACKED_SPAWNS) {
    const oldest = spawnedAtMsByPtyId.keys().next().value
    if (oldest !== undefined) {
      spawnedAtMsByPtyId.delete(oldest)
    }
  }
}

function msSincePtySpawn(ptyId: string): number | null {
  const spawnedAtMs = spawnedAtMsByPtyId.get(ptyId)
  return spawnedAtMs === undefined ? null : Math.max(0, Date.now() - spawnedAtMs)
}

/** `disposed`: the transport was destroyed mid-spawn. `refused`: a live transport's admitPtyId said no. */
export type FreshSpawnRetirementPath = 'disposed' | 'refused'

export function recordFreshSpawnRetirementBreadcrumb(args: {
  path: FreshSpawnRetirementPath
  outcome: 'killed' | 'retained'
  ptyId: string
  tabId: string | undefined
  isSsh: boolean
  spawnWaitMs: number
}): void {
  recordRateLimited('terminal_fresh_spawn_retired', {
    path: args.path,
    outcome: args.outcome,
    hostKind: args.isSsh ? 'ssh' : 'local',
    ptyId: redactPtyIdForDiagnostics(args.ptyId),
    tabIdHash: hashOrNull(args.tabId),
    spawnWaitMs: Math.max(0, args.spawnWaitMs)
  })
}

export type TerminalHostKind = 'local' | 'ssh' | 'wsl'

export function recordTerminalTabPtyExitBreadcrumb(args: {
  outcome: 'closed' | 'kept-unverified' | 'deferred-parked'
  tabId: string
  ptyId: string
  exitCode: number | undefined
  /** No host-vouched status: an absent code or the host-loss sentinel. */
  synthetic: boolean
  hostKind: TerminalHostKind
}): void {
  recordRateLimited('terminal_tab_pty_exit', {
    outcome: args.outcome,
    hostKind: args.hostKind,
    synthetic: args.synthetic,
    exitCode: args.exitCode ?? null,
    msSinceSpawn: msSincePtySpawn(args.ptyId),
    ptyId: redactPtyIdForDiagnostics(args.ptyId),
    tabIdHash: hashCrashBreadcrumbId(args.tabId)
  })
}

export type ActiveTerminalTabAutoMove =
  | { reason: 'active-terminal-repair'; fallback: 'remembered' | 'first-tab' }
  | { reason: 'create-tab-orphan-sweep'; sweptCount: number }

export function recordActiveTerminalTabAutoMoveBreadcrumb(
  move: ActiveTerminalTabAutoMove & {
    fromTabId: string | null
    toTabId: string | null
    tabCount: number
  }
): void {
  recordRateLimited('terminal_active_tab_auto_move', {
    reason: move.reason,
    ...(move.reason === 'active-terminal-repair'
      ? { fallback: move.fallback }
      : { sweptCount: move.sweptCount }),
    fromTabIdHash: hashOrNull(move.fromTabId),
    toTabIdHash: hashOrNull(move.toTabId),
    tabCount: move.tabCount
  })
}

export function resetTerminalTabLifecycleBreadcrumbsForTests(): void {
  rateWindowsByName.clear()
  spawnedAtMsByPtyId.clear()
}
