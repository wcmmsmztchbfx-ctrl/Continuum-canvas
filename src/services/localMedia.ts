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
export interface PreparedMediaAsset {
  kind: 'image' | 'video' | 'audio'
  url: string
  assetId?: string
  posterUrl?: string
  width: number
  height: number
  durationSec?: number
}

export async function extractImageDimensions(file: File): Promise<{ width: number; height: number }> {
  if (typeof document === 'undefined') return { width: 480, height: 320 }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const width = img.naturalWidth ? Math.min(600, Math.max(180, img.naturalWidth)) : 480
      const height = img.naturalHeight && img.naturalWidth
        ? Math.round(width * (img.naturalHeight / img.naturalWidth))
        : 320
      resolve({ width, height })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 480, height: 320 })
    }
    img.src = url
  })
}

export async function uploadAndPrepareMediaAsset(
  file: File,
  uploader: LocalAssetUploader = gatewayClient,
): Promise<PreparedMediaAsset> {
  const isVideo = file.type.startsWith('video/')
  const isAudio = file.type.startsWith('audio/')
  const kind: 'image' | 'video' | 'audio' = isVideo ? 'video' : isAudio ? 'audio' : 'image'

  let posterUrl: string | undefined
  let width = isVideo ? 480 : 480
  let height = isVideo ? 270 : 320
  let durationSec: number | undefined

  if (isVideo) {
    try {
      const meta = await extractVideoMetadata(file)
      if (meta.width && meta.height) {
        width = Math.min(600, Math.max(240, meta.width))
        height = Math.round(width * (meta.height / meta.width))
      }
      if (meta.durationSec) {
        durationSec = meta.durationSec
      }
      if (meta.blob) {
        try {
          const posterFile = new File(
            [meta.blob],
            `${file.name.replace(/\.[^.]+$/, '')}-cover.webp`,
            { type: 'image/webp' },
          )
          const posterAsset = await uploader.uploadAsset(posterFile, posterFile.name)
          posterUrl = posterAsset.url
        } catch {
          posterUrl = URL.createObjectURL(meta.blob)
        }
      }
    } catch {}
  } else if (kind === 'image') {
    try {
      const dims = await extractImageDimensions(file)
      width = dims.width
      height = dims.height
    } catch {}
  }

  let mediaUrl = ''
  let assetId: string | undefined
  try {
    const asset = await persistLocalMedia(file, uploader)
    mediaUrl = asset.url
    assetId = asset.assetId
  } catch {
    mediaUrl = URL.createObjectURL(file)
  }

  return {
    kind,
    url: mediaUrl,
    assetId,
    posterUrl,
    width,
    height,
    durationSec,
  }
}
