import { gatewayClient } from './gatewayClient'

interface LocalAssetUploader {
  uploadAsset(body: Blob, filename: string): Promise<{
    id: string
    url: string
  }>
}

const LOCAL_ASSET_URL = /^\/api\/assets\/([0-9a-f-]{36})$/i

export async function persistLocalMedia(
  file: File,
  uploader: LocalAssetUploader = gatewayClient,
): Promise<{ assetId: string; url: string }> {
  const asset = await uploader.uploadAsset(file, file.name)
  const match = LOCAL_ASSET_URL.exec(asset.url)
  if (!match || match[1].toLowerCase() !== asset.id.toLowerCase()) {
    throw new Error('Upload did not return a stable local asset')
  }
  return { assetId: asset.id, url: asset.url }
}

export interface VideoMetadata {
  blob?: Blob
  width?: number
  height?: number
  durationSec?: number
}

export async function extractVideoMetadata(file: File): Promise<VideoMetadata> {
  if (typeof document === 'undefined') return {}
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    let finished = false
    const finish = (result: VideoMetadata) => {
      if (finished) return
      finished = true
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({})
    }, 4000)

    video.onloadeddata = () => {
      try {
        const width = video.videoWidth || 480
        const height = video.videoHeight || 270
        const durationSec = Number.isFinite(video.duration) ? Math.round(video.duration) : 5
        const canvas = document.createElement('canvas')
        canvas.width = Math.min(640, width)
        canvas.height = Math.round(canvas.width * (height / width))
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          canvas.toBlob((blob) => {
            clearTimeout(timer)
            finish({
              blob: blob || undefined,
              width,
              height,
              durationSec,
            })
          }, 'image/webp', 0.85)
          return
        }
      } catch {}
      clearTimeout(timer)
      finish({})
    }

    video.onerror = () => {
      clearTimeout(timer)
      finish({})
    }

    video.currentTime = 0.1
    video.src = url
  })
}
