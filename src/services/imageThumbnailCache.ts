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

const pendingVideoThumbnails = new Set<string>()

function generateVideoThumbnail(videoUrl: string): void {
  if (pendingVideoThumbnails.has(videoUrl) || memoryThumbnailCache.has(videoUrl)) return
  if (typeof document === 'undefined') return
  pendingVideoThumbnails.add(videoUrl)

  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true

  let finished = false
  const cleanup = () => {
    if (finished) return
    finished = true
    pendingVideoThumbnails.delete(videoUrl)
    video.removeAttribute('src')
    video.load()
  }

  const timer = setTimeout(() => {
    cleanup()
  }, 6000)

  video.onloadeddata = () => {
    try {
      const width = video.videoWidth || 480
      const height = video.videoHeight || 270
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(480, width)
      canvas.height = Math.round(canvas.width * (height / width))
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          clearTimeout(timer)
          cleanup()
          if (blob) {
            const objectUrl = URL.createObjectURL(blob)
            memoryThumbnailCache.set(videoUrl, objectUrl)
            notifyThumbnailReady(videoUrl, objectUrl)
          }
        }, 'image/webp', 0.8)
        return
      }
    } catch {}
    clearTimeout(timer)
    cleanup()
  }

  video.onerror = () => {
    clearTimeout(timer)
    cleanup()
  }

  video.currentTime = 0.1
  video.src = videoUrl
}

/**
 * Returns a fast video poster URL (via Cloud OSS snapshot, explicit poster,
 * or background offscreen frame extraction).
 */
export function getVideoPosterUrl(
  videoUrl?: string,
  explicitPosterUrl?: string,
): string | undefined {
  if (explicitPosterUrl) {
    return getFastThumbnailUrl(explicitPosterUrl)
  }
  if (!videoUrl) return undefined

  // Cloud OSS video snapshot processing directly from CDN
  if (videoUrl.includes('libtv-res.liblib.art') || videoUrl.includes('.aliyuncs.com')) {
    if (!videoUrl.includes('x-oss-process')) {
      const separator = videoUrl.includes('?') ? '&' : '?'
      return `${videoUrl}${separator}x-oss-process=video/snapshot,t_500,f_jpg,w_480,m_fast`
    }
  }

  // Check in-memory generated blob cache
  if (memoryThumbnailCache.has(videoUrl)) {
    return memoryThumbnailCache.get(videoUrl)
  }

  // Offscreen client extraction for local/gateway/blob video URLs
  if (typeof document !== 'undefined' && !pendingVideoThumbnails.has(videoUrl)) {
    generateVideoThumbnail(videoUrl)
  }

  return undefined
}
