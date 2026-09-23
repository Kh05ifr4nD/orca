// What a restart cut off in one session, read back from its journal.
//
// Teardown settles what a stopped child left running as ordinary journal revisions: a pending
// prompt becomes `cancelled`, a running tool call `failed`, and each provider marks the subagents
// and background tasks it can no longer hear from `unverifiable`. All of them land after the
// marker's journal cursor, so this reads those rows — the ones the transcript already renders —
// instead of the marker keeping a second copy that could disagree with them.
//
// Which items changed is asked of the journal's own catch-up read, not of the rendered items: an
// item keeps the sequence it first appeared at, so a revision after the cursor is invisible there.

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type {
  AgentSessionRestartActivity,
  AgentSessionRestartPrompt,
  AgentSessionRestartTask
} from '../../../shared/agent-session-restart-activity'

const MAX_PROMPTS = 4
const MAX_TASKS = 16
const MAX_LABEL_LENGTH = 200

function label(text: string | undefined): string {
  const trimmed = text?.trim() ?? ''
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…` : trimmed
}

/** A tool call's own summary of itself when the provider gave one, else the tool's name. */
function toolCallLabel(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null && 'description' in input) {
    const { description } = input
    if (typeof description === 'string' && description.trim()) {
      return label(description)
    }
  }
  return label(name)
}

/** Every item a run of journal rows revised, directly or inside a lifecycle batch. */
export function journalItemsRevisedBy(rows: readonly JournalRow[]): Set<string> {
  const itemIds = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'item') {
      itemIds.add(row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        if (mutation.kind === 'item') {
          itemIds.add(mutation.itemId)
        }
      }
    }
  }
  return itemIds
}

/**
 * @param midReply whether the lead's own turn was cut off; its tool calls are then that reply's,
 *   not background work of their own.
 */
export function structuredAgentSessionRestartCutOff(input: {
  items: readonly AgentJournalRenderItem[]
  /** Items revised after the marker's cursor; null when the journal cannot answer against it — an
   *  older marker with none, or an epoch that renumbered the rows since. */
  revisedSinceCursor: ReadonlySet<string> | null
  midReply: boolean
}): AgentSessionRestartActivity {
  const prompts: AgentSessionRestartPrompt[] = []
  const tasks: AgentSessionRestartTask[] = []
  const revised = input.revisedSinceCursor
  if (revised && revised.size > 0) {
    for (const item of input.items) {
      if (!revised.has(item.itemId)) {
        continue
      }
      const { body } = item
      if (body.kind === 'approval' && body.resolution.state === 'cancelled') {
        prompts.push({ kind: 'approval', label: label(body.displayName ?? body.title) })
      } else if (body.kind === 'question' && body.resolution.state === 'cancelled') {
        prompts.push({ kind: 'question', label: label(body.question) })
      } else if (body.kind === 'message') {
        for (const block of body.blocks) {
          if (block.type === 'subagent-group') {
            for (const agent of block.agents) {
              if (agent.state === 'unverifiable') {
                tasks.push({ kind: 'agent', label: label(agent.label) })
              }
            }
          } else if (block.type === 'background-task' && block.state === 'unverifiable') {
            tasks.push({ kind: block.kind, label: label(block.label) })
          }
        }
      } else if (
        body.kind === 'tool-call' &&
        body.state === 'failed' &&
        !input.midReply &&
        isRootAgentJournalItem(item)
      ) {
        // A command that outlived its turn: the lead had settled, so the call was nobody's reply.
        tasks.push({ kind: 'command', label: toolCallLabel(body.name, body.input) })
      }
    }
  }
  return {
    midReply: input.midReply,
    prompts: prompts.slice(0, MAX_PROMPTS),
    tasks: tasks.slice(0, MAX_TASKS)
  }
}
