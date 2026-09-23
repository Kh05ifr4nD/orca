import { describe, expect, it } from 'vitest'
import type {
  AgentSessionContextReport,
  AgentSessionContextUsage,
  AgentSessionContextWindow
} from './agent-session-context-usage'
import type { AgentJournalItemBody, AgentJournalRenderItem } from './agent-session-journal-types'
import { selectStructuredAgentContextUsage } from './structured-agent-session-context-usage'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt: sequence * 1_000, body }
}

const REPORT: AgentSessionContextReport = {
  model: 'claude-fable-5-1',
  usedTokens: 29_400,
  windowTokens: 200_000,
  percentage: 15,
  autoCompactAtTokens: 167_000,
  categories: [{ name: 'Messages', tokens: 10_200 }],
  capturedAt: 5_000
}

const WINDOW: AgentSessionContextWindow = {
  tokens: 1_000_000,
  model: 'claude-fable-5-1[1m]',
  capturedAt: 2_000
}

function estimate(usedTokens: number, model?: string): AgentSessionContextUsage['used'] {
  return {
    kind: 'estimate',
    usage: {
      inputTokens: usedTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 4
    },
    ...(model ? { model } : {}),
    capturedAt: 1
  }
}

function turn(sequence: number, contextUsage: AgentSessionContextUsage): AgentJournalRenderItem {
  return item(`turn-${sequence}`, sequence, {
    kind: 'turn',
    turnId: `turn-${sequence}`,
    state: 'completed',
    contextUsage
  })
}

describe('selectStructuredAgentContextUsage', () => {
  it('reads the report on the newest turn that carries a used count', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(20_000), window: WINDOW }),
        turn(3, { used: { kind: 'report', ...REPORT } })
      ])
    ).toEqual({
      usedTokens: 29_400,
      windowTokens: 200_000,
      percentage: 15,
      estimated: false,
      categories: REPORT.categories
    })
  })

  it('orders by journal position, not by the clock on the fact', () => {
    const late = { ...REPORT, capturedAt: 99_000 }
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: { kind: 'report', ...late }, window: WINDOW }),
        turn(2, { used: estimate(54_617) })
      ])
    ).toMatchObject({ usedTokens: 54_617, windowTokens: 1_000_000, estimated: true })
  })

  it('estimates against the newest window, which may sit on an older turn', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(10_000), window: WINDOW }),
        turn(2, { used: estimate(18_600, 'claude-fable-5-1') })
      ])
    ).toEqual({
      usedTokens: 18_600,
      windowTokens: 1_000_000,
      percentage: 2,
      estimated: true,
      categories: []
    })
  })

  it('keeps the last turn with a count while a new turn has none yet', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { used: estimate(18_600), window: WINDOW }),
        item('turn-2', 2, { kind: 'turn', turnId: 'turn-2', state: 'running' })
      ])
    ).toMatchObject({ usedTokens: 18_600 })
  })

  it('states nothing before the CLI has reported a window', () => {
    expect(selectStructuredAgentContextUsage([turn(1, { used: estimate(18_600) })])).toBeNull()
  })

  it('states nothing when the newest response ran on a model the window was not measured for', () => {
    const items = (model: string) => [
      turn(1, { window: WINDOW }),
      turn(2, { used: estimate(150_000, model) })
    ]
    expect(selectStructuredAgentContextUsage(items('claude-sonnet-5'))).toBeNull()
    // Responses drop the `[1m]` the window's key carries; the model is still the same.
    expect(selectStructuredAgentContextUsage(items('claude-fable-5-1'))).toMatchObject({
      windowTokens: 1_000_000
    })
    // A provider-specific key names its model through the canonical id.
    const bedrock = { tokens: 200_000, model: 'us.anthropic.claude-sonnet-5-v1', capturedAt: 1 }
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { window: { ...bedrock, canonicalModel: 'claude-sonnet-5' } }),
        turn(2, { used: estimate(50_000, 'claude-sonnet-5') })
      ])
    ).toMatchObject({ windowTokens: 200_000, percentage: 25 })
  })

  it('hides the pre-compaction size until the next response or report restates it', () => {
    const before = turn(1, { used: estimate(150_000), window: WINDOW })
    const compacted = turn(2, { used: { kind: 'unknown', capturedAt: 3_000 } })
    expect(selectStructuredAgentContextUsage([before, compacted])).toBeNull()
    expect(
      selectStructuredAgentContextUsage([before, compacted, turn(3, { used: estimate(12_000) })])
    ).toMatchObject({ usedTokens: 12_000, estimated: true })
    expect(
      selectStructuredAgentContextUsage([before, turn(2, { used: { kind: 'report', ...REPORT } })])
    ).toMatchObject({ usedTokens: 29_400, estimated: false })
  })

  it('is null for a journal with neither', () => {
    expect(
      selectStructuredAgentContextUsage([
        item('u', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] })
      ])
    ).toBeNull()
  })
})
