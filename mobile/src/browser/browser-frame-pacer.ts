import type { Dispatch, SetStateAction } from 'react'
import type { Image, ImageLoadEvent, View } from 'react-native'
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
import {
  updateBrowserImageSource,
  updateBrowserLayerVisibility,
  whenBrowserFrameDisplayable
} from './browser-frame-layer-paint'

type QueuedFrame = { frame: BrowserScreencastFrame; cacheKey: string }

type BrowserFramePacerDeps = {
  busyRef: { current: boolean }
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  initialUri: string | null
  setBusy: Dispatch<SetStateAction<boolean>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setFrameUri: Dispatch<SetStateAction<string | null>>
}

/** What one layer's `<View>` and `<Image>` hand the pacer. Stable, so binding them re-renders nothing. */
export type BrowserFrameLayerBinding = {
  attachView: (view: View | null) => void
  attachImage: (image: Image | null) => void
  onLoad: (event: ImageLoadEvent) => void
  onError: () => void
}

export type BrowserFramePacer = ReturnType<typeof createBrowserFramePacer>

/**
 * Owns the pane's double buffer: each frame decodes on the hidden layer and is shown by flipping
 * opacity once it has, at most one frame per interval, and never re-points a layer mid-decode.
 */
export function createBrowserFramePacer(deps: BrowserFramePacerDeps) {
  const views: [View | null, View | null] = [null, null]
  const images: [Image | null, Image | null] = [null, null]
  // The source each layer's Image holds; null for none, or for a load that failed or was dropped.
  const layerUris: [string | null, string | null] = [deps.initialUri, deps.initialUri]
  let visible: FrameLayer = 0
  let decoding: FrameLayer | null = null
  let queued: QueuedFrame | null = null
  let lastAppliedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function paint(layer: FrameLayer, uri: string | null): void {
    layerUris[layer] = uri
    if (uri !== null) {
      updateBrowserImageSource(images[layer], uri)
    }
  }

  function abandonDecode(): void {
    if (decoding !== null) {
      layerUris[decoding] = null
      decoding = null
    }
  }

  function flip(layer: FrameLayer, uri: string | undefined): void {
    // Why: a load for a source the layer has since moved off must not show the newer one early.
    if (decoding !== layer || layerUris[layer] !== uri) {
      return
    }
    decoding = null
    visible = layer
    updateBrowserLayerVisibility(views, layer)
    drain()
  }

  function fail(layer: FrameLayer): void {
    if (decoding === layer) {
      abandonDecode()
      drain()
    }
  }

  function show({ frame, cacheKey }: QueuedFrame): void {
    if (!browserFrameMetadataEqual(deps.frameMetadataRef.current, frame.metadata)) {
      deps.frameMetadataRef.current = frame.metadata
      deps.setFrameMetadata(frame.metadata)
    }
    if (deps.busyRef.current) {
      deps.busyRef.current = false
      deps.setBusy(false)
    }
    const uri = createBrowserFrameDataUri(frame)
    cacheBrowserFrame(cacheKey, { uri, metadata: frame.metadata })
    if (layerUris[visible] === null) {
      paint(0, uri)
      paint(1, uri)
      deps.setFrameUri(uri)
      return
    }
    const hidden: FrameLayer = visible === 0 ? 1 : 0
    decoding = hidden
    if (layerUris[hidden] === uri) {
      // Why: an unchanged source reloads nothing, so no onLoad would ever flip it (caret blink).
      flip(hidden, uri)
      return
    }
    paint(hidden, uri)
    // Why: a web `background-image` write fires no load event; native answers through onLoad.
    whenBrowserFrameDisplayable(uri, {
      onDisplayable: () => flip(hidden, uri),
      onUndecodable: () => {
        if (layerUris[hidden] === uri) {
          fail(hidden)
        }
      }
    })
  }

  // Why: never cut a decode short; re-pointing an Android layer mid-decode stalls flips under load.
  function drain(): void {
    if (timer !== null || queued === null || decoding !== null) {
      return
    }
    const wait = lastAppliedAt + MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS - Date.now()
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null
        drain()
      }, wait)
      return
    }
    const next = queued
    queued = null
    lastAppliedAt = Date.now()
    show(next)
  }

  // Why: static UI changes can be the last frame Chromium emits, so the newest is held, not dropped.
  function push(frame: BrowserScreencastFrame, cacheKey: string): void {
    queued = { frame, cacheKey }
    drain()
  }

  /** Drops every queued, timed or decoding frame and keeps the one on screen. */
  function reset(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    queued = null
    lastAppliedAt = 0
    abandonDecode()
  }

  /** Resets and puts `uri` on both layers, or clears them. */
  function replace(uri: string | null): void {
    reset()
    paint(0, uri)
    paint(1, uri)
    visible = 0
    updateBrowserLayerVisibility(views, visible)
    deps.setFrameUri(uri)
  }

  function bindLayer(layer: FrameLayer): BrowserFrameLayerBinding {
    return {
      attachView: (view) => {
        views[layer] = view
        updateBrowserLayerVisibility(views, visible)
      },
      attachImage: (image) => {
        images[layer] = image
        paint(layer, layerUris[layer])
      },
      // Why: RN Web's own load event carries no source, so the web flips only through its probe.
      onLoad: (event) => flip(layer, event.nativeEvent.source?.uri),
      onError: () => fail(layer)
    }
  }

  return {
    hasFrame: (): boolean => layerUris[visible] !== null,
    layers: [bindLayer(0), bindLayer(1)] as const,
    push,
    replace,
    reset
  }
}
