import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { raiseAgentSessionFencesAfterBackupRecovery } from './agent-session-backup-recovery-fence'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStoreRevision,
  loadAgentSessionStore,
  saveAgentSessionStore,
  type AgentSessionStoreState,
  type LoadedAgentSessionStore
} from './agent-session-record-store-file'
import { withFileTransactionLock } from '../file-transaction-lock'
import { adoptSavedTabsIntoLegacyIndex } from './agent-session-visible-tab-index'
import type { AgentSessionHostRun } from './agent-session-host-run'

function markLoadedLeasesUnreconciled(state: AgentSessionStoreState): void {
  for (const [sessionId, record] of state.records) {
    state.records.set(sessionId, {
      ...record,
      lease: { ...record.lease, unreconciled: true }
    })
  }
}

function mapEntriesMatch<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false
    }
  }
  return true
}

function agentSessionStoreStateChanged(
  state: AgentSessionStoreState,
  records: ReadonlyMap<string, AgentSessionRecord>,
  operations: ReadonlyMap<string, AgentSessionOperationRow>,
  retiredClaimKeys: AgentSessionStoreState['retiredClaimKeys'],
  unreadableRecords: AgentSessionStoreState['unreadableRecords'],
  visibleSessionIds: AgentSessionStoreState['visibleSessionIds']
): boolean {
  return (
    !mapEntriesMatch(state.records, records) ||
    !mapEntriesMatch(state.operations, operations) ||
    !mapEntriesMatch(state.unreadableRecords, unreadableRecords) ||
    state.visibleSessionIds.size !== visibleSessionIds.size ||
    [...state.visibleSessionIds].some((id) => !visibleSessionIds.has(id)) ||
    state.retiredClaimKeys.length !== retiredClaimKeys.length ||
    state.retiredClaimKeys.some((entry, index) => entry !== retiredClaimKeys[index])
  )
}

/** How a host opens its record store, beyond where the file lives and which host it is. */
export type AgentSessionStoreOpenOptions = {
  /** The run that grants this store's fences; defaults to this process's own. */
  hostRun?: AgentSessionHostRun
  /** The chat tabs a profile saved before this store kept a visible-tab index; read only at load. */
  savedTabSessionIds?: () => readonly string[]
}

export class AgentSessionStoreTransactionQueue {
  private queue: Promise<unknown> = Promise.resolve()
  private diskRecoveredFromBackup: boolean
  private readonly savedTabSessionIds: () => readonly string[]

  constructor(
    private readonly filePath: string,
    readonly hostId: string,
    readonly readOnly: boolean,
    readonly recoveredFromBackup: boolean,
    private diskStoreFound: boolean,
    public state: AgentSessionStoreState,
    private diskRevision: string,
    private needsRewrite: boolean,
    options: AgentSessionStoreOpenOptions
  ) {
    this.diskRecoveredFromBackup = recoveredFromBackup
    this.savedTabSessionIds = options.savedTabSessionIds ?? (() => [])
  }

  static fromLoadedStore(
    filePath: string,
    hostId: string,
    loaded: LoadedAgentSessionStore,
    diskRevision: string,
    options: AgentSessionStoreOpenOptions
  ): AgentSessionStoreTransactionQueue {
    adoptSavedTabsIntoLegacyIndex(loaded, options.savedTabSessionIds ?? (() => []))
    return new AgentSessionStoreTransactionQueue(
      filePath,
      hostId,
      loaded.readOnly,
      loaded.recoveredFromBackup,
      loaded.storeFound,
      loaded.state,
      diskRevision,
      loaded.needsRewrite,
      options
    )
  }

  transact<T>(apply: () => T): Promise<T> {
    const run = this.queue.then(() =>
      withFileTransactionLock(this.filePath, async () => {
        if (this.readOnly) {
          throw new Error('agent_session_legacy_required')
        }
        await this.refreshExternallyChangedState()
        const records = new Map(this.state.records)
        const operations = new Map(this.state.operations)
        const retiredClaimKeys = [...this.state.retiredClaimKeys]
        const unreadableRecords = new Map(this.state.unreadableRecords)
        const visibleSessionIds = new Set(this.state.visibleSessionIds)
        try {
          // The lost commit may have granted a higher fence than the backup records show. Rather
          // than refuse forever, raise every recovered fence clear of anything that commit could
          // have minted, then continue in the same transaction.
          const recovering = this.diskRecoveredFromBackup
          if (recovering) {
            raiseAgentSessionFencesAfterBackupRecovery(this.state)
          }
          const result = apply()
          if (
            !recovering &&
            !this.needsRewrite &&
            !agentSessionStoreStateChanged(
              this.state,
              records,
              operations,
              retiredClaimKeys,
              unreadableRecords,
              visibleSessionIds
            )
          ) {
            return result
          }
          await saveAgentSessionStore(this.filePath, this.state, {
            primaryStatus: this.diskStoreFound && !recovering ? 'validated' : 'unusable-or-absent'
          })
          this.state.schemaVersion = AGENT_SESSION_STORE_SCHEMA_VERSION
          this.diskRevision = agentSessionStoreRevision(this.state)
          this.diskRecoveredFromBackup = false
          this.diskStoreFound = true
          this.needsRewrite = false
          return result
        } catch (error) {
          this.state.records = records
          this.state.operations = operations
          this.state.retiredClaimKeys = retiredClaimKeys
          this.state.unreadableRecords = unreadableRecords
          this.state.visibleSessionIds = visibleSessionIds
          throw error
        }
      })
    )
    this.queue = run.catch(() => {})
    return run
  }

  persistLoadedRewrite(): Promise<void> {
    return this.transact(() => undefined)
  }

  private async refreshExternallyChangedState(): Promise<void> {
    const loaded = await loadAgentSessionStore(this.filePath, this.hostId)
    if (this.diskStoreFound && !loaded.storeFound) {
      throw new Error('agent_session_store_corrupt')
    }
    this.diskStoreFound ||= loaded.storeFound
    // Hashed before adoption, like open()'s: the revision names what the file holds.
    const diskRevision = agentSessionStoreRevision(loaded.state)
    adoptSavedTabsIntoLegacyIndex(loaded, this.savedTabSessionIds)
    this.diskRecoveredFromBackup = loaded.recoveredFromBackup
    if (diskRevision === this.diskRevision) {
      this.needsRewrite ||= loaded.needsRewrite
      return
    }
    if (loaded.readOnly) {
      throw new Error('agent_session_legacy_required')
    }
    markLoadedLeasesUnreconciled(loaded.state)
    this.state = loaded.state
    this.diskRevision = diskRevision
    this.needsRewrite = loaded.needsRewrite
  }
}

export function markAgentSessionStoreLeasesUnreconciled(state: AgentSessionStoreState): void {
  markLoadedLeasesUnreconciled(state)
}
