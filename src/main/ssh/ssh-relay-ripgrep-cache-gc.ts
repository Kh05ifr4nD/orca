/**
 * Garbage collection for the remote ripgrep cache.
 *
 * Nothing else collects this tree: the version GC in `remote-install-gc.ts` only matches
 * `relay-*`, so every change to the shipped ripgrep bytes used to leave another ~5 MB on every
 * SSH host, permanently. Age cannot decide it -- a directory's mtime is when it was written, not
 * when it was last used, so an old entry may still be the binary a live relay was launched with.
 * Deleting that one is not a graceful degradation: without a PATH ripgrep, remote text search
 * fails outright and listing falls back to the capped walk this PR exists to remove.
 *
 * So the question is reference, not age, and the discipline is `ssh-relay-native-deps-cache-gc.ts`':
 * **anything this pass cannot account for blocks the whole pass.** A relay directory whose
 * reference marker is missing or unreadable aborts it, because a relay deployed by an older Orca
 * holds a binary it never recorded -- and inferring which one is exactly the guess that breaks a
 * live search. Those directories are removed by the version GC in time, and an entry becomes
 * collectable once the installations referencing it are gone.
 *
 * Deletion is the same three-step move: rename to a tombstone, re-read the references under the
 * rename, and only then remove.
 */
import { shellEscape } from './ssh-connection-utils'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  REMOTE_RIPGREP_CACHE_DIR_NAME,
  remoteRipgrepRefFileName
} from './ssh-relay-ripgrep-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { moveRemoteTreeCommand, removeRemoteTreeCommand } from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

const LIST_OK = '__ORCA_RG_CACHE__LIST_OK'
const REFS_OK = '__ORCA_RG_CACHE__REFS_OK'
const REFS_ERR = '__ORCA_RG_CACHE__REFS_ERR'
const TOMBSTONE_PREFIX = '.rg-gc-'
/** Bounds every listing, the way MAX_RELAY_GC_LISTING_ENTRIES bounds version dirs. */
const MAX_LISTING_ENTRIES = 64
/** An entry name is `<16-hex-content-hash>-<os>-<arch>`; only names this client mints are eligible. */
const ENTRY_NAME = /^[0-9a-f]{16}-(?:linux|darwin|win32)-(?:x64|arm64)$/

/** Windows remotes have no pass yet, matching the native-deps cache's own POSIX gate. */
export function supportsRipgrepCacheGc(host: RemoteHostPlatform): boolean {
  return !isWindowsRemoteHost(host)
}

function cacheDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, REMOTE_RIPGREP_CACHE_DIR_NAME)
}

function exec(conn: SshConnection, host: RemoteHostPlatform, command: string): Promise<string> {
  return execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(host) })
}

function listEntriesCommand(host: RemoteHostPlatform, remoteHome: string): string {
  const dir = shellEscape(cacheDir(host, remoteHome))
  return [
    `d=${dir}`,
    `[ -d "$d" ] || { printf '%s\\n' ${LIST_OK}; exit 0; }`,
    // A tombstone older than any in-flight pass is drained here, the way the stage sweep drains.
    `find "$d" -mindepth 1 -maxdepth 1 -type d -name '${TOMBSTONE_PREFIX}*' -mmin +30 -exec rm -rf {} + 2>/dev/null`,
    'for e in "$d"/*; do',
    '  [ -d "$e" ] || continue',
    `  printf 'ENTRY %s\\n' "$(basename "$e")"`,
    'done',
    `printf '%s\\n' ${LIST_OK}`
  ].join('\n')
}

/**
 * Every relay directory's recorded ripgrep entry.
 *
 * A relay directory with no readable marker answers `REFS_ERR`: it may be an older Orca's relay,
 * running right now against a binary it never recorded.
 */
function listReferencesCommand(host: RemoteHostPlatform, remoteHome: string): string {
  const root = shellEscape(joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR))
  return [
    `root=${root}`,
    `[ -d "$root" ] || { printf '%s\\n' ${REFS_OK}; exit 0; }`,
    'n=0',
    'for d in "$root"/relay-*; do',
    '  [ -d "$d" ] || continue',
    `  f="$d"/${remoteRipgrepRefFileName()}`,
    `  [ -f "$f" ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    '  t=$(cat "$f" 2>/dev/null) || t=""',
    `  [ -n "$t" ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    `  printf 'REF %s\\n' "$t"`,
    '  n=$((n+1))',
    `  if [ "$n" -ge ${MAX_LISTING_ENTRIES} ]; then printf '%s\\n' ${REFS_ERR}; exit 0; fi`,
    'done',
    `printf '%s\\n' ${REFS_OK}`
  ].join('\n')
}

type ReferenceScan = { readable: true; referenced: Set<string> } | { readable: false }

function parseEntries(output: string): string[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (!lines.includes(LIST_OK)) {
    return []
  }
  const entries: string[] = []
  for (const line of lines) {
    if (!line.startsWith('ENTRY ')) {
      continue
    }
    const name = line.slice('ENTRY '.length)
    // Why re-validate a name the host produced: it is about to be interpolated into `mv` and
    // `rm -rf`. Only names this client could itself have minted are eligible.
    if (ENTRY_NAME.test(name) && entries.length < MAX_LISTING_ENTRIES) {
      entries.push(name)
    }
  }
  return entries
}

async function scanReferences(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string
): Promise<ReferenceScan> {
  let output: string
  try {
    output = await exec(conn, host, listReferencesCommand(host, remoteHome))
  } catch {
    return { readable: false }
  }
  const lines = output.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(REFS_ERR) || !lines.includes(REFS_OK)) {
    return { readable: false }
  }
  const referenced = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('REF ')) {
      continue
    }
    const name = line.slice('REF '.length).trim()
    // An unrecognised marker is a reference this client cannot attribute, so it blocks the pass
    // rather than being ignored.
    if (!ENTRY_NAME.test(name)) {
      return { readable: false }
    }
    referenced.add(name)
  }
  return { readable: true, referenced }
}

/** Collect ripgrep builds that no relay installation references. Never throws. */
export async function gcRemoteRipgrepCache(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { pinnedEntry?: string | undefined } = {}
): Promise<void> {
  if (!supportsRipgrepCacheGc(host)) {
    return
  }
  try {
    const entries = parseEntries(await exec(conn, host, listEntriesCommand(host, remoteHome)))
    if (entries.length === 0) {
      return
    }
    const scan = await scanReferences(conn, host, remoteHome)
    if (!scan.readable) {
      return
    }
    const removed: string[] = []
    for (const entry of entries) {
      if (scan.referenced.has(entry) || entry === options.pinnedEntry) {
        continue
      }
      if (await removeUnreferencedEntry(conn, host, remoteHome, entry)) {
        removed.push(entry)
      }
    }
    if (removed.length > 0) {
      console.log(`[ssh-relay] ripgrep cache GC: removed ${removed.length}: ${removed.join(', ')}`)
    }
  } catch {
    /* Never fails a deploy; the next connect tries again. */
  }
}

async function removeUnreferencedEntry(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  entry: string
): Promise<boolean> {
  const base = cacheDir(host, remoteHome)
  const entryDir = joinRemotePath(host, base, entry)
  const tombstone = joinRemotePath(
    host,
    base,
    `${TOMBSTONE_PREFIX}${entry}.${process.pid}.${Date.now()}`
  )
  try {
    if (
      (await exec(conn, host, moveRemoteTreeCommand(host, entryDir, tombstone))).trim() !== 'MOVED'
    ) {
      return false
    }
  } catch {
    return false
  }
  // Why recheck under the rename: a deploy that read this entry as present can still be writing
  // its marker. Its reference now names a path that no longer exists, so restoring the tree is
  // the only outcome that leaves that relay with a working ripgrep.
  const recheck = await scanReferences(conn, host, remoteHome)
  if (!recheck.readable || recheck.referenced.has(entry)) {
    await exec(conn, host, moveRemoteTreeCommand(host, tombstone, entryDir)).catch(() => {})
    return false
  }
  try {
    await exec(conn, host, removeRemoteTreeCommand(host, tombstone))
    return true
  } catch {
    // The sweep in the entry listing drains a tombstone this pass could not remove.
    return false
  }
}
