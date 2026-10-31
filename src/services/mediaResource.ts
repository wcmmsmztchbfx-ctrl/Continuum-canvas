import { mediaPreviewKey } from './mediaPreviewIdentity'
import { getCachedPreviewBlob } from './imageThumbnailCache'
import { readMediaPreview } from './mediaPreviewStorage'
import { requestMediaTask, type LoadPriority, type MediaTaskResult, type MediaTaskSubscription } from './mediaLoadQueue'
import type { MediaDemand, MediaVariant } from '../components/canvas/canvasMediaDemand'
export interface MediaSource { url: string; assetId?: string; version?: string; mimeType?: string }
export interface MediaResource { displayUrl: string; width: number; height: number; mode: 'blob' | 'native'; preserveAnimation?: boolean; preview?: boolean; originalWidth?: number; originalHeight?: number }
export interface MediaResourceLease {
  result: Promise<MediaTaskResult<MediaResource>>
  updateDemand(demand: MediaDemand): void
  release(): void
}
interface Entry { key: string; demands: Map<symbol, MediaDemand>; refs: number; bytes: number; value?: MediaResource; task?: MediaTaskSubscription<MediaResource>; touched: number }
const entries = new Map<string, Entry>()
const priority = (demand: MediaDemand): LoadPriority => demand === 'active' ? 'high' : demand === 'visible' ? 'normal' : 'low'
function entryPriority(entry: Entry): LoadPriority {
  const demands = [...entry.demands.values()]
  return demands.includes('active') ? 'high' : demands.includes('visible') ? 'normal' : 'low'
}
export function resolveMediaUrl(source: MediaSource, variant: MediaVariant): string {
  const url = source.url
  if (variant === 'original') return url
  try {
    const parsed = new URL(url, globalThis.location?.href ?? 'http://localhost')
    const origin = globalThis.location?.origin ?? 'http://localhost'
    if (parsed.origin === origin && /^\/api\/assets\/[0-9a-f-]{36}$/i.test(parsed.pathname) && !parsed.search) {
      return url + '?preview=' + variant + '&v=1'
    }
    if (/gif|webp/i.test(source.mimeType ?? '') || /\.(gif|webp)(?:[?#]|$)/i.test(url)) return url
    // Never alter signed requests or arbitrary hosts.
    if (!(parsed.hostname === 'libtv-res.liblib.art' || parsed.hostname.endsWith('.aliyuncs.com')) || parsed.search) return url
    return url + '?x-oss-process=image/resize,w_' + variant + '/format,webp'
  } catch { return url }
}
function evict(all = false) {
  let blobs = 0, decoded = 0
  const idle = [...entries.values()].filter(entry => entry.refs === 0 && entry.value)
    .sort((a, b) => b.touched - a.touched)
  for (const entry of idle) {
    blobs += entry.bytes; decoded += entry.value!.width * entry.value!.height * 4
    if (!all && blobs <= 16 * 1024 * 1024 && decoded <= 32 * 1024 * 1024 && Date.now() - entry.touched < 60_000) continue
    if (entry.value?.mode === 'blob') URL.revokeObjectURL(entry.value.displayUrl)
    entries.delete(entry.key)
  }
}
export function clearIdleMediaResources() { evict(true) }
function dimensions(url: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let decode: MediaTaskSubscription<void> | undefined
    const cleanup = () => { img.onload = null; img.onerror = null; signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); decode?.cancel(); img.src = ''; reject(new DOMException('Aborted', 'AbortError')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    img.onerror = () => { cleanup(); reject(new Error('Image failed')) }
    img.onload = () => {
      const finish = () => { cleanup(); if (!signal.aborted) resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
      if (typeof img.decode !== 'function') { finish(); return }
      decode = requestMediaTask({ key: url, kind: 'decode', priority: 'normal', timeoutMs: 30000, run: () => img.decode() })
      void decode.result.then(finish)
    }
    img.decoding = 'async'; img.src = url
  })
}
export function acquireMediaResource(input: { source: MediaSource; variant: MediaVariant; demand: MediaDemand; sessionId: string }): MediaResourceLease {
  const { source, variant } = input
  const resolvedUrl = resolveMediaUrl(source, variant)
  const serverPreview = /[?&]preview=(128|360|960|1920)&v=1$/.test(resolvedUrl) && resolvedUrl !== source.url
  const previewSize = !serverPreview && (variant === 128 || variant === 360) && !/gif|webp/i.test(source.mimeType ?? '') && !/\.(gif|webp)(?:[?#]|$)/i.test(source.url)
  const key = JSON.stringify([resolvedUrl, source.assetId, source.version, source.mimeType, previewSize ? 'preview' : 'display', 'same-origin'])
  const consumer = Symbol(input.sessionId)
  let released = false, settled = false, entry: Entry | undefined, demand = input.demand
  let settle!: (result: MediaTaskResult<MediaResource>) => void
  const result = new Promise<MediaTaskResult<MediaResource>>(resolve => { settle = value => { if (!settled) { settled = true; resolve(value) } } })
  const start = () => {
    if (released || entry || demand === 'none' || !source.url) return
    evict()
    entry = entries.get(key)
    if (!entry) { entry = { key, demands: new Map(), refs: 0, bytes: 0, touched: Date.now() }; entries.set(key, entry) }
    entry.refs++
    entry.demands.set(consumer, demand)
    entry.task?.setPriority(entryPriority(entry))
    const owned = entry
    if (owned.value) { settle({ status: 'ready', value: owned.value }); return }
    if (!owned.task) {
      const url = resolvedUrl
      owned.task = requestMediaTask({ key: 'resource:' + key, kind: 'image', priority: priority(demand), timeoutMs: 30000,
        run: async signal => {
          let blob: Blob
          let preview = false, originalWidth: number | undefined, originalHeight: number | undefined
          let usedCache = false
          try {
            const cached = previewSize ? getCachedPreviewBlob(mediaPreviewKey(source)) ?? await readMediaPreview(mediaPreviewKey(source)) : undefined
            if (cached) { blob = cached; usedCache = true }
            else {
              const response = await fetch(url, { signal, credentials: 'same-origin' })
              if (!response.ok) throw new Error('Image response failed')
              blob = await response.blob()
              preview = response.headers.get('x-image-preview') === '1'
              const width = Number(response.headers.get('x-image-original-width'))
              const height = Number(response.headers.get('x-image-original-height'))
              if (width > 0 && height > 0) { originalWidth = width; originalHeight = height }
            }
          } catch (error) {
            if (signal.aborted || serverPreview) throw error
            // Cross-origin servers may permit native display but disallow fetch.
            return { displayUrl: url, width: 0, height: 0, mode: 'native' as const, preserveAnimation: true }
          }
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const displayUrl = URL.createObjectURL(blob)
          try {
            const size = await dimensions(displayUrl, signal)
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
            owned.bytes = blob.size
            const original = !usedCache && !preview && (resolvedUrl === source.url || serverPreview)
            return { displayUrl, ...size, mode: 'blob' as const, preview,
              originalWidth: originalWidth ?? (original ? size.width : undefined),
              originalHeight: originalHeight ?? (original ? size.height : undefined),
              preserveAnimation: !preview && /image\/(gif|webp)/i.test(blob.type) }
          } catch (error) { URL.revokeObjectURL(displayUrl); throw error }
        },
      })
      void owned.task.result.then(outcome => {
        owned.task = undefined
        if (outcome.status === 'ready') owned.value = outcome.value
        if (owned.refs === 0) {
          if (entries.get(key) !== owned) {
            if (outcome.status === 'ready' && outcome.value.mode === 'blob') URL.revokeObjectURL(outcome.value.displayUrl)
          } else if (outcome.status !== 'ready') entries.delete(key)
          evict()
        }
      })
    }
    void owned.task.result.then(outcome => { if (!released) settle(outcome) })
  }
  start()
  return {
    result,
    updateDemand(next) { if (released) return; demand = next; start(); if (entry) { entry.demands.set(consumer, next); entry.task?.setPriority(entryPriority(entry)) } },
    release() {
      if (released) return
      released = true; settle({ status: 'cancelled' })
      if (!entry) return
      entry.demands.delete(consumer)
      entry.task?.setPriority(entryPriority(entry))
      entry.refs--; entry.touched = Date.now()
      if (entry.refs === 0 && entry.task) { entry.task.cancel(); entries.delete(key) }
      evict()
    },
  }
}
