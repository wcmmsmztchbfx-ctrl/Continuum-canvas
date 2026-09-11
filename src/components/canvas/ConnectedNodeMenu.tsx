import {
  AudioLines,
  Clapperboard,
  Film,
  Image,
  Link2,
  ScrollText,
  Type,
  Video,
} from 'lucide-react'

export type ConnectedNodeKind =
  | 'text'
  | 'image'
  | 'video'
  | 'director'
  | 'audio'
  | 'script'

interface ConnectedNodeMenuProps {
  position: { x: number; y: number }
  onSelect: (kind: ConnectedNodeKind) => void
}

interface ConnectedNodeMenuItem {
  id: string
  kind?: ConnectedNodeKind
  label: string
  badge?: string
  icon: typeof Type
  disabled?: boolean
}

const items: ReadonlyArray<ConnectedNodeMenuItem> = [
  { id: 'text', kind: 'text', label: '文本', icon: Type },
  { id: 'image', kind: 'image', label: '图片', icon: Image },
  { id: 'video', kind: 'video', label: '视频', icon: Video },
  { id: 'video-compose', label: '视频合成', badge: 'Beta', icon: Film, disabled: true },
  { id: 'director', kind: 'director', label: '导演台', badge: 'AI 导演', icon: Clapperboard },
  { id: 'audio', kind: 'audio', label: '音频', icon: AudioLines },
  { id: 'script', kind: 'script', label: '脚本', icon: ScrollText },
  { id: 'reference', label: '引用节点', icon: Link2, disabled: true },
]

export function ConnectedNodeMenu({
  position,
  onSelect,
}: ConnectedNodeMenuProps) {
  return (
    <div
      aria-label="引用该节点生成"
      className="canvas-connection-menu nodrag nowheel nopan"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      <div className="canvas-connection-menu__title">引用该节点生成</div>
      {items.map(({ id, kind, label, badge, icon: Icon, disabled }) => (
        <button
          aria-disabled={disabled || undefined}
          disabled={disabled}
          key={id}
          onClick={() => {
            if (!disabled && kind) onSelect(kind)
          }}
          role="menuitem"
          type="button"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.7} />
          <span>{label}</span>
          {badge ? <em>{badge}</em> : null}
        </button>
      ))}
    </div>
  )
}
