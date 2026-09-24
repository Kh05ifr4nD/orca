import type {
  AgentSessionStoreState,
  LoadedAgentSessionStore
} from './agent-session-record-store-file'
export function parseVisibleSessionIds(
  raw: unknown,
  schemaVersion: number,
  currentSchemaVersion: number
): { ids: string[]; present: boolean; valid: boolean } {
  if (raw === undefined) {
    return { ids: [], present: false, valid: true }
  }
  if (!Array.isArray(raw)) {
    return { ids: [], present: false, valid: schemaVersion !== currentSchemaVersion }
  }
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value)
    } else if (schemaVersion === currentSchemaVersion) {
      return { ids: [], present: true, valid: false }
    }
  }
  return { ids, present: true, valid: true }
}

/** A file that predates the index lists its chat tabs only in the saved workspace session; the
 *  index starts from those whenever such a file loads, so no later write can start it smaller. */
export function adoptSavedTabsIntoLegacyIndex(
  loaded: LoadedAgentSessionStore,
  savedTabSessionIds: () => readonly string[]
): void {
  if (!loaded.storeFound || loaded.visibleTabIndexFound) {
    return
  }
  for (const savedId of savedTabSessionIds()) {
    if (loaded.state.records.has(savedId)) {
      loaded.state.visibleSessionIds.add(savedId)
    }
  }
  loaded.needsRewrite = true
}

export function setVisibleSessionId(
  state: AgentSessionStoreState,
  sessionId: string,
  visible: boolean
): void {
  if (visible) {
    if (!state.records.has(sessionId)) {
      throw new Error('agent_session_identity_required')
    }
    state.visibleSessionIds.add(sessionId)
  } else {
    state.visibleSessionIds.delete(sessionId)
  }
}
