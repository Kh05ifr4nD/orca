// The context window a structured session reads from its own journal's turn
// rows. The used count is the newest of three facts: the provider's `/context`
// report, the usage on the newest main-thread response (an estimate, the
// arithmetic the provider's statusline uses), or a compaction/reset that makes it
// unknown. The window is the newest one the provider reported. Nothing is held
// outside the journal, so a restart replays the same answer.

import {
  contextTokensFromUsage,
  type AgentSessionContextUsageCategory
} from './agent-session-context-usage'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'

export type StructuredAgentContextUsage = {
  usedTokens: number
  windowTokens: number
  /** Rounded and unclamped, so an over-limit session reads above 100. */
  percentage: number
  /** True when the count comes from the last response rather than a report. */
  estimated: boolean
  /** The provider's breakdown; empty for an estimate. */
  categories: readonly AgentSessionContextUsageCategory[]
}

type UsedFact =
  | { at: number; usage: StructuredAgentContextUsage }
  | { at: number; estimatedTokens: number }
  | { at: number; unknown: true }

export function selectStructuredAgentContextUsage(
  items: readonly AgentJournalRenderItem[]
): StructuredAgentContextUsage | null {
  let used: UsedFact | null = null
  let window: { at: number; tokens: number } | null = null
  // Later journal position breaks a clock tie.
  const newer = (at: number, current: { at: number } | null): boolean =>
    current === null || at >= current.at
  for (const item of items) {
    const facts = readAgentJournalTurn(item.body)?.contextUsage
    if (!facts) {
      continue
    }
    if (facts.window && newer(facts.window.capturedAt, window)) {
      window = { at: facts.window.capturedAt, tokens: facts.window.tokens }
    }
    const report = facts.report
    if (report) {
      if (newer(report.capturedAt, window)) {
        window = { at: report.capturedAt, tokens: report.windowTokens }
      }
      if (newer(report.capturedAt, used)) {
        used = {
          at: report.capturedAt,
          usage: {
            usedTokens: report.usedTokens,
            windowTokens: report.windowTokens,
            percentage: report.percentage,
            estimated: false,
            categories: report.categories
          }
        }
      }
    }
    const response = facts.response
    const responseTokens = response ? contextTokensFromUsage(response.usage) : 0
    if (response && responseTokens > 0 && newer(response.capturedAt, used)) {
      used = { at: response.capturedAt, estimatedTokens: responseTokens }
    }
    if (facts.resetAt !== undefined && newer(facts.resetAt, used)) {
      used = { at: facts.resetAt, unknown: true }
    }
  }
  if (!used || 'unknown' in used) {
    return null
  }
  if ('usage' in used) {
    return used.usage
  }
  return window
    ? {
        usedTokens: used.estimatedTokens,
        windowTokens: window.tokens,
        percentage: Math.round((used.estimatedTokens / window.tokens) * 100),
        estimated: true,
        categories: []
      }
    : null
}
