// The context window a structured session reads from its own journal's turn
// rows. Facts are written only to the open or newest turn and each write
// replaces its namesake, so the newest row carrying a part holds its current
// value. Nothing is held outside the journal, so a restart replays the same answer.

import {
  contextTokensFromUsage,
  type AgentSessionContextUsageCategory,
  type AgentSessionContextUsed,
  type AgentSessionContextWindow
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

export function selectStructuredAgentContextUsage(
  items: readonly AgentJournalRenderItem[]
): StructuredAgentContextUsage | null {
  let used: { sequence: number; fact: AgentSessionContextUsed } | null = null
  let window: { sequence: number; fact: AgentSessionContextWindow } | null = null
  for (const item of items) {
    const facts = readAgentJournalTurn(item.body)?.contextUsage
    if (facts?.used && (used === null || item.sequence >= used.sequence)) {
      used = { sequence: item.sequence, fact: facts.used }
    }
    if (facts?.window && (window === null || item.sequence >= window.sequence)) {
      window = { sequence: item.sequence, fact: facts.window }
    }
  }
  const fact = used?.fact
  if (fact?.kind === 'report') {
    return {
      usedTokens: fact.usedTokens,
      windowTokens: fact.windowTokens,
      percentage: fact.percentage,
      estimated: false,
      categories: fact.categories
    }
  }
  // `unknown`, or a kind a newer host writes that this client cannot measure.
  if (fact?.kind !== 'estimate') {
    return null
  }
  // The writer holds estimates back across a model change, so the newest window is this model's.
  if (!window) {
    return null
  }
  const usedTokens = contextTokensFromUsage(fact.usage)
  return {
    usedTokens,
    windowTokens: window.fact.tokens,
    percentage: Math.round((usedTokens / window.fact.tokens) * 100),
    estimated: true,
    categories: []
  }
}
