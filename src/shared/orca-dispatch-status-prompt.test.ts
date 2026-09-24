import { describe, expect, it } from 'vitest'
import {
  compactDispatchPromptForStatus,
  findOrcaDispatchPreambleStart,
  isOrcaDispatchStatusPrompt,
  ORCA_DISPATCH_PROMPT_LEAD_LINE,
  ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX
} from './orca-dispatch-status-prompt'

const preamble = [
  `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX} You are a dispatched worker.`,
  'Your task ID is: task_lead_1',
  '',
  '=== TASK ===',
  'Add greet() to src/greet.js'
].join('\n')
// Why: the shape Claude Code's UserPromptSubmit hook reports for a typed lead plus a paste.
const claudeHookPrompt = `${ORCA_DISPATCH_PROMPT_LEAD_LINE}\n\n<pasted_content id="aac2">\n${preamble}\n</pasted_content id="aac2">\n`
const fold = (value: string, maxLength: number): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, maxLength)

describe('orca dispatch status prompt detection', () => {
  it('detects bare, wrapped, and lead-line dispatch prompts', () => {
    expect(isOrcaDispatchStatusPrompt(`  ${preamble}`)).toBe(true)
    expect(isOrcaDispatchStatusPrompt(`\n\n<pasted_content id="965a">\n${preamble}`)).toBe(true)
    expect(isOrcaDispatchStatusPrompt(`${ORCA_DISPATCH_PROMPT_LEAD_LINE} ${preamble}`)).toBe(true)
    expect(isOrcaDispatchStatusPrompt(claudeHookPrompt)).toBe(true)
    expect(findOrcaDispatchPreambleStart(claudeHookPrompt)).toBe(
      claudeHookPrompt.indexOf(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX)
    )
  })

  it('rejects prompts that only mention the preamble after other text', () => {
    expect(isOrcaDispatchStatusPrompt(`please review: ${preamble}`)).toBe(false)
    expect(isOrcaDispatchStatusPrompt(ORCA_DISPATCH_PROMPT_LEAD_LINE)).toBe(false)
    expect(isOrcaDispatchStatusPrompt(`<pasted_content ${'x'.repeat(80)}>${preamble}`)).toBe(false)
  })

  it('compacts a lead-line prompt to the canonical prefix older clients detect', () => {
    expect(compactDispatchPromptForStatus(claudeHookPrompt, 200, fold)).toBe(
      `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX} Your task ID is: task_lead_1 === TASK === Add greet() to src/greet.js`
    )
  })

  it('does not read the closing paste tag as the task body', () => {
    const empty = `<pasted_content id="1">\n${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\n=== TASK ===\n</pasted_content id="1">`
    expect(compactDispatchPromptForStatus(empty, 200, fold)).toBe(
      ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX
    )
  })
})
