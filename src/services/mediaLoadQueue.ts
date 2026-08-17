export type LoadPriority = 'high' | 'normal' | 'low'

interface QueueItem {
  id: string
  url: string
  priority: LoadPriority
  resolve: (value: boolean) => void
  abortController?: AbortController
  isCancelled: boolean
}

const MAX_CONCURRENT_LOADS = 6
let activeLoads = 0
const queue: QueueItem[] = []
const loadedCache = new Set<string>()
const inFlightMap = new Map<string, Promise<boolean>>()

const PRIORITY_ORDER: Record<LoadPriority, number> = {
  high: 1,
  normal: 2,
  low: 3,
}

function processQueue() {
  if (activeLoads >= MAX_CONCURRENT_LOADS || queue.length === 0) {
    return
  }

  // Sort queue by priority: high -> normal -> low
  queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])

  while (activeLoads < MAX_CONCURRENT_LOADS && queue.length > 0) {
    const item = queue.shift()
    if (!item) break

    if (item.isCancelled) {
      item.resolve(false)
      continue
    }

    if (loadedCache.has(item.url)) {
      item.resolve(true)
      continue
    }

    activeLoads++
    const controller = new AbortController()
    item.abortController = controller

    performImageLoad(item.url, controller.signal)
      .then((success) => {
        if (success) loadedCache.add(item.url)
        item.resolve(success)
      })
      .catch(() => {
        item.resolve(false)
      })
      .finally(() => {
        activeLoads--
        // Use requestAnimationFrame or microtask to smoothly process next batch
        if (typeof window !== 'undefined' && 'requestAnimationFrame' in window && import.meta.env?.MODE !== 'test') {
          window.requestAnimationFrame(processQueue)
        } else {
          setTimeout(processQueue, 0)
        }
      })
  }
}

function performImageLoad(url: string, signal?: AbortSignal): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(true)
  }

  if (signal?.aborted) {
    return Promise.resolve(false)
  }

  if (inFlightMap.has(url)) {
    return inFlightMap.get(url)!
  }

  const promise = new Promise<boolean>((resolve) => {
    const img = new Image()
    let settled = false

    const cleanup = () => {
      if (settled) return
      settled = true
      img.onload = null
      img.onerror = null
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const onAbort = () => {
      if (settled) return
      cleanup()
      try {
        img.src = ''
      } catch {}
      resolve(false)
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    img.decoding = 'async'
    img.onload = () => {
      if (settled) return
      cleanup()
      if ('decode' in img && typeof img.decode === 'function') {
        img.decode().then(() => resolve(true)).catch(() => resolve(true))
      } else {
        resolve(true)
      }
    }
    img.onerror = () => {
      if (settled) return
      cleanup()
      resolve(false)
    }
    img.src = url
  }).finally(() => {
    inFlightMap.delete(url)
  })

  inFlightMap.set(url, promise)
  return promise
}

/**
 * Enqueues a media URL to be loaded in a controlled, staggered queue based on priority.
 */
export function requestMediaLoad(
  url: string,
  priority: LoadPriority = 'normal',
): { promise: Promise<boolean>; cancel: () => void } {
  if (!url || loadedCache.has(url)) {
    return {
      promise: Promise.resolve(true),
      cancel: () => {},
    }
  }

  if (inFlightMap.has(url)) {
    return {
      promise: inFlightMap.get(url)!,
      cancel: () => {},
    }
  }

  let item: QueueItem
  const promise = new Promise<boolean>((resolve) => {
    item = {
      id: Math.random().toString(36).slice(2),
      url,
      priority,
      resolve,
      isCancelled: false,
    }

    queue.push(item)
    // Schedule processing with idle or next frame
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window && priority === 'low') {
      window.requestIdleCallback(() => processQueue())
    } else {
      processQueue()
    }
  })

  const cancel = () => {
    if (item) {
      item.isCancelled = true
      item.abortController?.abort()
      const index = queue.indexOf(item)
      if (index !== -1) {
        queue.splice(index, 1)
      }
    }
  }

  return { promise, cancel }
}

export function isMediaLoaded(url?: string): boolean {
  if (!url) return false
  return loadedCache.has(url)
}

export function calculateLoadPriority(
  nodePos: { x: number; y: number } | undefined,
  nodeSize: { width: number; height: number } | undefined,
  viewport: { x: number; y: number; zoom: number },
): LoadPriority {
  if (!nodePos || typeof window === 'undefined') return 'normal'
  const zoom = Math.max(0.01, viewport.zoom)
  const viewLeft = -viewport.x / zoom
  const viewTop = -viewport.y / zoom
  const viewRight = (window.innerWidth - viewport.x) / zoom
  const viewBottom = (window.innerHeight - viewport.y) / zoom

  const buffer = 1000 / zoom
  const nodeWidth = nodeSize?.width || 300
  const nodeHeight = nodeSize?.height || 200
  const nodeRight = nodePos.x + nodeWidth
  const nodeBottom = nodePos.y + nodeHeight

  if (
    nodeRight >= viewLeft &&
    nodePos.x <= viewRight &&
    nodeBottom >= viewTop &&
    nodePos.y <= viewBottom
  ) {
    return 'high'
  }

  if (
    nodeRight >= viewLeft - buffer &&
    nodePos.x <= viewRight + buffer &&
    nodeBottom >= viewTop - buffer &&
    nodePos.y <= viewBottom + buffer
  ) {
    return 'normal'
  }

  return 'low'
}
