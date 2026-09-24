// The journal note left where a turn stopped because Orca itself went away: a quit mid-turn, or a
// crash. Host-authored and durable, so every client shows it; `text` is what a client without the
// presentation draws, and the presentation lets one draw it as a quiet divider in its own language.

export const AGENT_SESSION_RESTART_INTERRUPTION_PRESENTATION = 'restart-interruption'

export const AGENT_SESSION_RESTART_INTERRUPTION_NOTE =
  'Orca restarted while this was running. Send a message to continue.'

/** Keyed by the cut-off turn, so every settlement that reaches that turn writes the same row. */
export function agentSessionRestartInterruptionNoteId(turnId: string): string {
  return `restart-interruption:${turnId}`
}
