import { isAgentSessionId } from './agent-session-record'

/**
 * An orchestration party that is not a terminal, as `(kind, id)`. Stored in the `…_actor` columns
 * and addressed in the mailbox namespace as `<kind>:<id>`, beside `run:<id>` and `dispatch:<id>`,
 * so the stored value and the address are one spelling.
 *
 * The only kind is a structured session, keyed by the id Orca minted for it — never the provider's
 * id, which rotates on `/clear`. Where the session runs is not part of the key; it is read from the
 * session record when needed. PTY agents have no actor: a pane outlives the agent in it, so a
 * pane-keyed actor would be inherited by the pane's next occupant.
 */
const ACTOR_ID_PREDICATES = {
  session: isAgentSessionId
} as const satisfies Record<string, (id: string) => boolean>

export type OrchestrationActorKind = keyof typeof ACTOR_ID_PREDICATES

export type OrchestrationActor = { kind: OrchestrationActorKind; id: string }

function isOrchestrationActorKind(kind: string): kind is OrchestrationActorKind {
  return Object.hasOwn(ACTOR_ID_PREDICATES, kind)
}

export function formatOrchestrationActor(actor: OrchestrationActor): string {
  return `${actor.kind}:${actor.id}`
}

/** The stored and addressed spelling only. An unknown kind reads as null, never as a session. */
export function parseOrchestrationActor(
  value: string | null | undefined
): OrchestrationActor | null {
  const separator = value?.indexOf(':') ?? -1
  if (!value || separator <= 0) {
    return null
  }
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  return isOrchestrationActorKind(kind) && ACTOR_ID_PREDICATES[kind](id) ? { kind, id } : null
}

export function sessionOrchestrationActor(sessionId: string): OrchestrationActor | null {
  return isAgentSessionId(sessionId) ? { kind: 'session', id: sessionId } : null
}

/**
 * For input already known to name a session: its address, or its bare Orca session id. Not for a
 * recipient slot, where a bare string is a terminal handle.
 */
export function normalizeOrchestrationActor(value: string): OrchestrationActor | null {
  return parseOrchestrationActor(value) ?? sessionOrchestrationActor(value)
}
