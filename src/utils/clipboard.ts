/**
 * Utility to copy plain text to system clipboard with fallback support.
 */
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

/**
 * Utility to convert a Blob to base64 data URI.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('无法读取图片数据'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Utility to convert an image URL or data URI to a standard PNG Blob.
 */
export async function imageToPngBlob(imageUrl: string): Promise<Blob> {
  // 1. Try fetch first to obtain blob cleanly without canvas CORS taint
  try {
    const controller = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? { signal: AbortSignal.timeout(3000) }
      : {}
    const response = await fetch(imageUrl, controller)
    if (response.ok) {
      const blob = await response.blob()
      if (blob.type === 'image/png') {
        return blob
      }
      // If it is another image format (e.g. image/jpeg, image/webp), convert via createImageBitmap or canvas
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob)
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width || 1
          canvas.height = bitmap.height || 1
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0)
            const converted = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
            if (converted) return converted
          }
        } catch {}
      }
    }
  } catch {
    // Proceed to Image element loading fallback
  }

  // 2. Fallback to HTMLImageElement
  return new Promise((resolve, reject) => {
    const img = new Image()
    const timer = setTimeout(() => {
      reject(new Error('图片加载超时'))
    }, 6000)

    try {
      if (typeof window !== 'undefined' && window.location?.origin) {
        const parsed = new URL(imageUrl, window.location.origin)
        if (parsed.origin !== window.location.origin) {
          img.crossOrigin = 'anonymous'
        }
      }
    } catch {}

    img.onload = () => {
      clearTimeout(timer)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width || 1
        canvas.height = img.naturalHeight || img.height || 1
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('无法创建 Canvas 上下文'))
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('图片转换 PNG 失败'))
          }
        }, 'image/png')
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => {
      clearTimeout(timer)
      reject(new Error('无法加载图片'))
    }
    img.src = imageUrl
  })
}

export interface CopyImageResult {
  fallback: boolean
  format: 'binary' | 'html' | 'text'
}

/**
 * Utility to copy image data to system clipboard.
 * Prioritizes standard image/png binary via ClipboardItem in secure contexts.
 * Gracefully falls back to rich HTML <img> and full absolute URL in non-secure (HTTP LAN) or restricted environments.
 */
export async function copyImageToClipboard(imageUrl: string): Promise<CopyImageResult> {
  if (!imageUrl) throw new Error('图片地址为空')

  const fullUrl =
    typeof window !== 'undefined' && window.location?.origin
      ? new URL(imageUrl, window.location.origin).href
      : imageUrl

  let pngBlob: Blob | undefined
  try {
    pngBlob = await imageToPngBlob(fullUrl)
  } catch {
    // imageToPngBlob failed, proceed to fallback with direct fetch if possible
    try {
      const response = await fetch(fullUrl)
      const blob = await response.blob()
      if (blob.type === 'image/png') {
        pngBlob = blob
      }
    } catch {}
  }

  // 1. Try binary ClipboardItem write if supported in current context
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    typeof ClipboardItem !== 'undefined' &&
    pngBlob
  ) {
    try {
      const item = new ClipboardItem({ 'image/png': pngBlob })
      await navigator.clipboard.write([item])
      return { fallback: false, format: 'binary' }
    } catch {
      // If binary write throws (e.g. NotAllowedError / SecurityError in HTTP context), proceed to fallback
    }
  }

  // 2. Graceful fallback: rich HTML <img> tag (with Data URI and full URL) + plain text full URL
  if (typeof document !== 'undefined') {
    let htmlCopied = false
    let dataUri = ''
    if (pngBlob) {
      try {
        dataUri = await blobToDataUrl(pngBlob)
      } catch {}
    }

    const html = dataUri
      ? `<img src="${dataUri}" data-src="${fullUrl}" alt="image" />`
      : `<img src="${fullUrl}" alt="image" />`

    const listener = (event: ClipboardEvent) => {
      event.preventDefault()
      if (event.clipboardData) {
        event.clipboardData.setData('text/html', html)
        event.clipboardData.setData('text/plain', fullUrl)
        htmlCopied = true
      }
    }
    document.addEventListener('copy', listener)
    try {
      document.execCommand('copy')
    } catch {
      htmlCopied = false
    } finally {
      document.removeEventListener('copy', listener)
    }

    if (htmlCopied) {
      return { fallback: true, format: 'html' }
    }
  }

  // 3. Fallback to plain text copy of full URL
  try {
    await copyText(fullUrl)
    return { fallback: true, format: 'text' }
  } catch {
    throw new Error('当前浏览器不支持写入剪贴板')
  }
}
