// Which journal rows date the session.
//
// `lastActivityAt` becomes the status summary's `updatedAt`, which the status row uses as its
// completion stamp and acknowledgement clock. Subagents write into the same journal and keep
// going after the session's own agent settles, so counting their rows re-dates an idle
// session and marks it unread again.
//
// The clock reads the reducer's attribution of the items a row touches, never the raw row:
// a batch or a revision need not name the producer the reducer attributes the item to.

import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { isSubagentGroupBlock } from '../../../shared/native-chat-types'
import type { JournalRow } from './journal-row-schema'

type JournalItemLookup = {
  items: ReadonlyMap<string, AgentJournalRenderItem>
  aliases: ReadonlyMap<string, string>
}

/** Read BEFORE the reducer applies `row`: whether it removes the session's own work. */
export function journalRowRemovesSessionWork(lookup: JournalItemLookup, row: JournalRow): boolean {
  if (row.kind === 'tombstone') {
    return isSessionWork(currentItem(lookup, row.itemId))
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.some(
      (mutation) =>
        mutation.kind === 'tombstone' && isSessionWork(currentItem(lookup, mutation.itemId))
    )
  }
  return false
}

/** Read AFTER the reducer applied `row`: whether it wrote the session's own work. */
export function journalRowWroteSessionWork(lookup: JournalItemLookup, row: JournalRow): boolean {
  if (row.kind === 'item') {
    return isSessionWork(currentItem(lookup, row.itemId))
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.some(
      (mutation) => mutation.kind === 'item' && isSessionWork(currentItem(lookup, mutation.itemId))
    )
  }
  return row.kind === 'submission' || row.kind === 'dispatch'
}

/** The session's own agent at work. Not a subagent's row, and not a subagent roster: the
 *  session's row, but revised on every child transition. A roster's first write sits beside
 *  the spawn call, which dates the session anyway. */
function isSessionWork(item: AgentJournalRenderItem | undefined): boolean {
  return (
    item !== undefined &&
    isRootAgentJournalItem(item) &&
    !(item.body.kind === 'message' && item.body.blocks.some(isSubagentGroupBlock))
  )
}

function currentItem(
  lookup: JournalItemLookup,
  itemId: string
): AgentJournalRenderItem | undefined {
  return lookup.items.get(lookup.aliases.get(itemId) ?? itemId)
}
