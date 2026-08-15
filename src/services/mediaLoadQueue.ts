export type LoadPriority = 'high' | 'normal' | 'low'

interface QueueItem {
  id: string
  url: string
  priority: LoadPriority
  resolve: (value: boolean) => void
  isCancelled: boolean
}

const MAX_CONCURRENT_LOADS = 3
let activeLoads = 0
const queue: QueueItem[] = []
const loadedCache = new Set<string>()

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
    performImageLoad(item.url)
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
        if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
          window.requestAnimationFrame(processQueue)
        } else {
          setTimeout(processQueue, 0)
        }
      })
  }
}

function performImageLoad(url: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if ('decode' in img && typeof img.decode === 'function') {
        img.decode().then(() => resolve(true)).catch(() => resolve(true))
      } else {
        resolve(true)
      }
    }
    img.onerror = () => resolve(false)
    img.src = url
  })
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

  let cancelFn = () => {}
  const promise = new Promise<boolean>((resolve) => {
    const item: QueueItem = {
      id: Math.random().toString(36).slice(2),
      url,
      priority,
      resolve,
      isCancelled: false,
    }

    cancelFn = () => {
      item.isCancelled = true
      const index = queue.indexOf(item)
      if (index !== -1) {
        queue.splice(index, 1)
      }
    }

    queue.push(item)
    // Schedule processing with idle or next frame
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window && priority === 'low') {
      window.requestIdleCallback(() => processQueue())
    } else {
      processQueue()
    }
  })

  return { promise, cancel: cancelFn }
}

export function isMediaLoaded(url?: string): boolean {
  if (!url) return false
  return loadedCache.has(url)
}
