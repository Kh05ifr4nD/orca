// What the provider has said about a session's context window, as facts on
// turn rows. Writes land only on the open or newest turn and each replaces its
// namesake, so a reader takes the part from the newest row that carries it.

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

/** Longest model id a fact records; a longer one is not a model id. */
export const MAX_CONTEXT_MODEL_ID_CHARS = 256
export const MAX_CONTEXT_CATEGORIES = 64
export const MAX_CONTEXT_CATEGORY_NAME_CHARS = 80

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

/** The window of the main thread's model, and the model it was measured for. */
export type AgentSessionContextWindow = {
  tokens: number
  /** The provider's key for the model, e.g. `claude-opus-5[1m]`. */
  model: string
  /** The provider's canonical id when its key is provider-specific. */
  canonicalModel?: string
  capturedAt: number
}

/** How much of the window is in use, as last learned. */
export type AgentSessionContextUsed =
  | ({ kind: 'report' } & AgentSessionContextReport)
  /** The newest main-thread response, whatever its blocks: its input is the
   *  live context size. A subagent's measures its own window. */
  | { kind: 'estimate'; usage: AgentSessionTokenUsage; model?: string; capturedAt: number }
  /** Compaction or a conversation reset: unknown until a response or report restates it. */
  | { kind: 'unknown'; capturedAt: number }

/** Context facts on a turn row. An absent part says nothing. */
export type AgentSessionContextUsage = {
  window?: AgentSessionContextWindow
  used?: AgentSessionContextUsed
}

/** `claude-opus-5[1m]` and `Claude-Opus-5` name the same model; the suffix picks a window, not a model. */
export function contextBaseModelId(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/u, '')
    .trim()
    .toLowerCase()
}

/** Whether an estimate's model is the one the window was measured for. The
 *  `[1m]` suffix must agree too: it is what tells a 1M window from a 200k one. */
export function contextWindowServesModel(
  window: AgentSessionContextWindow,
  model: string
): boolean {
  const id = model.trim().toLowerCase()
  return [window.model, window.canonicalModel].some(
    (name) => name !== undefined && name.trim().toLowerCase() === id
  )
}
