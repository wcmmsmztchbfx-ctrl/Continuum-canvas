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
 * Utility to convert an image URL or data URI to a standard PNG Blob.
 */
export async function imageToPngBlob(imageUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
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
    img.onerror = () => reject(new Error('无法加载图片'))
    img.src = imageUrl
  })
}

/**
 * Utility to copy image data to system clipboard as standard image/png binary.
 */
export async function copyImageToClipboard(imageUrl: string): Promise<void> {
  if (!imageUrl) throw new Error('图片地址为空')

  if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
    throw new Error('当前浏览器不支持写入图片剪贴板')
  }

  let pngBlob: Blob
  try {
    pngBlob = await imageToPngBlob(imageUrl)
  } catch {
    // If canvas drawing/CORS throws, fallback to direct fetch if blob is already image/png
    try {
      const response = await fetch(imageUrl)
      const blob = await response.blob()
      if (blob.type === 'image/png') {
        pngBlob = blob
      } else {
        throw new Error('无法转换图片格式为 PNG')
      }
    } catch {
      throw new Error('无法读取或转换图片数据')
    }
  }

  if (typeof ClipboardItem === 'undefined') {
    throw new Error('当前环境不支持 ClipboardItem')
  }

  const item = new ClipboardItem({ 'image/png': pngBlob })
  await navigator.clipboard.write([item])
}
