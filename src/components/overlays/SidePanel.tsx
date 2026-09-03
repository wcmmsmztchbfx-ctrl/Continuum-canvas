import { clsx } from 'clsx'
import {
  Bot,
  Clock3,
  FileText,
  FolderOpen,
  Image,
  LayoutGrid,
  LocateFixed,
  MoreHorizontal,
  Music2,
  Package,
  Search,
  SlidersHorizontal,
  Video,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { ControlledOverlayProps } from './primitives'
import { useEscapeClose } from './useEscapeClose'

export type SidePanelKind =
  | 'project-files'
  | 'canvases'
  | 'assets'
  | 'history'
  | 'agent'

export type SidePanelAction =
  | 'upload'
  | 'new-canvas'
  | 'new-chat'

interface PanelMeta {
  icon: LucideIcon
  title: string
}

const panelMeta: Record<SidePanelKind, PanelMeta> = {
  'project-files': { icon: FolderOpen, title: '项目文件' },
  canvases: { icon: LayoutGrid, title: '画布列表' },
  assets: { icon: Package, title: '资产' },
  history: { icon: Clock3, title: '历史记录' },
  agent: { icon: Bot, title: 'Agent' },
}

export interface SidePanelCanvasNode {
  id: string
  name: string
  type: string
}

export interface SidePanelProps extends ControlledOverlayProps {
  agentWidth?: 340 | 400
  canvasNodes?: ReadonlyArray<SidePanelCanvasNode>
  children?: ReactNode
  kind: SidePanelKind
  onAction?: (action: SidePanelAction) => void
  onLocateNode?: (nodeId: string) => void
}

const typeIcons: Record<string, LucideIcon> = {
  image: Image,
  video: Video,
  text: FileText,
  audio: Music2,
}

function AssetManager({
  canvasNodes,
  onLocateNode,
}: {
  canvasNodes: ReadonlyArray<SidePanelCanvasNode>
  onLocateNode?: (nodeId: string) => void
}) {
  const [tab, setTab] = useState<'canvas' | 'assets'>('canvas')
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const filtered = useMemo(
    () =>
      canvasNodes.filter(
        (node) =>
          (type === 'all' || node.type === type) &&
          node.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [canvasNodes, query, type],
  )

  return (
    <div className="asset-manager">
      <div aria-label="资产范围" className="asset-manager__tabs" role="tablist">
        <button aria-selected={tab === 'canvas'} onClick={() => setTab('canvas')} role="tab" type="button">画布</button>
        <button aria-selected={tab === 'assets'} onClick={() => setTab('assets')} role="tab" type="button">资产</button>
      </div>
      <div className="asset-manager__filters">
        <label>
          <SlidersHorizontal aria-hidden="true" />
          <select aria-label="节点类型" onChange={(event) => setType(event.target.value)} value={type}>
            <option value="all">全部类型</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
            <option value="text">文本</option>
          </select>
        </label>
        <label>
          <Search aria-hidden="true" />
          <input aria-label="搜索节点" onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点" type="search" value={query} />
        </label>
      </div>
      <div className="asset-manager__summary">{tab === 'canvas' ? `${filtered.length} 个节点` : '本地资产'}</div>
      <div className="asset-manager__list">
        {tab === 'assets' ? <p className="panel-empty-copy">暂无本地资产</p> : null}
        {tab === 'canvas'
          ? filtered.map((node) => {
              const Icon = typeIcons[node.type] ?? FileText
              return (
                <div className="asset-manager__row" key={node.id}>
                  <Icon aria-hidden="true" />
                  <span>{node.name}</span>
                  <button aria-label={`定位${node.name}`} onClick={() => onLocateNode?.(node.id)} title="定位" type="button"><LocateFixed aria-hidden="true" /></button>
                  <button aria-label={`${node.name}更多操作`} title="更多" type="button"><MoreHorizontal aria-hidden="true" /></button>
                </div>
              )
            })
          : null}
      </div>
    </div>
  )
}

function LibraryRows({
  actionLabel,
  descriptions,
  onAction,
}: {
  actionLabel: string
  descriptions: ReadonlyArray<{ name: string; detail: string }>
  onAction?: () => void
}) {
  return (
    <div className="panel-library-list">
      {descriptions.map((item) => (
        <div className="panel-library-row" key={item.name}>
          <div><strong>{item.name}</strong><span>{item.detail}</span></div>
          <button aria-label={actionLabel} onClick={onAction} type="button">{actionLabel}</button>
        </div>
      ))}
    </div>
  )
}

function PanelContent({
  canvasNodes,
  kind,
  onAction,
  onLocateNode,
}: Pick<SidePanelProps, 'canvasNodes' | 'kind' | 'onAction' | 'onLocateNode'>) {
  if (kind === 'project-files') {
    return <AssetManager canvasNodes={canvasNodes ?? []} onLocateNode={onLocateNode} />
  }
  if (kind === 'assets') {
    return (
      <div className="panel-library-list">
        <p className="panel-empty-copy">请使用左侧资产库图标或快捷键浏览管理全局与项目素材</p>
      </div>
    )
  }
  if (kind === 'history') {
    return (
      <div className="history-library">
        <div className="history-library__tabs"><button aria-pressed="true" type="button">图片</button><button type="button">视频</button><button type="button">音频</button></div>
        <div className="history-library__tools"><button type="button">最新生成</button><button type="button">批量选择</button><button aria-label="缩小历史缩略图" type="button">-</button><button aria-label="放大历史缩略图" type="button">+</button></div>
        <p className="panel-empty-copy">暂无本地生成记录</p>
      </div>
    )
  }
  if (kind === 'canvases') {
    return <LibraryRows actionLabel="打开" descriptions={[{ name: '画布 1', detail: '当前画布' }]} onAction={() => onAction?.('new-canvas')} />
  }
  return (
    <div className="agent-local-panel">
      <Bot aria-hidden="true" />
      <p>本地 Agent 对话尚未开始</p>
      <button onClick={() => onAction?.('new-chat')} type="button">开始新对话</button>
    </div>
  )
}

export function SidePanel({
  agentWidth = 400,
  canvasNodes,
  children,
  kind,
  onAction,
  onClose,
  onLocateNode,
  open,
}: SidePanelProps) {
  useEscapeClose(open, onClose)
  if (!open) return null

  const meta = panelMeta[kind]
  const Icon = meta.icon
  return (
    <aside
      aria-label={meta.title}
      className={clsx('overlay-surface', 'overlay-side-panel', kind === 'agent' && 'overlay-side-panel--agent', kind === 'agent' && agentWidth === 340 && 'overlay-side-panel--agent-compact')}
    >
      <header className="overlay-side-panel__header">
        <div className="overlay-side-panel__title"><Icon aria-hidden="true" focusable="false" /><h2>{meta.title}</h2></div>
        <button aria-label={`关闭${meta.title}`} className="overlay-icon-button" onClick={onClose} title={`关闭${meta.title}`} type="button"><X aria-hidden="true" focusable="false" /></button>
      </header>
      <div className="overlay-side-panel__body">
        {children ?? <PanelContent canvasNodes={canvasNodes} kind={kind} onAction={onAction} onLocateNode={onLocateNode} />}
      </div>
    </aside>
  )
}
