import { mediaPreviewKey, type MediaPreviewSource } from './mediaPreviewIdentity'
import { waitForCanvasIdle } from './canvasActivity'
import { requestMediaTask } from './mediaLoadQueue'
import { writeMediaPreview } from './mediaPreviewStorage'
export interface PreviewLease { url: string; release(): void }
interface PreviewEntry { blob: Blob; url: string; refs: number; width: number; height: number; touched: number }
const previews = new Map<string, PreviewEntry>()
function trimPreviews(all = false) {
  let bytes = 0, decoded = 0
  for (const [key, entry] of [...previews].sort((a, b) => b[1].touched - a[1].touched)) {
    if (entry.refs) continue
    bytes += entry.blob.size; decoded += entry.width * entry.height * 4
    if (all || bytes > 16 * 1024 * 1024 || decoded > 32 * 1024 * 1024) {
      URL.revokeObjectURL(entry.url); previews.delete(key)
    }
  }
}
export function clearIdlePreviews() { trimPreviews(true) }
export function getCachedPreviewBlob(key: string): Blob | undefined { return previews.get(key)?.blob }
export function acquirePreview(key: string): PreviewLease | undefined {
  const entry = previews.get(key)
  if (!entry) return undefined
  entry.refs++; entry.touched = Date.now()
  let released = false
  return { url: entry.url, release() { if (released) return; released = true; entry.refs--; entry.touched = Date.now(); trimPreviews() } }
}
export function storePreview(key: string, blob: Blob, dimensions: { width: number; height: number }): PreviewLease {
  if (!previews.has(key)) {
    previews.set(key, { blob, url: URL.createObjectURL(blob), refs: 0, ...dimensions, touched: Date.now() })
    void writeMediaPreview(key, blob)
  }
  const lease = acquirePreview(key)!
  trimPreviews()
  return lease
}
const listeners = new Set<(url: string, thumbnailUrl: string) => void>()

export function subscribeThumbnailReady(
  callback: (url: string, thumbnailUrl: string) => void,
): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notifyThumbnailReady(url: string, thumbnailUrl: string) {
  for (const listener of listeners) {
    listener(url, thumbnailUrl)
  }
}

export type LodLevel = 'thumbnail' | 'medium' | 'high' | 'original'

function parseOssCdnUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost')
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.hostname === 'libtv-res.liblib.art' || parsed.hostname.endsWith('.aliyuncs.com')) return parsed
  } catch { /* Invalid media URLs cannot use OSS transforms. */ }
  return undefined
}

function appendOssProcess(url: string, process: string): string {
  // Keep existing query bytes (including signatures) intact and leave the fragment last.
  const fragmentIndex = url.indexOf('#')
  const resource = fragmentIndex < 0 ? url : url.slice(0, fragmentIndex)
  const fragment = fragmentIndex < 0 ? '' : url.slice(fragmentIndex)
  return `${resource}${resource.includes('?') ? '&' : '?'}x-oss-process=${process}${fragment}`
}

/**
 * Resolves the appropriate image URL purely based on zoom level:
 * - zoom > 1.5: Original full-resolution image
 * - zoom <= 1.5: WebP format (w_360 for zoom <= 0.35, w_960 for 0.35 < zoom <= 1.5)
 */
export function getResponsiveImageUrl(
  url?: string,
  zoom: number = 1,
): string | undefined {
  if (!url) return undefined
  const parsed = parseOssCdnUrl(url)
  if (!parsed) {
    return url
  }
  if (parsed.searchParams.has('x-oss-process')) {
    return url
  }
  if (zoom > 1.5) {
    // zoom > 1.5: load original full-resolution image
    return url
  }
  if (zoom <= 0.35) {
    return appendOssProcess(url, 'image/resize,w_360/format,webp')
  }
  return appendOssProcess(url, 'image/resize,w_960/format,webp')
}

/**
 * Backwards-compatible alias for getResponsiveImageUrl
 */
export function getLodImageUrl(
  url?: string,
  lod: LodLevel = 'high',
): string | undefined {
  const zoom = lod === 'original' ? 2 : lod === 'thumbnail' ? 0.2 : 1
  return getResponsiveImageUrl(url, zoom)
}

/**
 * Computes LOD level based purely on zoom level
 */
export function calculateImageLod(
  _nodeWidth: number = 300,
  _nodeHeight: number = 200,
  zoom: number = 1,
): LodLevel {
  if (zoom > 1.5) return 'original'
  if (zoom <= 0.35) return 'thumbnail'
  return 'medium'
}

/**
 * Returns a fast thumbnail URL for a given image URL if immediately available.
 * For CDN images, returns a tiny w_360 WebP query URL.
 * For local/blob images, returns an in-memory WebP blob URL if already cached.
 */
export function getFastThumbnailUrl(
  url?: string,
  explicitThumbnailUrl?: string,
): string | undefined {
  if (!url) return undefined
  if (explicitThumbnailUrl && explicitThumbnailUrl !== url) {
    return explicitThumbnailUrl
  }

  // Support cloud OSS webp thumbnail process query directly from CDN
  const parsed = parseOssCdnUrl(url)
  if (parsed && !parsed.searchParams.has('x-oss-process')) {
    return appendOssProcess(url, 'image/resize,w_360/format,webp')
  }

  return undefined
}

/**
 * Extracts a lightweight WebP thumbnail from an already loaded DOM image or video element
 * without initiating any secondary network requests.
 */
export function cacheThumbnailFromElement(source: string | MediaPreviewSource, element: HTMLImageElement | HTMLVideoElement, maxDimension = 320): void {
  const url = typeof source === 'string' ? source : source.url
  const key = mediaPreviewKey(source, maxDimension)
  if (!url || previews.has(key) || typeof document === 'undefined') return
  const expectedSource = element.currentSrc || element.src
  const request = requestMediaTask({
    key: 'preview:' + key, kind: 'encode', priority: 'low', timeoutMs: 15000,
    run: signal => waitForCanvasIdle(signal).then(() => new Promise<void>((resolve, reject) => {
      if (signal.aborted || (element.currentSrc || element.src) !== expectedSource) { reject(new Error('Stale media')); return }
      const width = ('naturalWidth' in element ? element.naturalWidth : element.videoWidth) || element.width
      const height = ('naturalHeight' in element ? element.naturalHeight : element.videoHeight) || element.height
      if (!width || !height) { reject(new Error('Media has no dimensions')); return }
      const scale = Math.min(1, maxDimension / Math.max(width, height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
      try {
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('No canvas')); return }
        ctx.drawImage(element, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => {
          if (blob && !signal.aborted) {
            const lease = storePreview(key, blob, { width: canvas.width, height: canvas.height })
            notifyThumbnailReady(key, lease.url); lease.release()
          }
          canvas.width = 0; canvas.height = 0; resolve()
        }, 'image/webp', .7)
      } catch (error) { reject(error) }
    })),
  })
  void request.result
}

/** Explicit demand owns poster extraction. Reading a poster URL never starts work. */
export function requestVideoPoster(videoUrl: string) {
  const key = mediaPreviewKey(videoUrl)
  return requestMediaTask({
    key: 'poster:' + videoUrl, kind: 'poster', priority: 'low', timeoutMs: 15000,
    run: signal => new Promise<void>((resolve, reject) => {
      if (previews.has(key)) { resolve(); return }
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'; video.preload = 'metadata'; video.muted = true; video.playsInline = true
      let capturing = false, finished = false
      let encoding: ReturnType<typeof requestMediaTask<void>> | undefined
      const cleanup = () => {
        video.onloadedmetadata = null; video.onloadeddata = null; video.onseeked = null; video.onerror = null
        signal.removeEventListener('abort', abort); video.removeAttribute('src'); video.load()
      }
      const finish = (error?: unknown) => { if (finished) return; finished = true; cleanup(); if (error) reject(error); else resolve() }
      const abort = () => { encoding?.cancel(); finish(new DOMException('Aborted', 'AbortError')) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      const capture = () => {
        if (capturing || finished || video.readyState < 2 || video.seeking) return
        capturing = true
        encoding = requestMediaTask({
          key: 'preview:' + key, kind: 'encode', priority: 'low', timeoutMs: 15000,
          run: encodeSignal => new Promise<void>((done, fail) => {
            try {
              const canvas = document.createElement('canvas')
              canvas.width = Math.min(320, video.videoWidth || 480)
              canvas.height = Math.max(1, Math.round(canvas.width * (video.videoHeight || 270) / (video.videoWidth || 480)))
              const ctx = canvas.getContext('2d')
              if (!ctx) { fail(new Error('No canvas')); return }
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
              canvas.toBlob(blob => {
                if (blob && !signal.aborted && !encodeSignal.aborted) {
                  const lease = storePreview(key, blob, { width: canvas.width, height: canvas.height })
                  notifyThumbnailReady(key, lease.url); lease.release()
                }
                canvas.width = 0; canvas.height = 0; done()
              }, 'image/webp', .8)
            } catch (error) { fail(error) }
          }),
        })
        void encoding.result.then(result => finish(result.status === 'ready' ? undefined : new Error(result.status)))
      }
      video.onloadedmetadata = () => { try { video.currentTime = Math.min(.1, (video.duration || 1) / 2) } catch { capture() } }
      video.onloadeddata = capture; video.onseeked = capture
      video.onerror = () => finish(new Error('Video poster failed'))
      video.src = videoUrl
    }),
  })
}

/**
 * Returns a fast video poster URL (via Cloud OSS snapshot, explicit poster,
 * or background offscreen frame extraction).
 */
export function getVideoPosterUrl(
  videoUrl?: string,
  explicitPosterUrl?: string,
  zoom: number = 1,
): string | undefined {
  if (explicitPosterUrl) {
    return getResponsiveImageUrl(explicitPosterUrl, zoom) || getFastThumbnailUrl(explicitPosterUrl)
  }
  if (!videoUrl) return undefined

  // Cloud OSS video snapshot processing directly from CDN
  const parsed = parseOssCdnUrl(videoUrl)
  if (parsed && !parsed.searchParams.has('x-oss-process')) {
    if (zoom > 1.5) {
      // zoom > 1.5: load high-res original-dimension frame snapshot
      return appendOssProcess(videoUrl, 'video/snapshot,t_500,f_jpg')
    }
    if (zoom <= 0.35) {
      return appendOssProcess(videoUrl, 'video/snapshot,t_500,f_jpg,w_360,m_fast')
    }
    return appendOssProcess(videoUrl, 'video/snapshot,t_500,f_jpg,w_960,m_fast')
  }

  return undefined
}
