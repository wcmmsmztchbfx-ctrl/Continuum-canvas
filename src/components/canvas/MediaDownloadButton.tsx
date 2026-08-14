import { Download } from 'lucide-react'

const SAFE_FILENAME_CHARACTER = /[^\p{L}\p{N}._ -]+/gu

function extensionFromUrl(url: string, kind: 'image' | 'video'): string {
  try {
    const match = new URL(url, globalThis.location?.origin ?? 'http://localhost')
      .pathname.match(/\.([a-z0-9]{2,5})$/i)
    if (match?.[1]) return match[1].toLowerCase()
  } catch {
    // A malformed media URL will fail at the browser request as usual.
  }
  return kind === 'image' ? 'png' : 'mp4'
}

function downloadFilename(name: string, url: string, kind: 'image' | 'video'): string {
  const cleaned = name.trim().replace(SAFE_FILENAME_CHARACTER, '_').slice(0, 48) ||
    (kind === 'image' ? 'image' : 'video')
  return `${cleaned}.${extensionFromUrl(url, kind)}`
}

export function MediaDownloadButton({
  kind,
  name,
  url,
}: {
  kind: 'image' | 'video'
  name: string
  url: string
}) {
  const label = `下载${kind === 'image' ? '图片' : '视频'} ${name}`
  return (
    <a
      aria-label={label}
      className="canvas-media-node__download nodrag nopan"
      download={downloadFilename(name, url, kind)}
      href={url}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      title={label}
    >
      <Download aria-hidden="true" size={16} strokeWidth={1.8} />
    </a>
  )
}
