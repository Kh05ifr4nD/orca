import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import {
  bindClaudeContextUsageCapture,
  claudeContextReportFromControl,
  claudeContextWindowFromResult,
  claudeTokenUsage
} from './claude-context-usage'

// Shape measured from Claude Code 2.1.270 / Agent SDK 0.3.251.
const CONTROL_REPORT = {
  categories: [
    { name: 'System prompt', tokens: 3_800, color: 'x' },
    { name: 'System tools (deferred)', tokens: 15_500, color: 'x', isDeferred: true },
    { name: 'Messages', tokens: 10, color: 'x' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'x' },
    { name: 'Free space', tokens: 981_400, color: 'x' }
  ],
  totalTokens: 18_600,
  maxTokens: 967_000,
  rawMaxTokens: 1_000_000,
  percentage: 2,
  gridRows: [],
  model: 'claude-fable-5-1[1m]',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: 967_000,
  isAutoCompactEnabled: true
}

describe('claudeContextReportFromControl', () => {
  it('keeps the CLI rows as it names and counts them', () => {
    expect(claudeContextReportFromControl(CONTROL_REPORT, 42)).toEqual({
      model: 'claude-fable-5-1[1m]',
      usedTokens: 18_600,
      windowTokens: 1_000_000,
      percentage: 2,
      autoCompactAtTokens: 967_000,
      categories: [
        { name: 'System prompt', tokens: 3_800 },
        { name: 'System tools (deferred)', tokens: 15_500, deferred: true },
        { name: 'Messages', tokens: 10 },
        { name: 'Autocompact buffer', tokens: 33_000 },
        { name: 'Free space', tokens: 981_400 }
      ],
      capturedAt: 42
    })
  })

  it('omits the compaction threshold when auto-compaction is off', () => {
    expect(
      claudeContextReportFromControl({ ...CONTROL_REPORT, isAutoCompactEnabled: false }, 1)
        ?.autoCompactAtTokens
    ).toBeUndefined()
  })

  it('rejects reports that name no model or window', () => {
    expect(claudeContextReportFromControl({}, 1)).toBeNull()
    expect(claudeContextReportFromControl(null, 1)).toBeNull()
    expect(
      claudeContextReportFromControl({ ...CONTROL_REPORT, rawMaxTokens: 0, maxTokens: 0 }, 1)
    ).toBeNull()
    expect(
      claudeContextReportFromControl({ ...CONTROL_REPORT, rawMaxTokens: undefined }, 1)
        ?.windowTokens
    ).toBe(967_000)
  })
})

describe('claudeContextWindowFromResult', () => {
  it('reads the largest window when nothing names the main thread model, in any order', () => {
    const main = { contextWindow: 1_000_000 }
    const side = { contextWindow: 200_000 }
    expect(
      claudeContextWindowFromResult({ modelUsage: { 'claude-fable-5-1[1m]': main, haiku: side } })
    ).toBe(1_000_000)
    expect(
      claudeContextWindowFromResult({ modelUsage: { haiku: side, 'claude-fable-5-1[1m]': main } })
    ).toBe(1_000_000)
  })

  it('reads the entry of the model that served the main thread, not a larger one', () => {
    const modelUsage = {
      'claude-fable-5-1[1m]': { contextWindow: 1_000_000, inputTokens: 10 },
      'claude-sonnet-5': { contextWindow: 200_000, inputTokens: 10 }
    }
    const previousTotals = new Map<string, number>()
    expect(
      claudeContextWindowFromResult({ modelUsage }, { model: 'claude-sonnet-5', previousTotals })
    ).toBe(200_000)
    expect(
      claudeContextWindowFromResult({ modelUsage }, { model: 'claude-fable-5-1', previousTotals })
    ).toBe(1_000_000)
    // A provider-specific key is matched through the canonical id it reports.
    expect(
      claudeContextWindowFromResult(
        {
          modelUsage: {
            'us.anthropic.claude-sonnet-5-v1': {
              contextWindow: 200_000,
              canonicalModel: 'claude-sonnet-5'
            },
            'claude-fable-5-1[1m]': { contextWindow: 1_000_000 }
          }
        },
        { model: 'claude-sonnet-5', previousTotals }
      )
    ).toBe(200_000)
  })

  it('picks the entry this result moved when the model runs with and without [1m]', () => {
    const modelUsage = {
      'claude-fable-5-1[1m]': { contextWindow: 1_000_000, inputTokens: 500 },
      'claude-fable-5-1': { contextWindow: 200_000, inputTokens: 40 }
    }
    const main = { model: 'claude-fable-5-1' }
    expect(
      claudeContextWindowFromResult(
        { modelUsage },
        { ...main, previousTotals: new Map([['claude-fable-5-1[1m]', 500]]) }
      )
    ).toBe(200_000)
    expect(
      claudeContextWindowFromResult(
        { modelUsage },
        { ...main, previousTotals: new Map([['claude-fable-5-1', 40]]) }
      )
    ).toBe(1_000_000)
  })

  it('is null when no entry reports a usable window', () => {
    expect(claudeContextWindowFromResult({ type: 'result' })).toBeNull()
    expect(
      claudeContextWindowFromResult({
        type: 'result',
        modelUsage: { a: { contextWindow: 0 }, b: { contextWindow: 'big' }, c: null }
      })
    ).toBeNull()
  })
})

describe('claudeTokenUsage', () => {
  it('drops the all-zero usage the CLI stamps on rows it synthesizes', () => {
    expect(claudeTokenUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull()
    expect(claudeTokenUsage({ input_tokens: 3, cache_read_input_tokens: 7 })).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 7,
      outputTokens: 0
    })
  })
})

function fakeTranslator() {
  const listeners = new Set<(turnId: string) => void>()
  const annotations: [string, AgentSessionContextUsage][] = []
  const state = { activity: 0 }
  const request = (turnId: string): void => {
    for (const listener of listeners) {
      listener(turnId)
    }
  }
  return {
    listeners,
    annotations,
    state,
    request,
    translator: {
      get contextActivity() {
        return state.activity
      },
      subscribeContextUsageRequests: (listener: (turnId: string) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      annotateTurnContextUsage: (turnId: string, usage: AgentSessionContextUsage) => {
        annotations.push([turnId, usage])
        return true
      }
    }
  }
}

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((settle) => (resolve = settle))
  return { promise, resolve }
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

describe('bindClaudeContextUsageCapture', () => {
  it('records the answer on the turn the request named, with a bounded wait', async () => {
    const fake = fakeTranslator()
    const getContextUsage = vi.fn(async () => CONTROL_REPORT)
    bindClaudeContextUsageCapture({ getContextUsage }, fake.translator, { now: () => 99 })
    fake.request('turn-1')
    await vi.waitFor(() => expect(fake.annotations).toHaveLength(1))
    expect(getContextUsage).toHaveBeenCalledWith({ timeoutMs: 5_000 })
    expect(fake.annotations[0]).toEqual([
      'turn-1',
      { report: expect.objectContaining({ usedTokens: 18_600, capturedAt: 99 }) }
    ])
  })

  it('drops an answer the conversation moved past while it was in flight', async () => {
    const fake = fakeTranslator()
    const answer = deferred()
    bindClaudeContextUsageCapture({ getContextUsage: () => answer.promise }, fake.translator, {})
    fake.request('turn-1')
    fake.state.activity += 1
    answer.resolve(CONTROL_REPORT)
    await settle()
    expect(fake.annotations).toHaveLength(0)
  })

  it('drops an answer a newer request superseded, keeping the newer one', async () => {
    const fake = fakeTranslator()
    const first = deferred()
    const second = deferred()
    const getContextUsage = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    bindClaudeContextUsageCapture({ getContextUsage }, fake.translator, { now: () => 5 })
    fake.request('turn-1')
    fake.request('turn-1')
    second.resolve({ ...CONTROL_REPORT, totalTokens: 9_000 })
    first.resolve(CONTROL_REPORT)
    await settle()
    expect(fake.annotations).toEqual([
      ['turn-1', { report: expect.objectContaining({ usedTokens: 9_000 }) }]
    ])
  })

  it('leaves the row alone when the CLI cannot answer or the binding was released', async () => {
    const fake = fakeTranslator()
    const late = deferred()
    const getContextUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error('older CLI'))
      .mockReturnValueOnce(late.promise)
    const unbind = bindClaudeContextUsageCapture({ getContextUsage }, fake.translator, {})
    fake.request('turn-1')
    await settle()
    expect(fake.annotations).toHaveLength(0)
    fake.request('turn-2')
    unbind?.()
    late.resolve(CONTROL_REPORT)
    await settle()
    expect(fake.annotations).toHaveLength(0)
    expect(fake.listeners.size).toBe(0)
  })
})
