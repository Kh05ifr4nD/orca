// Where the Claude CLI's context facts land in the journal, and when a fresh
// `/context` breakdown is worth asking for. The facts live on turn rows; this
// holds only what tells a late answer it is stale and whose window a result reports.

import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import {
  claudeContextResetKind,
  claudeContextWindowFromResult,
  claudeModelUsageTotals,
  claudeTokenUsage
} from './claude-context-usage'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { ClaudeTurnEnd } from './claude-turn-lifecycle-item'
import { isRootClaudeFrame } from './claude-turn-opening'

const CONVERSATION_FRAME_TYPES = new Set(['assistant', 'user', 'stream_event'])

export class ClaudeContextFacts {
  private activity = 0
  /** Model that served the newest main-thread response: whose window the result's usage should report. */
  private mainModel: string | null = null
  /** The last response fact written, so a response's per-block frames revise its row once. */
  private lastResponse: string | null = null
  /** The previous result's cumulative per-model totals, to see which models a result moved. */
  private modelTotals: ReadonlyMap<string, number> = new Map()
  private readonly requestListeners = new Set<(turnId: string) => void>()

  constructor(private readonly turn: ClaudeOpenTurn) {}

  /** Bumped whenever the main conversation moves; a subagent's frames leave the
   *  session's own context as it was. */
  get activityRevision(): number {
    return this.activity
  }

  markActivity(): void {
    this.activity += 1
  }

  /** Every frame, ahead of journaling it. */
  observe(message: Record<string, unknown>, observedAt: number): void {
    if (CONVERSATION_FRAME_TYPES.has(String(message.type)) && isRootClaudeFrame(message)) {
      this.markActivity()
    }
    const reset = claudeContextResetKind(message)
    if (!reset) {
      return
    }
    // The pre-reset size must not outlive the reset; the next response or report restates it.
    this.lastResponse = null
    this.annotateLatest({ resetAt: observedAt })
    if (reset === 'compaction') {
      this.requestReport()
    }
  }

  /** A frame after it is journaled, so a response lands on the turn it opened.
   *  Every main-thread response counts, text or not: tool-only ones are where
   *  the context grows fastest. */
  observeResponse(message: Record<string, unknown>, observedAt: number): void {
    if (message.type !== 'assistant' || !isRootClaudeFrame(message)) {
      return
    }
    const response = claudeRecord(message.message)
    // Synthetic rows carry no usage and a placeholder model; neither says anything about the window.
    const usage = claudeTokenUsage(response?.usage)
    if (!usage) {
      return
    }
    const model = claudeText(response?.model)
    this.mainModel = model ?? this.mainModel
    const turnId = this.turn.latestId
    const key = JSON.stringify([turnId, usage, model])
    if (turnId === null || key === this.lastResponse) {
      return
    }
    this.lastResponse = key
    this.turn.annotate(turnId, {
      response: { usage, ...(model ? { model } : {}), capturedAt: observedAt }
    })
  }

  /** End the turn a root result settles, with the window its per-model usage
   *  reports, then ask for the breakdown. */
  settle(message: Record<string, unknown>, end: ClaudeTurnEnd): void {
    const tokens = claudeContextWindowFromResult(message, {
      model: this.mainModel,
      previousTotals: this.modelTotals
    })
    this.modelTotals = claudeModelUsageTotals(message)
    const facts = tokens === null ? undefined : { window: { tokens, capturedAt: end.completedAt } }
    const wasOpen = this.turn.isOpen
    this.turn.settle(end, facts)
    if (!wasOpen && facts) {
      this.annotateLatest(facts)
    }
    this.requestReport()
  }

  annotate(turnId: string, contextUsage: AgentSessionContextUsage): boolean {
    return this.turn.annotate(turnId, contextUsage)
  }

  subscribeReportRequests(listener: (turnId: string) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  dispose(): void {
    this.requestListeners.clear()
  }

  private annotateLatest(contextUsage: AgentSessionContextUsage): void {
    const turnId = this.turn.latestId
    if (turnId !== null) {
      this.turn.annotate(turnId, contextUsage)
    }
  }

  private requestReport(): void {
    const turnId = this.turn.latestId
    if (turnId === null) {
      return
    }
    for (const listener of this.requestListeners) {
      listener(turnId)
    }
  }
}
