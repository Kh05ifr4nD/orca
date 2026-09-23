// Where the Claude CLI's context facts land in the journal, and when a fresh
// `/context` breakdown is worth asking for. The facts live on turn rows and are
// written to the open turn, else the newest turn the journal holds; this keeps
// only what tells a late answer it is stale, whose window a result reports, and
// whether the newest window still serves the model responding.

import {
  contextTokensFromUsage,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextReport,
  type AgentSessionContextUsage
} from '../../shared/agent-session-context-usage'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
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

/** The row of the turn a requested report describes; null when no turn was open to name. */
export type ClaudeContextReportTarget = AgentJournalItemIdentity | null

/** How much of an answer still holds: all of it, or only the window of the model the CLI runs. */
export type ClaudeContextReportPart = 'report' | 'window'

/** The model may have changed since the newest window, so no estimate can be divided by it. */
const STALE = Symbol('stale-window')

export class ClaudeContextFacts {
  private activity = 0
  /** Whose window a result's per-model usage should report. */
  private mainModel: ClaudeMainThreadModel = { initModel: null, responseModel: null }
  /** The response model the newest window serves; null adopts the next one. Every window write resets it. */
  private servedModel: string | null | typeof STALE = null
  /** A report measured the window since the turn's init and the last model write, so the result's inference cannot beat it. */
  private windowReported = false
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
      this.windowReported = false
    }
    const reset = claudeContextResetKind(message)
    if (reset) {
      this.forget(observedAt, reset === 'compaction')
    }
  }

  /** A write that can change the main thread's model or window: hold estimates until a new window lands. */
  modelMayHaveChanged(observedAt: number = Date.now()): void {
    this.servedModel = STALE
    this.windowReported = false
    this.forget(observedAt, true)
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
    if (this.servedModel === STALE) {
      return
    }
    // An approved plan hands the turn to another model mid-turn; only a response says so.
    if (model && this.servedModel !== null && model !== this.servedModel) {
      this.modelMayHaveChanged(observedAt)
      return
    }
    this.servedModel = model ?? this.servedModel
    const dedupe = JSON.stringify([this.turn.id, usage])
    if (dedupe === this.lastResponse) {
      return
    }
    this.lastResponse = dedupe
    this.write({ used: { kind: 'estimate', usage, capturedAt: observedAt } })
  }

  /** End the turn a root result settles, with the window its per-model usage
   *  reports, then ask for the breakdown. */
  settle(message: Record<string, unknown>, end: ClaudeTurnEnd): void {
    const tokens = this.windowReported
      ? null
      : claudeContextWindowFromResult(message, this.mainModel)
    const facts = tokens === null ? undefined : { window: { tokens, capturedAt: end.completedAt } }
    if (facts) {
      this.servedModel = null
    }
    const settled = this.turn.identity
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

  /** Record a requested report on the turn it was asked for; its window serves later estimates.
   *  `window` keeps only the window, for an answer the conversation moved past. */
  recordReport(
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    part: ClaudeContextReportPart
  ): void {
    const window = { tokens: report.windowTokens, capturedAt: report.capturedAt }
    this.servedModel = null
    this.windowReported = true
    const contextUsage: AgentSessionContextUsage =
      part === 'report' ? { used: { kind: 'report', ...report }, window } : { window }
    writeClaudeTurnRow(this.sink, target === null ? { newest: true } : { identity: target }, {
      contextUsage
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

  /** The context no longer holds what the journal says; a report asked for before now describes the old one. */
  private forget(observedAt: number, requestReport: boolean): void {
    this.markActivity()
    this.lastResponse = null
    this.write({ used: { kind: 'unknown', capturedAt: observedAt } })
    if (requestReport) {
      this.requestReport(this.turn.identity)
    }
  }

  private requestReport(target: ClaudeContextReportTarget): void {
    for (const listener of this.requestListeners) {
      listener(target)
    }
  }
}
