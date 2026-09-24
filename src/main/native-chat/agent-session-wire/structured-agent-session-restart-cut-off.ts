// What a restart cut off in one session, read back from its journal for the offer's row to name.
//
// Display only: whether the chat is offered was settled at teardown and never depends on this. An
// unreadable journal or an older marker just leaves the row without an activity line.
//
// Teardown settles what a stopped child left running as ordinary journal revisions: a pending
// prompt becomes `cancelled`, a running tool call `failed`, and each provider marks the subagents
// and background tasks it can no longer hear from `unverifiable`. All of them land after the
// marker's journal cursor, so this reads those rows — the ones the transcript already renders —
// instead of the marker keeping a second copy that could disagree with them.
//
// The rows are judged, not the items they revised: once reattached, the provider restates what it
// lost in its own words and overwrites those items, but the settlement's rows stay where they are.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
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

/** One item revision a journal row wrote, keyed by the id the rendered items carry. */
export type JournalItemRevision = { itemId: string; body: AgentJournalItemBody }

/** Every item revision a run of journal rows wrote, directly or inside a lifecycle batch. */
export function journalItemRevisions(
  rows: readonly JournalRow[],
  canonicalItemId: (itemId: string) => string
): JournalItemRevision[] {
  const revisions: JournalItemRevision[] = []
  for (const row of rows) {
    if (row.kind === 'item') {
      revisions.push({ itemId: canonicalItemId(row.itemId), body: row.body })
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        if (mutation.kind === 'item') {
          revisions.push({ itemId: canonicalItemId(mutation.itemId), body: mutation.body })
        }
      }
    }
  }
  return revisions
}

/** Whether the lead's own reply was cut off: a send that had not become a turn yet, or the
 *  marker's turn, found by id, settled as interrupted. Judged on the settlement's row when the
 *  rows since the cursor are readable, since a reattached provider may restate that turn; on the
 *  turn as it stands only when they are not. */
function leadWasMidReply(
  marker: AgentSessionResumeMarker,
  items: readonly AgentJournalRenderItem[],
  revisions: readonly JournalItemRevision[] | null
): boolean {
  if (marker.work.kind === 'submission') {
    return true
  }
  const cutOff = (body: AgentJournalItemBody | undefined): boolean | null => {
    const turn = readAgentJournalTurn(body)
    return turn?.turnId === marker.work.id
      ? turn.state === 'interrupted' || turn.state === 'unverifiable'
      : null
  }
  if (revisions) {
    return revisions.some(({ body }) => cutOff(body) === true)
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const verdict = cutOff(items[index]?.body)
    if (verdict !== null) {
      return verdict
    }
  }
  return false
}

/** Undefined for a marker with no journal cursor: a build that recorded only a working lead. */
export function structuredAgentSessionRestartActivity(input: {
  marker: AgentSessionResumeMarker
  items: readonly AgentJournalRenderItem[]
  /** Revisions written after the marker's cursor; null when the journal cannot answer against it —
   *  an epoch that renumbered the rows since. */
  revisionsSinceCursor: readonly JournalItemRevision[] | null
}): AgentSessionRestartActivity | undefined {
  if (!input.marker.journalCursor) {
    return undefined
  }
  // A cut-off reply's tool calls are that reply's, not background work of their own.
  const midReply = leadWasMidReply(input.marker, input.items, input.revisionsSinceCursor)
  const prompts: AgentSessionRestartPrompt[] = []
  const tasks: AgentSessionRestartTask[] = []
  const revisions = input.revisionsSinceCursor ?? []
  // A later revision restating the same prompt or child must not count it twice.
  const seen = new Set<string>()
  const first = (key: string): boolean => {
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  }
  const itemsById =
    revisions.length > 0 ? new Map(input.items.map((item) => [item.itemId, item])) : null
  for (const { itemId, body } of revisions) {
    if (body.kind === 'approval' && body.resolution.state === 'cancelled') {
      if (first(itemId)) {
        prompts.push({ kind: 'approval', label: label(body.displayName ?? body.title) })
      }
    } else if (body.kind === 'question' && body.resolution.state === 'cancelled') {
      if (first(itemId)) {
        prompts.push({ kind: 'question', label: label(body.question) })
      }
    } else if (body.kind === 'message') {
      for (const block of body.blocks) {
        if (block.type === 'subagent-group') {
          for (const agent of block.agents) {
            if (agent.state === 'unverifiable' && first(`${itemId}\0${agent.id}`)) {
              tasks.push({ kind: 'agent', label: label(agent.label) })
            }
          }
        } else if (
          block.type === 'background-task' &&
          block.state === 'unverifiable' &&
          first(`${itemId}\0${block.taskId}`)
        ) {
          tasks.push({ kind: block.kind, label: label(block.label) })
        }
      }
    } else if (body.kind === 'tool-call' && body.state === 'failed' && !midReply) {
      const item = itemsById?.get(itemId)
      // A command that outlived its turn: the lead had settled, so the call was nobody's reply.
      if (item && isRootAgentJournalItem(item) && first(itemId)) {
        tasks.push({ kind: 'command', label: toolCallLabel(body.name, body.input) })
      }
    }
  }
  return {
    midReply,
    prompts: prompts.slice(0, MAX_PROMPTS),
    tasks: tasks.slice(0, MAX_TASKS)
  }
}
