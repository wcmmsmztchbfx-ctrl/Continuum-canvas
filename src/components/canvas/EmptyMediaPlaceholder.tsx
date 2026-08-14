import { ImageOff, VideoOff } from 'lucide-react'

export interface EmptyMediaPlaceholderProps {
  kind: 'image' | 'video'
}

export function EmptyMediaPlaceholder({ kind }: EmptyMediaPlaceholderProps) {
  const label = kind === 'image' ? '暂无图片' : '暂无视频'
  const Icon = kind === 'image' ? ImageOff : VideoOff

  return (
    <div
      className="canvas-media-placeholder"
      data-testid={`empty-${kind}-placeholder`}
      role="img"
      aria-label={label}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
