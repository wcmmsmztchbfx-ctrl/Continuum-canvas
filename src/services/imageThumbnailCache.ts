const memoryThumbnailCache = new Map<string, string>()
const pendingGenerations = new Map<string, Promise<string | undefined>>()
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

/**
 * Returns a fast thumbnail URL for a given image URL if immediately available,
 * or triggers lightweight background thumbnail derivation.
 */
export function getFastThumbnailUrl(
  url?: string,
  explicitThumbnailUrl?: string,
): string | undefined {
  if (!url) return undefined
  if (explicitThumbnailUrl && explicitThumbnailUrl !== url) {
    return explicitThumbnailUrl
  }

  // Gateway assets can be served with thumbnail query
  if (url.startsWith('/api/assets/')) {
    return `${url}${url.includes('?') ? '&' : '?'}thumbnail=1`
  }

  // Support cloud OSS webp thumbnail process query directly from CDN
  if (url.includes('libtv-res.liblib.art') || url.includes('.aliyuncs.com')) {
    if (!url.includes('x-oss-process')) {
      const separator = url.includes('?') ? '&' : '?'
      return `${url}${separator}x-oss-process=image/resize,w_480/format,webp`
    }
  }

  // Check in-memory generated blob cache
  if (memoryThumbnailCache.has(url)) {
    return memoryThumbnailCache.get(url)
  }

  // Trigger non-blocking generation in browser environment if not already pending
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && !pendingGenerations.has(url)) {
    const trigger = () => {
      const promise = generateClientThumbnail(url)
        .then((thumb) => {
          if (thumb) {
            memoryThumbnailCache.set(url, thumb)
            notifyThumbnailReady(url, thumb)
          }
          return thumb
        })
        .catch(() => undefined)
        .finally(() => {
          pendingGenerations.delete(url)
        })
      pendingGenerations.set(url, promise)
    }

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(trigger, { timeout: 2000 })
    } else {
      setTimeout(trigger, 120)
    }
  }

  return undefined
}

async function generateClientThumbnail(
  sourceUrl: string,
  maxDimension = 320,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        if (!width || !height) {
          resolve(undefined)
          return
        }

        const scale = Math.min(1, maxDimension / Math.max(width, height))
        const targetWidth = Math.max(16, Math.round(width * scale))
        const targetHeight = Math.max(16, Math.round(height * scale))

        const canvas = document.createElement('canvas')
        canvas.width = targetWidth
        canvas.height = targetHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(undefined)
          return
        }

        ctx.drawImage(img, 0, 0, targetWidth, targetHeight)
        canvas.toBlob(
          (blob) => {
            if (blob) {
              const objectUrl = URL.createObjectURL(blob)
              resolve(objectUrl)
            } else {
              resolve(undefined)
            }
          },
          'image/webp',
          0.6,
        )
      } catch {
        resolve(undefined)
      }
    }
    img.onerror = () => resolve(undefined)
    img.src = sourceUrl
  })
}
