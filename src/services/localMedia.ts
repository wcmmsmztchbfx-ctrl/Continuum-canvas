import { gatewayClient } from './gatewayClient'

export interface LocalAssetUploader {
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

export interface TranscodedImageResult {
  file: File
  width: number
  height: number
  wasTranscoded: boolean
}

export interface PreparedMediaAsset {
  kind: 'image' | 'video' | 'audio'
  url: string
  assetId?: string
  posterUrl?: string
  width: number
  height: number
  durationSec?: number
  filename: string
}

/**
 * Transcodes an input image (PNG, JPEG, BMP, etc.) into high-quality WebP format.
 * If the image is already in WebP format or transcoding is unavailable (e.g. Node/SSR),
 * it returns the original file alongside its measured dimensions.
 */
export async function transcodeImageToWebP(
  file: File,
  quality = 0.9,
): Promise<TranscodedImageResult> {
  if (typeof document === 'undefined') {
    return { file, width: 480, height: 320, wasTranscoded: false }
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()

    let finished = false
    const finish = (result: TranscodedImageResult) => {
      if (finished) return
      finished = true
      URL.revokeObjectURL(objectUrl)
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({ file, width: 480, height: 320, wasTranscoded: false })
    }, 5000)

    img.onload = () => {
      clearTimeout(timer)
      const naturalWidth = img.naturalWidth || 480
      const naturalHeight = img.naturalHeight || 320

      // If already WebP or GIF, skip canvas re-encoding to preserve animation/quality
      if (file.type === 'image/webp' || file.type === 'image/gif') {
        finish({
          file,
          width: naturalWidth,
          height: naturalHeight,
          wasTranscoded: false,
        })
        return
      }

      try {
        const canvas = document.createElement('canvas')
        canvas.width = naturalWidth
        canvas.height = naturalHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0, naturalWidth, naturalHeight)
          canvas.toBlob(
            (blob) => {
              if (blob) {
                const baseName = file.name.replace(/\.[^.]+$/, '') || 'image'
                const webpFile = new File([blob], `${baseName}.webp`, {
                  type: 'image/webp',
                  lastModified: Date.now(),
                })
                finish({
                  file: webpFile,
                  width: naturalWidth,
                  height: naturalHeight,
                  wasTranscoded: true,
                })
                return
              }
              finish({
                file,
                width: naturalWidth,
                height: naturalHeight,
                wasTranscoded: false,
              })
            },
            'image/webp',
            quality,
          )
          return
        }
      } catch {}

      finish({
        file,
        width: naturalWidth,
        height: naturalHeight,
        wasTranscoded: false,
      })
    }

    img.onerror = () => {
      clearTimeout(timer)
      finish({ file, width: 480, height: 320, wasTranscoded: false })
    }

    img.src = objectUrl
  })
}

/**
 * Extracts metadata and a WebP snapshot poster from a local video file.
 */
export async function extractVideoMetadata(file: File): Promise<VideoMetadata> {
  if (typeof document === 'undefined') return {}
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    // Metadata extraction accepts only local object URLs, never executable or remote URLs.
    if (!/^blob:/i.test(url)) {
      URL.revokeObjectURL(url)
      resolve({})
      return
    }
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
    }, 5000)

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

/**
 * Measures the natural dimensions of an image.
 */
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

/**
 * Unified Media Processing Pipeline Facade:
 * 1. Automatic format detection (Image / Video / Audio).
 * 2. Transcodes images (PNG, JPEG, BMP) into standardized WebP format.
 * 3. Extracts first-frame WebP snapshot poster and duration for videos.
 * 4. Persists the assets to backend storage via gatewayClient.
 * 5. Returns a ready-to-use PreparedMediaAsset payload.
 */
export async function uploadAndPrepareMediaAsset(
  file: File,
  uploader: LocalAssetUploader = gatewayClient,
): Promise<PreparedMediaAsset> {
  const isVideo = file.type.startsWith('video/')
  const isAudio = file.type.startsWith('audio/')
  const kind: 'image' | 'video' | 'audio' = isVideo ? 'video' : isAudio ? 'audio' : 'image'

  let fileToUpload = file
  let posterUrl: string | undefined
  let width = isVideo ? 480 : 480
  let height = isVideo ? 270 : 320
  let durationSec: number | undefined

  if (kind === 'image') {
    try {
      const transcoded = await transcodeImageToWebP(file)
      fileToUpload = transcoded.file
      if (transcoded.width && transcoded.height) {
        width = Math.min(600, Math.max(180, transcoded.width))
        height = Math.round(width * (transcoded.height / transcoded.width))
      }
    } catch {
      const dims = await extractImageDimensions(file)
      width = dims.width
      height = dims.height
    }
  } else if (isVideo) {
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
  }

  let mediaUrl = ''
  let assetId: string | undefined
  try {
    const asset = await persistLocalMedia(fileToUpload, uploader)
    mediaUrl = asset.url
    assetId = asset.assetId
  } catch (error) {
    if (kind === 'video') {
      throw new Error(
        error instanceof Error ? error.message : '视频上传保存失败，请检查后端服务连接',
      )
    }
    mediaUrl = URL.createObjectURL(fileToUpload)
  }

  return {
    kind,
    url: mediaUrl,
    assetId,
    posterUrl,
    width,
    height,
    durationSec,
    filename: fileToUpload.name,
  }
}
