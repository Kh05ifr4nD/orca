// What the provider has said about a session's context window, as facts on
// journal rows. Each fact carries the host clock it was learned at, and readers
// take the newest: a revised row keeps its place in the transcript, so journal
// order alone cannot say which fact is current.

/** The API's accounting on one assistant response. */
export type AgentSessionTokenUsage = {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

/** Everything the model read on that request, which is what fills the window. */
export function contextTokensFromUsage(usage: AgentSessionTokenUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
}

/** One row of the provider's breakdown, as it names and counts it. */
export type AgentSessionContextUsageCategory = {
  /** Display name as the provider renders it, e.g. `Messages`. */
  name: string
  tokens: number
  /** Listed for awareness but loaded on demand, so outside the used count. */
  deferred?: true
}

/** The provider's own `/context` answer. */
export type AgentSessionContextReport = {
  /** Model the report was measured for. */
  model: string
  usedTokens: number
  windowTokens: number
  /** The provider's rounding, unclamped: an over-limit session reads above 100. */
  percentage: number
  /** Where the provider compacts on its own, when auto-compaction is on. */
  autoCompactAtTokens?: number
  categories: AgentSessionContextUsageCategory[]
  capturedAt: number
}

/** Context facts on a turn row. Each part has its own clock and is revised
 *  independently; an absent part says nothing. */
export type AgentSessionContextUsage = {
  /** The largest window the provider reported for the session's models. */
  window?: { tokens: number; capturedAt: number }
  report?: AgentSessionContextReport
  /** The newest main-thread response in the turn, whatever its blocks: its
   *  input is the live context size. A subagent's measures its own window. */
  response?: { usage: AgentSessionTokenUsage; model?: string; capturedAt: number }
  /** Compaction or a conversation reset: the used count is unknown from here
   *  until the next response or report. */
  resetAt?: number
}
