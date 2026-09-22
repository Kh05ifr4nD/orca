import { describe, expect, it } from 'vitest'
import type {
  AgentSessionContextReport,
  AgentSessionContextUsage
} from './agent-session-context-usage'
import type { AgentJournalItemBody, AgentJournalRenderItem } from './agent-session-journal-types'
import { selectStructuredAgentContextUsage } from './structured-agent-session-context-usage'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  observedAt = sequence * 1_000
): AgentJournalRenderItem {
  return { itemId, revision: 1, sequence, observedAt, body }
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

/** A turn row whose newest main-thread response read `usedTokens`, at `sequence` seconds. */
function assistant(itemId: string, sequence: number, usedTokens: number): AgentJournalRenderItem {
  return item(itemId, sequence, {
    kind: 'turn',
    turnId: itemId,
    state: 'running',
    contextUsage: {
      response: {
        usage: {
          inputTokens: usedTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 4
        },
        capturedAt: sequence * 1_000
      }
    }
  })
}

function turn(sequence: number, contextUsage: AgentSessionContextUsage): AgentJournalRenderItem {
  return item(`turn-${sequence}`, sequence, {
    kind: 'turn',
    turnId: `turn-${sequence}`,
    state: 'completed',
    outcome: 'success',
    contextUsage
  })
}

describe('selectStructuredAgentContextUsage', () => {
  it('reads the report when it is newer than every response, by clock not position', () => {
    const expected = {
      usedTokens: 29_400,
      windowTokens: 200_000,
      percentage: 15,
      estimated: false,
      categories: REPORT.categories
    }
    expect(
      selectStructuredAgentContextUsage([assistant('a', 1, 20_000), turn(3, { report: REPORT })])
    ).toEqual(expected)
    // A revised turn row keeps its transcript position; only the clocks decide.
    expect(
      selectStructuredAgentContextUsage([turn(1, { report: REPORT }), assistant('a', 2, 20_000)])
    ).toEqual(expected)
  })

  it('estimates from a response that landed after the report, against the newest window', () => {
    expect(
      selectStructuredAgentContextUsage([turn(3, { report: REPORT }), assistant('b', 6, 54_617)])
    ).toEqual({
      usedTokens: 54_617,
      windowTokens: 200_000,
      percentage: 27,
      estimated: true,
      categories: []
    })
  })

  it('states nothing before the CLI has reported a window', () => {
    expect(selectStructuredAgentContextUsage([assistant('a', 1, 18_600)])).toBeNull()
  })

  it('estimates against the window a result reported, so a 1M session reads 1M', () => {
    expect(
      selectStructuredAgentContextUsage([
        assistant('a', 1, 18_600),
        turn(2, { window: { tokens: 1_000_000, capturedAt: 2_000 } })
      ])
    ).toMatchObject({ usedTokens: 18_600, windowTokens: 1_000_000, percentage: 2, estimated: true })
  })

  it('takes the newest window when the CLI reports another', () => {
    expect(
      selectStructuredAgentContextUsage([
        turn(1, { window: { tokens: 1_000_000, capturedAt: 1_000 }, report: REPORT }),
        assistant('a', 6, 20_000)
      ])
    ).toMatchObject({ windowTokens: 200_000 })
  })

  it('hides the pre-compaction size until the next response or report restates it', () => {
    const window = { tokens: 200_000, capturedAt: 2_000 }
    const before = assistant('a', 1, 150_000)
    expect(selectStructuredAgentContextUsage([before, turn(2, { window, resetAt: 3_000 })])).toBe(
      null
    )
    expect(
      selectStructuredAgentContextUsage([
        before,
        turn(2, { window, resetAt: 3_000 }),
        assistant('b', 4, 12_000)
      ])
    ).toMatchObject({ usedTokens: 12_000, estimated: true })
    expect(
      selectStructuredAgentContextUsage([
        before,
        turn(2, { window, resetAt: 3_000, report: { ...REPORT, capturedAt: 3_500 } })
      ])
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
