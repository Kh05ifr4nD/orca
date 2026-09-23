import type { AgentChildWorkKind } from './agent-status-child-work'

/** A prompt the teardown cancelled while the session waited on the user. */
export type AgentSessionRestartPrompt = { kind: 'approval' | 'question'; label: string }

/** A child the teardown stopped: a subagent, background command, monitor or workflow. */
export type AgentSessionRestartTask = { kind: AgentChildWorkKind; label: string }

/**
 * What a restart cut off in one session, read from its journal — never stored. Sent with an offer
 * so the surface can say what each chat was doing; absent from offers an older host lists.
 */
export type AgentSessionRestartActivity = {
  /** The session's own turn was cut off partway through a reply. */
  midReply: boolean
  prompts: AgentSessionRestartPrompt[]
  tasks: AgentSessionRestartTask[]
}
