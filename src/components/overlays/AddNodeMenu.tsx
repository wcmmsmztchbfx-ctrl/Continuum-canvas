import { clsx } from 'clsx'
import {
  AudioLines,
  ChevronRight,
  Clapperboard,
  Film,
  History,
  Image,
  Library,
  ScrollText,
  Type,
  Upload,
  Video,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { ControlledOverlayProps, OverlayPosition } from './primitives'
import { useEscapeClose } from './useEscapeClose'

export type AddNodeKind =
  | 'text'
  | 'image'
  | 'video'
  | 'video-compose'
  | 'director'
  | 'audio'
  | 'script'
  | 'asset-library'
  | 'upload'
  | 'generation-history'
  | 'group'
  | 'storyboard'
  | 'video-story'
  | 'blank-scene'
  | 'style-shot'
  | 'reference-image'

export interface AddNodeMenuProps extends ControlledOverlayProps {
  onSelect: (kind: AddNodeKind) => void
  position?: OverlayPosition
}

const createItems = [
  { kind: 'text', label: '文本', icon: Type },
  { kind: 'image', label: '图片', icon: Image },
  { kind: 'video', label: '视频', icon: Video },
  { kind: 'video-compose', label: '视频合成', badge: 'Beta', icon: Film },
  { kind: 'director', label: '导演台', badge: 'AI 导演', icon: Clapperboard },
  { kind: 'audio', label: '音频', icon: AudioLines },
  { kind: 'script', label: '脚本', icon: ScrollText, nested: true },
  { kind: 'asset-library', label: '资产库', badge: 'NEW', icon: Library },
] as const

const resourceItems = [
  { kind: 'upload', label: '上传', icon: Upload },
  { kind: 'generation-history', label: '从生成历史选择', icon: History },
] as const

export function AddNodeMenu({
  onClose,
  onSelect,
  open,
  position,
}: AddNodeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [resolvedPosition, setResolvedPosition] = useState(position)
  useEscapeClose(open, onClose)

  useLayoutEffect(() => {
    if (!open || !position || !menuRef.current) return
    const bounds = menuRef.current.getBoundingClientRect()
    setResolvedPosition({
      x: Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8)),
    })
  }, [open, position])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null
  const style: CSSProperties | undefined = resolvedPosition
    ? { left: resolvedPosition.x, top: resolvedPosition.y }
    : undefined

  const renderItem = ({
    kind,
    label,
    icon: Icon,
    ...meta
  }: (typeof createItems)[number] | (typeof resourceItems)[number]) => {
    const badge = 'badge' in meta ? meta.badge : undefined
    const nested = 'nested' in meta && meta.nested
    return (
      <button
        aria-label={label}
        className="add-node-menu__item"
        key={kind}
        onClick={() => {
          onSelect(kind)
          onClose()
        }}
        role="menuitem"
        type="button"
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {badge ? <em>{badge}</em> : null}
        {nested ? <ChevronRight aria-hidden="true" className="add-node-menu__arrow" /> : null}
      </button>
    )
  }

  return (
    <div
      aria-label="添加节点"
      className={clsx('overlay-surface', 'overlay-menu', 'add-node-menu')}
      onKeyDown={(event) => {
        if (!menuRef.current || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
        const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        items[(index + direction + items.length) % items.length]?.focus()
        event.preventDefault()
      }}
      ref={menuRef}
      role="menu"
      style={style}
    >
      <div className="add-node-menu__section">创建节点</div>
      {createItems.map(renderItem)}
      <div className="add-node-menu__section add-node-menu__section--resources">资源</div>
      {resourceItems.map(renderItem)}
    </div>
  )
}
