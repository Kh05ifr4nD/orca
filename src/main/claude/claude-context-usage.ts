// What the Claude CLI says about its context window, in the journal's shape,
// and the `get_context_usage` request that asks for the breakdown.

import type {
  AgentSessionContextReport,
  AgentSessionContextUsageCategory,
  AgentSessionTokenUsage
} from '../../shared/agent-session-context-usage'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'

const MAX_CATEGORIES = 64
const MAX_CATEGORY_NAME_LENGTH = 80
/** A report later than this describes a context the user has likely moved past. */
export const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The API's accounting on an assistant frame; null for the all-zero usage the
 *  CLI stamps on rows it synthesizes, which say nothing about the window. */
export function claudeTokenUsage(value: unknown): AgentSessionTokenUsage | null {
  if (!isRecord(value)) {
    return null
  }
  const usage = {
    inputTokens: positiveCount(value.input_tokens),
    cacheCreationInputTokens: positiveCount(value.cache_creation_input_tokens),
    cacheReadInputTokens: positiveCount(value.cache_read_input_tokens),
    outputTokens: positiveCount(value.output_tokens)
  }
  const total =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens
  return total > 0 ? usage : null
}

/** The session's window from a result's per-model usage. Auxiliary models
 *  (a small model for side calls) report their own smaller windows, so the
 *  largest is the one the main loop runs in. */
export function claudeContextWindowFromResult(message: Record<string, unknown>): number | null {
  if (!isRecord(message.modelUsage)) {
    return null
  }
  let largest = 0
  for (const usage of Object.values(message.modelUsage)) {
    if (isRecord(usage)) {
      largest = Math.max(largest, positiveCount(usage.contextWindow))
    }
  }
  return largest > 0 ? largest : null
}

/** A frame after which the CLI's context no longer holds what it held: a
 *  compaction, or a conversation reset. */
export function claudeContextResetKind(
  message: Record<string, unknown>
): 'compaction' | 'conversation' | null {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    return 'compaction'
  }
  return message.type === 'conversation_reset' ? 'conversation' : null
}

function categoryName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  return name.length > 0 && name.length <= MAX_CATEGORY_NAME_LENGTH ? name : null
}

/** The `get_context_usage` answer; null when it is unusable. */
export function claudeContextReportFromControl(
  value: unknown,
  capturedAt: number
): AgentSessionContextReport | null {
  if (!isRecord(value)) {
    return null
  }
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const usedTokens = count(value.totalTokens)
  const windowTokens = count(value.rawMaxTokens) || count(value.maxTokens)
  if (!model || usedTokens === null || !windowTokens) {
    return null
  }
  const categories: AgentSessionContextUsageCategory[] = []
  const rows = Array.isArray(value.categories) ? value.categories.filter(isRecord) : []
  for (const entry of rows.slice(0, MAX_CATEGORIES)) {
    const name = categoryName(entry.name)
    const tokens = count(entry.tokens)
    if (name && tokens !== null) {
      categories.push({ name, tokens, ...(entry.isDeferred === true ? { deferred: true } : {}) })
    }
  }
  const autoCompactAtTokens =
    value.isAutoCompactEnabled === true ? count(value.autoCompactThreshold) : null
  return {
    model,
    usedTokens,
    windowTokens,
    percentage: count(value.percentage) ?? Math.round((usedTokens / windowTokens) * 100),
    ...(autoCompactAtTokens !== null ? { autoCompactAtTokens } : {}),
    categories,
    capturedAt
  }
}

export type ClaudeContextUsageCaptureOptions = {
  now?: () => number
  timeoutMs?: number
}

export type ClaudeContextUsageReader = Pick<ClaudeStreamJsonConnection, 'getContextUsage'>

export type ClaudeContextUsageTarget = Pick<
  ClaudeJournalTranslator,
  'subscribeContextUsageRequests' | 'annotateTurnContextUsage' | 'contextActivity'
>

/**
 * Ask the CLI for its breakdown whenever the translator says one is due, and
 * record the answer on the turn the request named. An answer is dropped when
 * conversation activity or a newer request followed the ask, since it may no
 * longer describe the context; a failure (an older CLI, a closed child, a
 * timeout) leaves the row as it was.
 */
export function bindClaudeContextUsageCapture(
  connection: ClaudeContextUsageReader,
  translator: ClaudeContextUsageTarget | null,
  options: ClaudeContextUsageCaptureOptions
): (() => void) | undefined {
  if (!translator) {
    return undefined
  }
  let bound = true
  let requests = 0
  const unsubscribe = translator.subscribeContextUsageRequests((turnId) => {
    const request = ++requests
    const activity = translator.contextActivity
    void connection
      .getContextUsage({ timeoutMs: options.timeoutMs ?? CLAUDE_CONTEXT_USAGE_TIMEOUT_MS })
      .then(
        (answer) => {
          if (!bound || request !== requests || activity !== translator.contextActivity) {
            return
          }
          const report = claudeContextReportFromControl(answer, options.now?.() ?? Date.now())
          if (report) {
            translator.annotateTurnContextUsage(turnId, { report })
          }
        },
        () => {}
      )
  })
  return () => {
    bound = false
    unsubscribe()
  }
}
