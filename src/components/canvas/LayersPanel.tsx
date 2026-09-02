import { useMemo, useState, type ComponentType, type DragEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Circle, Eye, EyeOff, Frame, Image, Lock, MousePointerSquareDashed, PenTool, Search, Type, Unlock, Video } from 'lucide-react'
import type { CanvasNode } from '../../model/project'
import { getFastThumbnailUrl } from '../../services/imageThumbnailCache'

export interface LayersPanelProps {
  nodes: CanvasNode[]
  selectedIds: string[]
  open: boolean
  onOpenChange(open: boolean): void
  onSelect(id: string): void
  onFocusNode?(id: string): void
  onRename(id: string, name: string): void
  onToggleHidden(id: string): void
  onToggleLocked(id: string): void
  onReorder(ids: string[], targetId: string, placement: 'before' | 'after' | 'inside'): void
  header?: ReactNode
}

const icons: Record<CanvasNode['type'], ComponentType<{ size?: number }>> = {
  frame: Frame,
  shape: Circle,
  path: PenTool,
  text: Type,
  image: Image,
  video: Video,
  group: MousePointerSquareDashed,
}

function getPathSvg(node: CanvasNode): string {
  if (node.type !== 'path') return ''
  const data = node.data
  const [first, ...rest] = data.anchors ?? []
  if (!first) return ''
  if (data.kind === 'brush' && rest.length > 1) {
    let result = `M ${first.x} ${first.y}`
    for (let index = 0; index < rest.length - 1; index += 1) {
      const point = rest[index]!
      const next = rest[index + 1]!
      result += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`
    }
    const last = rest.at(-1)!
    return `${result} L ${last.x} ${last.y}`
  }
  let result = `M ${first.x} ${first.y}`
  let previous = first
  for (const anchor of rest) {
    if (previous.out || anchor.in) {
      const out = previous.out ?? { x: previous.x, y: previous.y }
      const incoming = anchor.in ?? { x: anchor.x, y: anchor.y }
      result += ` C ${out.x} ${out.y} ${incoming.x} ${incoming.y} ${anchor.x} ${anchor.y}`
    } else result += ` L ${anchor.x} ${anchor.y}`
    previous = anchor
  }
  return data.closed ? `${result} Z` : result
}

export function LayersPanel(props: LayersPanelProps) {
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' | 'inside' }>()

  const children = useMemo(() => {
    const result = new Map<string | undefined, CanvasNode[]>()
    for (const node of props.nodes) {
      result.set(node.parentId, [...(result.get(node.parentId) ?? []), node])
    }
    for (const list of result.values()) list.reverse()
    return result
  }, [props.nodes])

  const visible = useMemo(() => {
    const result: Array<{ node: CanvasNode; depth: number }> = []
    const normalized = query.trim().toLocaleLowerCase()
    const walk = (parentId: string | undefined, depth: number) => {
      for (const node of children.get(parentId) ?? []) {
        if (!normalized || node.name.toLocaleLowerCase().includes(normalized)) {
          result.push({ node, depth: normalized ? 0 : depth })
        }
        if ((normalized || !collapsed.has(node.id)) && (node.type === 'group' || node.type === 'frame')) {
          walk(node.id, depth + 1)
        }
      }
    }
    walk(undefined, 0)
    return result
  }, [children, collapsed, query])

  if (!props.open) {
    return null
  }

  const finishRename = (id: string) => {
    if (draft.trim()) props.onRename(id, draft.trim())
    setEditingId(undefined)
  }

  const placementAt = (event: DragEvent, node: CanvasNode) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    if ((node.type === 'frame' || node.type === 'group') && ratio > 0.25 && ratio < 0.75) return 'inside' as const
    return ratio < 0.5 ? ('before' as const) : ('after' as const)
  }

  const commitDrop = (event: DragEvent, node: CanvasNode) => {
    event.preventDefault()
    let ids: string[] = []
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-canvas-nodes') || '[]')
      if (Array.isArray(value)) ids = value.filter((id): id is string => typeof id === 'string')
    } catch {
      ids = []
    }
    const visualPlacement = placementAt(event, node)
    const modelPlacement = visualPlacement === 'before' ? 'after' : visualPlacement === 'after' ? 'before' : 'inside'
    if (ids.length) props.onReorder(ids, node.id, modelPlacement)
    setDropTarget(undefined)
  }
  return (
    <aside aria-label="图层" className="layers-panel">
      <header className="layers-panel__section-header">
        <strong>图层</strong>
      </header>
      <label className="layers-panel__search">
        <Search size={13} />
        <input aria-label="搜索图层" onChange={(event) => setQuery(event.target.value)} placeholder="搜索图层" type="search" value={query} />
      </label>
      <div className="layers-panel__list">
        {visible.map(({ node, depth }) => {
          const expandable = node.type === 'group' || node.type === 'frame'
          const Icon = icons[node.type]
          const mediaUrl = node.type === 'image' ? (node.data as { url?: string }).url : node.type === 'video' ? (node.data as { poster?: string; url?: string }).poster : undefined
          return (
            <div
              className="layers-panel__row"
              data-drop={dropTarget?.id === node.id ? dropTarget.placement : undefined}
              data-selected={props.selectedIds.includes(node.id) || undefined}
              draggable
              key={node.id}
              onClick={() => props.onSelect(node.id)}
              onDoubleClick={() => props.onFocusNode?.(node.id)}
              onDragEnd={() => setDropTarget(undefined)}
              onDragOver={(event) => {
                event.preventDefault()
                setDropTarget({ id: node.id, placement: placementAt(event, node) })
              }}
              onDragStart={(event) => {
                const ids = props.selectedIds.includes(node.id) ? props.selectedIds : [node.id]
                event.dataTransfer.setData('application/x-canvas-nodes', JSON.stringify(ids))
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDrop={(event) => commitDrop(event, node)}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <button
                aria-label={expandable ? `${collapsed.has(node.id) ? '展开' : '收起'} ${node.name}` : undefined}
                className="layers-panel__disclosure"
                disabled={!expandable}
                onClick={(e) => {
                  e.stopPropagation()
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(node.id)) next.delete(node.id)
                    else next.add(node.id)
                    return next
                  })
                }}
                type="button"
              >
                {expandable ? collapsed.has(node.id) ? <ChevronRight size={11} /> : <ChevronDown size={11} /> : null}
              </button>
              <span className="layers-panel__type-icon">
                <Icon size={13} />
              </span>
              {node.type === 'path' ? (
                <span className="layers-panel__thumb layers-panel__thumb--path" title="画笔笔画">
                  {getPathSvg(node) ? (
                    <svg
                      preserveAspectRatio="xMidYMid meet"
                      viewBox={`0 0 ${Math.max(1, node.size.width)} ${Math.max(1, node.size.height)}`}
                    >
                      <path
                        d={getPathSvg(node)}
                        fill={node.data.fill && node.data.fill !== 'transparent' ? node.data.fill : 'none'}
                        stroke={node.data.stroke || 'var(--canvas-text-primary)'}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={Math.max(4, (node.data.strokeWidth ?? 1) * 2)}
                      />
                    </svg>
                  ) : null}
                </span>
              ) : node.type === 'shape' ? (
                <span className="layers-panel__thumb" title="几何图形">
                  <span
                    className="layers-panel__thumb-shape-inner"
                    style={{
                      borderRadius: (node.data as { kind?: string }).kind === 'ellipse' ? '50%' : `${Math.min(4, (node.data as { radius?: number }).radius ?? 2)}px`,
                      background: (node.data as { fill?: string }).fill || 'var(--canvas-overlay-white-25)',
                      border: `${Math.max(1, Math.min(2, (node.data as { strokeWidth?: number }).strokeWidth ?? 1))}px solid ${(node.data as { stroke?: string }).stroke || 'var(--canvas-overlay-white-40)'}`,
                      opacity: (node.data as { opacity?: number }).opacity ?? 1,
                    }}
                  />
                </span>
              ) : node.type === 'frame' ? (
                <span className="layers-panel__thumb" title="画框">
                  <span
                    className="layers-panel__thumb-frame-inner"
                    style={{
                      background: (node.data as { fill?: string }).fill && (node.data as { fill?: string }).fill !== 'transparent' ? (node.data as { fill?: string }).fill : 'var(--canvas-overlay-white-06)',
                      borderColor: (node.data as { stroke?: string }).stroke && (node.data as { stroke?: string }).stroke !== 'transparent' ? (node.data as { stroke?: string }).stroke : 'var(--canvas-overlay-white-30)',
                    }}
                  >
                    #
                  </span>
                </span>
              ) : node.type === 'text' ? (
                <span className="layers-panel__thumb layers-panel__thumb--text" title="文本">
                  <span className="layers-panel__thumb-text-inner">T</span>
                </span>
              ) : (node.type === 'image' || node.type === 'video') ? (
                <span className="layers-panel__thumb" title={node.type === 'video' ? '视频' : '图片'}>
                  {mediaUrl ? (
                    <span className="layers-panel__thumb-media">
                      <img
                        alt=""
                        decoding="async"
                        loading="lazy"
                        src={getFastThumbnailUrl(mediaUrl) || mediaUrl}
                      />
                      {node.type === 'video' ? <span className="layers-panel__thumb-play">▶</span> : null}
                    </span>
                  ) : (
                    <span className="layers-panel__thumb-placeholder">{node.type === 'video' ? '▶' : '🖼'}</span>
                  )}
                </span>
              ) : (
                <span className="layers-panel__thumb layers-panel__thumb--group" title="组">
                  <span className="layers-panel__thumb-group-inner">⚏</span>
                </span>
              )}
              {editingId === node.id ? (
                <input
                  aria-label={`重命名 ${node.name}`}
                  autoFocus
                  className="layers-panel__rename"
                  onBlur={() => finishRename(node.id)}
                  onChange={(event) => setDraft(event.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') finishRename(node.id)
                    if (event.key === 'Escape') setEditingId(undefined)
                  }}
                  value={draft}
                />
              ) : (
                <button
                  className="layers-panel__name"
                  onClick={() => props.onSelect(node.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingId(node.id)
                    setDraft(node.name)
                  }}
                  title="单击选中，双击重命名"
                  type="button"
                >
                  {node.name}
                </button>
              )}
              <span className="layers-panel__actions">
                <button
                  aria-label={node.hidden ? '显示' : '隐藏'}
                  data-active={node.hidden || undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onToggleHidden(node.id)
                  }}
                  type="button"
                >
                  {node.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  aria-label={node.locked ? '解锁' : '锁定'}
                  data-active={node.locked || undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onToggleLocked(node.id)
                  }}
                  type="button"
                >
                  {node.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
