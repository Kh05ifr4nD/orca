// Jumping to a rail tick whose message is not loaded yet: page older history in
// until the message has a slot, then hand it to the ordinary rail jump.
//
// Driven by commits rather than an awaited loop: each step re-reads the rail after
// React has applied the last page, so "has a slot yet?" is always asked of what
// the list will actually render. One jump at a time, aimed at the latest pick; it
// stops quietly when history runs out, when a page brings no progress, when the
// loaded window passes the message without it drawing a row, or after a bounded
// number of pages.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatRailItem } from './native-chat-message-rail-items'

/** Far past any real session (pages are up to 200 journal items); only a
 *  runaway loop reaches it. */
export const NATIVE_CHAT_RAIL_JUMP_MAX_PAGES = 1000

type PendingJump = {
  messageId: string
  pages: number
  /** Token of the page this jump is waiting on; null between pages. */
  awaitingPage: number | null
}

export function useNativeChatRailHistoryJump({
  items,
  messages,
  hasMore,
  loadingEarlier,
  loadEarlier,
  jumpToLoaded
}: {
  items: readonly NativeChatRailItem[]
  /** The lane's message list, compared by identity to detect a page that added nothing. */
  messages: unknown
  hasMore: boolean
  /** Whether an older page is already in flight, e.g. from scrolling to the top. */
  loadingEarlier: boolean
  loadEarlier: () => void | Promise<void>
  jumpToLoaded: (item: NativeChatRailItem) => void
}): {
  pendingId: string | null
  jump: (item: NativeChatRailItem) => void
  cancel: () => void
} {
  const [pending, setPending] = useState<PendingJump | null>(null)
  // The lane's message list when the last page was requested; a page that lands
  // without changing it made no progress.
  const pagedFromRef = useRef<unknown>(undefined)
  const pageTokenRef = useRef(0)

  // A later pick retargets the jump; a page already in flight still counts toward it.
  const jump = useCallback((item: NativeChatRailItem) => {
    setPending((current) =>
      !current
        ? { messageId: item.id, pages: 0, awaitingPage: null }
        : current.messageId === item.id
          ? current
          : { ...current, messageId: item.id }
    )
  }, [])
  const cancel = useCallback(() => setPending(null), [])

  useEffect(() => {
    if (!pending || pending.awaitingPage !== null) {
      return
    }
    const target = items.find((item) => item.id === pending.messageId)
    if (target && target.slotIndex !== null) {
      setPending(null)
      jumpToLoaded(target)
      return
    }
    // The lane ignores a second request while one is in flight; asking now would read
    // as a page that brought no progress. Its landing re-runs this.
    if (loadingEarlier) {
      return
    }
    if (
      !target ||
      !hasMore ||
      (pending.pages > 0 && pagedFromRef.current === messages) ||
      pending.pages >= NATIVE_CHAT_RAIL_JUMP_MAX_PAGES
    ) {
      setPending(null)
      return
    }
    pagedFromRef.current = messages
    pageTokenRef.current += 1
    const token = pageTokenRef.current
    // Functional: a pick or cancel queued since this commit must survive the step.
    setPending((current) =>
      current ? { ...current, pages: current.pages + 1, awaitingPage: token } : current
    )
    const settle = (): void =>
      setPending((current) =>
        current?.awaitingPage === token ? { ...current, awaitingPage: null } : current
      )
    // A rejected page is the lane's own error to surface; the jump just stops trying.
    void Promise.resolve(loadEarlier()).then(settle, () =>
      setPending((current) => (current?.awaitingPage === token ? null : current))
    )
  }, [hasMore, items, jumpToLoaded, loadEarlier, loadingEarlier, messages, pending])

  return { pendingId: pending?.messageId ?? null, jump, cancel }
}
