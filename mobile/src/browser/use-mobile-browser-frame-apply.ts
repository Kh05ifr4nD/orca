import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { Image } from 'react-native'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'
import {
  browserFrameMetadataEqual,
  cacheBrowserFrame,
  type FrameLayer
} from './mobile-browser-frame-state'
import { createBrowserFrameDataUri } from './browser-frame-data-uri'
import { updateBrowserImageSource, whenBrowserFrameDisplayable } from './browser-frame-layer-paint'
import {
  abandonBrowserFrameLayer,
  settleBrowserFrameLayer,
  type BrowserFrameLayerRefs
} from './browser-frame-layer-flip'

type PendingFrame = { frame: BrowserScreencastFrame; cacheKey: string }
// Why: a decode that never reports (a missed onLoad) must not hold every later frame back.
export const BROWSER_FRAME_DECODE_WATCHDOG_MS = 1_500
type BrowserFrameApplyArgs = BrowserFrameLayerRefs & {
  browserImageRefs: { current: [Image | null, Image | null] }
  busyRef: { current: boolean }
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  frameMountedRef: { current: boolean }
  frameThrottleTimerRef: { current: ReturnType<typeof setTimeout> | null }
  frameUriRef: { current: string | null }
  lastAppliedFrameAtRef: { current: number }
  pendingThrottledFrameRef: { current: PendingFrame | null }
  setBusy: Dispatch<SetStateAction<boolean>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setFrameUri: Dispatch<SetStateAction<string | null>>
}
export function useMobileBrowserFrameApply(args: BrowserFrameApplyArgs) {
  const {
    browserImageRefs,
    browserLayerRefs,
    busyRef,
    frameMetadataRef,
    frameMountedRef,
    frameThrottleTimerRef,
    frameUriRef,
    lastAppliedFrameAtRef,
    pendingFrameLayerRef,
    pendingThrottledFrameRef,
    setBusy,
    setFrameMetadata,
    setFrameUri,
    visibleFrameLayerRef
  } = args
  const decodeWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drainQueuedFrameRef = useRef<() => void>(() => {})
  // What each layer was last pointed at; null once a reset re-sources the layers behind this hook.
  const layerUrisRef = useRef<[string | null, string | null]>([null, null])
  const layerRefs = { browserLayerRefs, pendingFrameLayerRef, visibleFrameLayerRef }

  // Why: a `background-image` write fires no load event, so on the web the layer the frame landed
  // on has to be told when it has decoded. Native answers through the `<Image>`'s own `onLoad`,
  // and this is a no-op there.
  const armFrameLayerFlip = useCallback((layer: FrameLayer, uri: string): void => {
    // Both arms and the watchdog answer for the frame they were armed with, not for the layer: a
    // stream reset may have moved the layer on, and a late answer must not flip or free it.
    const isCurrentFrame = (): boolean => frameUriRef.current === uri
    whenBrowserFrameDisplayable(uri, {
      onDisplayable: () => {
        if (isCurrentFrame()) {
          settleBrowserFrameLayer(layerRefs, layer)
          drainQueuedFrameRef.current()
        }
      },
      onUndecodable: () => {
        if (isCurrentFrame()) {
          abandonBrowserFrameLayer(layerRefs, layer)
          drainQueuedFrameRef.current()
        }
      }
    })
    if (decodeWatchdogRef.current) {
      clearTimeout(decodeWatchdogRef.current)
    }
    decodeWatchdogRef.current = setTimeout(() => {
      decodeWatchdogRef.current = null
      if (isCurrentFrame()) {
        layerUrisRef.current[layer] = null
        abandonBrowserFrameLayer(layerRefs, layer)
        drainQueuedFrameRef.current()
      }
    }, BROWSER_FRAME_DECODE_WATCHDOG_MS)
  }, [])

  const applyFrame = useCallback(
    (frame: BrowserScreencastFrame, frameCacheKey: string): void => {
      if (!browserFrameMetadataEqual(frameMetadataRef.current, frame.metadata)) {
        frameMetadataRef.current = frame.metadata
        setFrameMetadata(frame.metadata)
      }
      const nextFrameUri = createBrowserFrameDataUri(frame)
      cacheBrowserFrame(frameCacheKey, { uri: nextFrameUri, metadata: frame.metadata })
      if (!frameMountedRef.current) {
        frameUriRef.current = nextFrameUri
        frameMountedRef.current = true
        // Both layers render this state source, so both hold it.
        layerUrisRef.current = [nextFrameUri, nextFrameUri]
        setFrameUri(nextFrameUri)
        updateBrowserImageSource(browserImageRefs.current[0], nextFrameUri)
      } else {
        // Why: decode the next frame offscreen and keep the previous layer visible
        // until onLoad; replacing the visible Image directly flashes black.
        const nextLayer: FrameLayer = visibleFrameLayerRef.current === 0 ? 1 : 0
        frameUriRef.current = nextFrameUri
        pendingFrameLayerRef.current = nextLayer
        if (layerUrisRef.current[nextLayer] === nextFrameUri) {
          // Why: an unchanged source reloads nothing, so no onLoad would ever flip it (caret blink).
          settleBrowserFrameLayer(layerRefs, nextLayer)
        } else {
          layerUrisRef.current[nextLayer] = nextFrameUri
          updateBrowserImageSource(browserImageRefs.current[nextLayer], nextFrameUri)
          armFrameLayerFlip(nextLayer, nextFrameUri)
        }
      }
      if (busyRef.current) {
        busyRef.current = false
        setBusy(false)
      }
    },
    [armFrameLayerFlip]
  )

  const clearFrameThrottle = useCallback(() => {
    pendingThrottledFrameRef.current = null
    if (frameThrottleTimerRef.current) {
      clearTimeout(frameThrottleTimerRef.current)
      frameThrottleTimerRef.current = null
    }
    if (decodeWatchdogRef.current) {
      clearTimeout(decodeWatchdogRef.current)
      decodeWatchdogRef.current = null
    }
    layerUrisRef.current = [null, null]
  }, [])

  /**
   * Applies the newest held frame once both the pacer interval has passed and no layer is still
   * decoding. Called on every frame and again whenever a layer settles.
   */
  const drainQueuedFrame = useCallback((): void => {
    if (frameThrottleTimerRef.current) {
      return
    }
    if (pendingFrameLayerRef.current !== null) {
      return
    }
    if (decodeWatchdogRef.current) {
      clearTimeout(decodeWatchdogRef.current)
      decodeWatchdogRef.current = null
    }
    const queued = pendingThrottledFrameRef.current
    if (!queued) {
      return
    }
    const now = Date.now()
    const elapsed = now - lastAppliedFrameAtRef.current
    if (lastAppliedFrameAtRef.current !== 0 && elapsed < MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS) {
      frameThrottleTimerRef.current = setTimeout(() => {
        frameThrottleTimerRef.current = null
        drainQueuedFrameRef.current()
      }, MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS - elapsed)
      return
    }
    pendingThrottledFrameRef.current = null
    lastAppliedFrameAtRef.current = now
    applyFrame(queued.frame, queued.cacheKey)
  }, [applyFrame])
  useLayoutEffect(() => {
    drainQueuedFrameRef.current = drainQueuedFrame
  }, [drainQueuedFrame])

  // Why: static UI changes can be the last frame Chromium emits, so the newest frame is held
  // rather than dropped. A still-decoding layer is never re-pointed: that cancels its load, and on
  // a phone slower to decode than frames arrive the pane would never flip during a busy page.
  const applyFrameThrottled = useCallback(
    (frame: BrowserScreencastFrame, frameCacheKey: string): void => {
      pendingThrottledFrameRef.current = { frame, cacheKey: frameCacheKey }
      drainQueuedFrame()
    },
    [drainQueuedFrame]
  )
  return { applyFrameThrottled, clearFrameThrottle, drainQueuedFrame }
}
