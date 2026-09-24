import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { PixelRatio } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import {
  buildMobileBrowserScreencastRequest,
  type MobileBrowserViewMode
} from './browser-screencast-request'
import { MAX_ZOOM, MIN_ZOOM, getCachedBrowserFrame } from './mobile-browser-frame-state'
import {
  clampBrowserZoomState,
  computeBrowserFrameGeometry,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { MobileBrowserTab } from './MobileBrowserPane'
import {
  handleBrowserScreencastEvent,
  type BrowserDialogState,
  type ScreencastEvent
} from './mobile-browser-stream-events'
import type { BrowserFramePacer } from './browser-frame-pacer'
import { useMobileBrowserRequest } from './use-mobile-browser-request'

type MobileBrowserStreamArgs = {
  appActive: boolean
  binaryScreencastGranted: boolean
  browserViewMode: MobileBrowserViewMode
  busyRef: { current: boolean }
  cacheKey: string | null
  client: RpcClient | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  framePacer: BrowserFramePacer
  lastStreamCacheKeyRef: { current: string | null }
  lastZoomResetUrlRef: { current: string }
  layout: BrowserTouchLayout | null
  resetBrowserZoomState: () => void
  screencastSupported: boolean | null
  setAddressValue: Dispatch<SetStateAction<string>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setZoom: Dispatch<SetStateAction<BrowserZoomState>>
  streamGenerationRef: { current: number }
  tab: MobileBrowserTab
  worktreeId: string
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserStream(args: MobileBrowserStreamArgs) {
  const {
    appActive,
    binaryScreencastGranted,
    browserViewMode,
    busyRef,
    cacheKey,
    client,
    frameMetadata,
    frameMetadataRef,
    framePacer,
    lastStreamCacheKeyRef,
    lastZoomResetUrlRef,
    layout,
    resetBrowserZoomState,
    screencastSupported,
    setAddressValue,
    setBusy,
    setDialog,
    setError,
    setFrameMetadata,
    setZoom,
    streamGenerationRef,
    tab,
    worktreeId,
    zoomRef
  } = args

  const { pageParams, sendBrowserRequest } = useMobileBrowserRequest({
    busyRef,
    client,
    pageId: tab.browserPageId,
    setBusy,
    setError,
    worktreeId
  })

  const streamRequest = useMemo(
    () => buildMobileBrowserScreencastRequest(layout, PixelRatio.get(), browserViewMode),
    [browserViewMode, layout]
  )

  const frameGeometry = useMemo(
    () => computeBrowserFrameGeometry(layout, frameMetadata),
    [frameMetadata, layout]
  )

  useEffect(() => {
    if (!frameGeometry) {
      return
    }
    setZoom((current) => {
      const next = clampBrowserZoomState(current, frameGeometry, MIN_ZOOM, MAX_ZOOM)
      if (
        next.scale === current.scale &&
        next.offsetX === current.offsetX &&
        next.offsetY === current.offsetY
      ) {
        return current
      }
      // Why: rotation/layout changes can shrink the legal pan range while the
      // current zoom state still points at the previous viewport geometry.
      zoomRef.current = next
      return next
    })
  }, [frameGeometry])

  useEffect(() => {
    streamGenerationRef.current += 1
    const generation = streamGenerationRef.current
    const sameStream = Boolean(cacheKey) && lastStreamCacheKeyRef.current === cacheKey
    lastStreamCacheKeyRef.current = cacheKey
    if (sameStream && framePacer.hasFrame()) {
      framePacer.reset()
    } else {
      const cachedFrame = getCachedBrowserFrame(cacheKey)
      framePacer.replace(cachedFrame?.uri ?? null)
      frameMetadataRef.current = cachedFrame?.metadata ?? null
      setFrameMetadata(cachedFrame?.metadata ?? null)
    }
    busyRef.current = false
    setDialog(null)
    setError(null)
    if (
      !client ||
      !binaryScreencastGranted ||
      screencastSupported !== true ||
      !tab.browserPageId ||
      !appActive ||
      !streamRequest
    ) {
      busyRef.current = false
      setBusy(false)
      if (!binaryScreencastGranted) {
        // Before the desktop's answer, because this one is about the app in the user's hand and no
        // desktop update can change it.
        setError('Update the Orca app to stream browser tabs here.')
      } else if (screencastSupported === false) {
        setError('Update desktop Orca to stream browser tabs on mobile.')
      } else if (screencastSupported === null) {
        setError('Checking desktop browser streaming support.')
      } else if (!tab.browserPageId) {
        setError('Browser page is not available yet.')
      }
      return
    }
    busyRef.current = true
    setBusy(true)
    let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (streamGenerationRef.current !== generation) {
        return
      }
      busyRef.current = false
      setBusy(false)
      setError('Browser stream timed out.')
    }, 15_000)
    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }
    const unsubscribe = client.subscribe(
      'browser.screencast',
      {
        worktree: `id:${worktreeId}`,
        page: tab.browserPageId,
        ...streamRequest
      },
      (payload) => {
        if (streamGenerationRef.current !== generation) {
          return
        }
        handleBrowserScreencastEvent({
          busyRef,
          clearStartupTimer,
          event: payload as ScreencastEvent,
          lastZoomResetUrlRef,
          resetBrowserZoomState,
          setAddressValue,
          setBusy,
          setDialog,
          setError
        })
      },
      {
        onBinaryFrame: (frame) => {
          if (streamGenerationRef.current !== generation) {
            return
          }
          clearStartupTimer()
          if (cacheKey) {
            framePacer.push(frame, cacheKey)
          }
        }
      }
    )
    return () => {
      clearStartupTimer()
      framePacer.reset()
      unsubscribe()
    }
  }, [
    appActive,
    binaryScreencastGranted,
    client,
    framePacer,
    resetBrowserZoomState,
    screencastSupported,
    streamRequest,
    cacheKey,
    tab.browserPageId,
    worktreeId
  ])

  return { frameGeometry, pageParams, sendBrowserRequest }
}
