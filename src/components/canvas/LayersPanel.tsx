import { useMemo, useState, type ComponentType, type DragEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Circle, Eye, EyeOff, Frame, Image, Layers3, Lock, MousePointerSquareDashed, PenTool, Search, Type, Unlock, Video } from 'lucide-react'
import type { CanvasNode } from '../../model/project'

export interface LayersPanelProps {
  nodes: CanvasNode[]; selectedIds: string[]; open: boolean
  onOpenChange(open: boolean): void
  onSelect(id: string): void; onRename(id: string, name: string): void
  onToggleHidden(id: string): void; onToggleLocked(id: string): void
  onReorder(ids: string[], targetId: string, placement: 'before' | 'after' | 'inside'): void
  header?: ReactNode
}

const icons: Record<CanvasNode['type'], ComponentType<{ size?: number }>> = {
  frame: Frame, shape: Circle, path: PenTool, text: Type, image: Image, video: Video, group: MousePointerSquareDashed,
}

export function LayersPanel(props: LayersPanelProps) {
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' | 'inside' }>()
  const children = useMemo(() => {
    const result = new Map<string | undefined, CanvasNode[]>()
    for (const node of props.nodes) result.set(node.parentId, [...(result.get(node.parentId) ?? []), node])
    for (const list of result.values()) list.reverse()
    return result
  }, [props.nodes])
  const visible = useMemo(() => {
    const result: Array<{ node: CanvasNode; depth: number }> = []
    const normalized = query.trim().toLocaleLowerCase()
    const walk = (parentId: string | undefined, depth: number) => {
      for (const node of children.get(parentId) ?? []) {
        if (!normalized || node.name.toLocaleLowerCase().includes(normalized)) result.push({ node, depth: normalized ? 0 : depth })
        if ((normalized || !collapsed.has(node.id)) && (node.type === 'group' || node.type === 'frame')) walk(node.id, depth + 1)
      }
    }
    walk(undefined, 0)
    return result
  }, [children, collapsed, query])
  if (!props.open) return <button aria-label="展开图层" className="layers-panel-toggle" onClick={() => props.onOpenChange(true)} type="button"><Layers3 /><ChevronRight /></button>
  const finishRename = (id: string) => { if (draft.trim()) props.onRename(id, draft.trim()); setEditingId(undefined) }
  const placementAt = (event: DragEvent, node: CanvasNode) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    if ((node.type === 'frame' || node.type === 'group') && ratio > .25 && ratio < .75) return 'inside' as const
    return ratio < .5 ? 'before' as const : 'after' as const
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
  return <aside aria-label="图层" className="layers-panel">
    <div className="layers-panel__workspace">{props.header}<button aria-label="收起图层" onClick={(event) => { event.currentTarget.blur(); props.onOpenChange(false) }} type="button"><ChevronLeft /></button></div>
    <header><strong><Layers3 />图层</strong><button aria-label="收起图层" className="layers-panel__collapse" onClick={(event) => { event.currentTarget.blur(); props.onOpenChange(false) }} type="button"><ChevronLeft /></button></header>
    <label className="layers-panel__search"><Search /><input aria-label="搜索图层" onChange={(event) => setQuery(event.target.value)} placeholder="搜索图层" type="search" value={query} /></label>
    <div className="layers-panel__list">{visible.map(({ node, depth }) => {
      const expandable = node.type === 'group' || node.type === 'frame'
      const Icon = icons[node.type]
      const mediaUrl = node.type === 'image' ? node.data.url : node.type === 'video' ? node.data.poster : undefined
      return <div className="layers-panel__row" data-drop={dropTarget?.id === node.id ? dropTarget.placement : undefined} data-selected={props.selectedIds.includes(node.id) || undefined} draggable onDragEnd={() => setDropTarget(undefined)} onDragOver={(event) => { event.preventDefault(); setDropTarget({ id: node.id, placement: placementAt(event, node) }) }} onDragStart={(event) => { const ids = props.selectedIds.includes(node.id) ? props.selectedIds : [node.id]; event.dataTransfer.setData('application/x-canvas-nodes', JSON.stringify(ids)); event.dataTransfer.effectAllowed = 'move' }} onDrop={(event) => commitDrop(event, node)} key={node.id} style={{ paddingLeft: 8 + depth * 16 }}>
        <button aria-label={expandable ? `${collapsed.has(node.id) ? '展开' : '收起'} ${node.name}` : undefined} className="layers-panel__disclosure" disabled={!expandable} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })} type="button">{expandable ? collapsed.has(node.id) ? <ChevronRight /> : <ChevronDown /> : null}</button>
        <span className="layers-panel__icon">{mediaUrl ? <img alt="" src={mediaUrl} /> : <Icon size={14} />}</span>
        {editingId === node.id ? <input aria-label={`重命名 ${node.name}`} autoFocus className="layers-panel__rename" onBlur={() => finishRename(node.id)} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') finishRename(node.id); if (event.key === 'Escape') setEditingId(undefined) }} value={draft} /> : <button className="layers-panel__name" onClick={() => props.onSelect(node.id)} onDoubleClick={() => { setEditingId(node.id); setDraft(node.name) }} title="双击重命名" type="button">{node.name}</button>}
        <span className="layers-panel__actions"><button aria-label={node.hidden ? '显示' : '隐藏'} data-active={node.hidden || undefined} onClick={() => props.onToggleHidden(node.id)} type="button">{node.hidden ? <EyeOff /> : <Eye />}</button><button aria-label={node.locked ? '解锁' : '锁定'} data-active={node.locked || undefined} onClick={() => props.onToggleLocked(node.id)} type="button">{node.locked ? <Lock /> : <Unlock />}</button></span>
      </div>
    })}</div>
  </aside>
}
