// Where the Claude CLI's context facts land in the journal, and when a fresh
// `/context` breakdown is worth asking for. The facts live on turn rows and are
// written to the open turn, else the newest turn the journal holds; this keeps
// only what tells a late answer it is stale and whose window a result reports.

import {
  contextTokensFromUsage,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextReport,
  type AgentSessionContextUsage
} from '../../shared/agent-session-context-usage'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeContextResetKind,
  claudeContextWindowFromResult,
  claudeTokenUsage,
  type ClaudeMainThreadModel
} from './claude-context-usage'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import type { ClaudeTurnEnd } from './claude-turn-lifecycle-item'
import { isRootClaudeFrame } from './claude-turn-opening'
import { writeClaudeTurnRow, type ClaudeTurnRowTarget } from './claude-turn-row-revision'

const CONVERSATION_FRAME_TYPES = new Set(['assistant', 'user', 'stream_event'])

/** The turn a requested report describes; null when no turn was open to name. */
export type ClaudeContextReportTarget = string | null

export class ClaudeContextFacts {
  private activity = 0
  /** Whose window a result's per-model usage should report. */
  private mainModel: ClaudeMainThreadModel = { initModel: null, responseModel: null }
  /** The last response fact written, so a response's per-block frames revise its row once. */
  private lastResponse: string | null = null
  private readonly requestListeners = new Set<(target: ClaudeContextReportTarget) => void>()

  constructor(
    private readonly turn: ClaudeOpenTurn,
    private readonly sink: StructuredAgentSessionEventSink
  ) {}

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
    const initModel =
      message.type === 'system' && message.subtype === 'init' && isRootClaudeFrame(message)
        ? claudeText(message.model)
        : null
    if (initModel) {
      // The turn's init is the newest word on the model; its own responses follow it.
      this.mainModel = { initModel, responseModel: null }
    }
    const reset = claudeContextResetKind(message)
    if (!reset) {
      return
    }
    // A report asked for before the reset describes the context it replaced.
    this.markActivity()
    this.lastResponse = null
    this.write({ used: { kind: 'unknown', capturedAt: observedAt } })
    if (reset === 'compaction') {
      this.requestReport(this.turn.id)
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
    if (!usage || contextTokensFromUsage(usage) === 0) {
      return
    }
    const named = claudeText(response?.model)
    const model = named && named.length <= MAX_CONTEXT_MODEL_ID_CHARS ? named : null
    if (model) {
      this.mainModel = { ...this.mainModel, responseModel: model }
    }
    const key = JSON.stringify([this.turn.id, usage, model])
    if (key === this.lastResponse) {
      return
    }
    this.lastResponse = key
    this.write({
      used: { kind: 'estimate', usage, ...(model ? { model } : {}), capturedAt: observedAt }
    })
  }

  /** End the turn a root result settles, with the window its per-model usage
   *  reports, then ask for the breakdown. */
  settle(message: Record<string, unknown>, end: ClaudeTurnEnd): void {
    const window = claudeContextWindowFromResult(message, this.mainModel)
    const facts = window ? { window: { ...window, capturedAt: end.completedAt } } : undefined
    const settled = this.turn.id
    if (settled === null) {
      this.turn.settle(end)
      if (facts) {
        this.write(facts)
      }
    } else {
      this.turn.settle(end, facts)
    }
    this.requestReport(settled)
  }

  /** Record a requested report on the turn it was asked for; its window serves later estimates. */
  recordReport(target: ClaudeContextReportTarget, report: AgentSessionContextReport): void {
    const window = {
      tokens: report.windowTokens,
      model: report.model,
      capturedAt: report.capturedAt
    }
    writeClaudeTurnRow(this.sink, target === null ? { newest: true } : { turnId: target }, {
      contextUsage: { used: { kind: 'report', ...report }, window }
    })
  }

  subscribeReportRequests(listener: (target: ClaudeContextReportTarget) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  dispose(): void {
    this.requestListeners.clear()
  }

  /** The open turn's row, else the newest turn the journal holds when the write runs. */
  private write(contextUsage: AgentSessionContextUsage): void {
    const identity = this.turn.identity
    const target: ClaudeTurnRowTarget = identity ? { identity } : { newest: true }
    writeClaudeTurnRow(this.sink, target, { contextUsage })
  }

  private requestReport(target: ClaudeContextReportTarget): void {
    for (const listener of this.requestListeners) {
      listener(target)
    }
  }
}
