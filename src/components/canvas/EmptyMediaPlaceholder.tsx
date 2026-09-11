import { Clapperboard, ImageOff, VideoOff } from 'lucide-react'

export interface EmptyMediaPlaceholderProps {
  kind: 'image' | 'video' | 'director'
}

export function EmptyMediaPlaceholder({ kind }: EmptyMediaPlaceholderProps) {
  const label =
    kind === 'image' ? '暂无图片' : kind === 'director' ? '暂无成片' : '暂无视频'
  const Icon =
    kind === 'image'
      ? ImageOff
      : kind === 'director'
        ? Clapperboard
        : VideoOff

  return (
    <div
      className="canvas-media-placeholder"
      data-testid={`empty-${kind}-placeholder`}
      role="img"
      aria-label={label}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
      {kind === 'director' ? (
        <small
          style={{
            fontSize: '13px',
            color: 'rgba(255, 255, 255, 0.45)',
            marginTop: '-4px',
            letterSpacing: '0.2px',
          }}
        >
          选择导演智能体并下达分镜指令执导
        </small>
      ) : null}
    </div>
  )
}
