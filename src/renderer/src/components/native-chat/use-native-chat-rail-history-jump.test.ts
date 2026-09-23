// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'

type LaneSnapshot = { loaded: number; messages: readonly string[]; loading: boolean }

/** A lane shaped like the structured read owner: a page lands in the store, and
 *  only then does the returned promise settle. A request made while a page is in
 *  flight returns at once, as the owner's does. */
function createLane({
  total,
  pageSize,
  initiallyLoaded,
  ghostIds = [],
  pagesAddNothing = false
}: {
  total: number
  pageSize: number
  initiallyLoaded: number
  /** Outline entries that never take a slot, the way an unrenderable message would. */
  ghostIds?: string[]
  pagesAddNothing?: boolean
}) {
  const ids = Array.from({ length: total }, (_, index) => `m${index}`)
  let snapshot: LaneSnapshot = {
    loaded: initiallyLoaded,
    messages: ids.slice(total - initiallyLoaded),
    loading: false
  }
  const listeners = new Set<() => void>()
  const pageGate: { release: (() => void) | null } = { release: null }
  let holdPages = false
  const loadEarlier = vi.fn(async () => {
    if (snapshot.loading) {
      return
    }
    snapshot = { ...snapshot, loading: true }
    listeners.forEach((listener) => listener())
    if (holdPages) {
      await new Promise<void>((resolve) => {
        pageGate.release = resolve
      })
    }
    await Promise.resolve()
    if (pagesAddNothing) {
      snapshot = { ...snapshot, loading: false }
    } else {
      const loaded = Math.min(total, snapshot.loaded + pageSize)
      snapshot = { loaded, messages: ids.slice(total - loaded), loading: false }
    }
    listeners.forEach((listener) => listener())
  })
  const lane = {
    loadEarlier,
    holdPages: () => {
      holdPages = true
    },
    releasePage: () => pageGate.release?.(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot
  }
  const useLaneRailJump = (jumpToLoaded: (item: NativeChatRailItem) => void) => {
    const current = useSyncExternalStore(lane.subscribe, lane.getSnapshot)
    const items = useMemo<NativeChatRailItem[]>(() => {
      const unloaded = ids.slice(0, total - current.loaded)
      return [
        ...[...ghostIds, ...unloaded].map((id) => ({
          id,
          slotIndex: null,
          text: id,
          hasImages: false
        })),
        ...current.messages.map((id, slotIndex) => ({ id, slotIndex, text: id, hasImages: false }))
      ]
    }, [current])
    return useNativeChatRailHistoryJump({
      items,
      messages: current.messages,
      hasMore: current.loaded < total,
      loadingEarlier: current.loading,
      loadEarlier: lane.loadEarlier,
      jumpToLoaded
    })
  }
  return { lane, useLaneRailJump }
}

function outlineItem(id: string): NativeChatRailItem {
  return { id, slotIndex: null, text: id, hasImages: false }
}

describe('rail jump through unloaded history', () => {
  it('pages older history until the message has a slot, then jumps to it', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 100, pageSize: 10, initiallyLoaded: 10 })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('m5')))
    expect(result.current.pendingId).toBe('m5')

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    // 90 messages were unloaded and m5 sits 5 from the top: nine pages reach it.
    expect(lane.loadEarlier).toHaveBeenCalledTimes(9)
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm5', slotIndex: 5 }))
    expect(result.current.pendingId).toBeNull()
  })

  it('stops quietly when history runs out without the message drawing a row', async () => {
    const { lane, useLaneRailJump } = createLane({
      total: 30,
      pageSize: 10,
      initiallyLoaded: 10,
      ghostIds: ['ghost']
    })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('ghost')))
    await waitFor(() => expect(result.current.pendingId).toBeNull())
    expect(lane.loadEarlier).toHaveBeenCalledTimes(2)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('stops after a page that brings no progress instead of spinning', async () => {
    const { lane, useLaneRailJump } = createLane({
      total: 30,
      pageSize: 10,
      initiallyLoaded: 10,
      pagesAddNothing: true
    })
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('m3')))
    await waitFor(() => expect(result.current.pendingId).toBeNull())
    expect(lane.loadEarlier).toHaveBeenCalledTimes(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('waits out a page already in flight instead of reading it as no progress', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))
    // Scrolling to the top already asked for the next page.
    act(() => void lane.loadEarlier())

    act(() => result.current.jump(outlineItem('m25')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.pendingId).toBe('m25')
    await act(async () => {
      lane.releasePage()
      await Promise.resolve()
    })

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm25' }))
  })

  it('runs one jump at a time, aimed at the latest pick', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('m25')))
    await waitFor(() => expect(lane.loadEarlier).toHaveBeenCalledTimes(1))
    // Picked while the first page is still in flight: no second page is asked for.
    act(() => result.current.jump(outlineItem('m2')))
    expect(result.current.pendingId).toBe('m2')
    expect(lane.loadEarlier).toHaveBeenCalledTimes(1)
    for (let page = 0; page < 3; page += 1) {
      await act(async () => {
        lane.releasePage()
        await Promise.resolve()
      })
    }

    await waitFor(() => expect(jumpToLoaded).toHaveBeenCalledTimes(1))
    expect(jumpToLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    expect(lane.loadEarlier).toHaveBeenCalledTimes(3)
  })

  it('stops paging once cancelled', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('m2')))
    await waitFor(() => expect(lane.loadEarlier).toHaveBeenCalledTimes(1))
    act(() => result.current.cancel())
    await act(async () => {
      lane.releasePage()
      await Promise.resolve()
    })

    expect(result.current.pendingId).toBeNull()
    expect(lane.loadEarlier).toHaveBeenCalledTimes(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })

  it('abandons the jump when the list unmounts mid-page', async () => {
    const { lane, useLaneRailJump } = createLane({ total: 40, pageSize: 10, initiallyLoaded: 10 })
    lane.holdPages()
    const jumpToLoaded = vi.fn()
    const { result, unmount } = renderHook(() => useLaneRailJump(jumpToLoaded))

    act(() => result.current.jump(outlineItem('m2')))
    await waitFor(() => expect(lane.loadEarlier).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => {
      lane.releasePage()
      await Promise.resolve()
    })
    expect(lane.loadEarlier).toHaveBeenCalledTimes(1)
    expect(jumpToLoaded).not.toHaveBeenCalled()
  })
})
