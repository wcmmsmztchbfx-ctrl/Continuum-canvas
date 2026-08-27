import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Crosshair,
  FileText,
  Frame,
  GitBranch,
  Image as ImageIcon,
  MousePointerSquareDashed,
  PenTool,
  Search,
  Sliders,
  Type,
  Video,
} from 'lucide-react'

import type { CanvasEdge, CanvasNode } from '../../model/project'
import {
  buildCanvasLineage,
  extractNodePrompt,
  type LineageTreeNode,
} from '../../services/lineageGraph'
import { getFastThumbnailUrl } from '../../services/imageThumbnailCache'

export interface LineageSidebarPanelProps {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  selectedIds: string[]
  onSelect(id: string): void
  onFocusNode?(id: string): void
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
}

const typeIcons: Record<CanvasNode['type'], ComponentType<{ size?: number }>> = {
  frame: Frame,
  shape: Circle,
  path: PenTool,
  text: Type,
  image: ImageIcon,
  video: Video,
  group: MousePointerSquareDashed,
}

interface ContextMenuState {
  x: number
  y: number
  node: CanvasNode
}

function LineageNodeThumb({ node }: { node: CanvasNode }) {
  const IconComponent = typeIcons[node.type] ?? FileText

  if (node.type === 'image' && node.data.url) {
    const thumbUrl = getFastThumbnailUrl(node.data.url) || node.data.url
    return (
      <span className="sidebar-lineage-node__thumb">
        <img alt={node.name} draggable={false} loading="lazy" src={thumbUrl} />
      </span>
    )
  }

  if (node.type === 'video' && (node.data.poster || node.data.url)) {
    const poster = node.data.poster || getFastThumbnailUrl(node.data.url)
    if (poster) {
      return (
        <span className="sidebar-lineage-node__thumb">
          <img alt={node.name} draggable={false} loading="lazy" src={poster} />
          <span className="sidebar-lineage-node__thumb-play">▶</span>
        </span>
      )
    }
  }

  return (
    <span className={`sidebar-lineage-node__thumb sidebar-lineage-node__thumb--${node.type}`}>
      <IconComponent size={13} />
    </span>
  )
}

function LineageBranchItem({
  item,
  selectedIds,
  collapsed,
  onToggleCollapse,
  onSelectNode,
  onContextMenu,
  depth = 0,
}: {
  item: LineageTreeNode
  selectedIds: string[]
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  onSelectNode: (id: string) => void
  onContextMenu: (event: React.MouseEvent, node: CanvasNode) => void
  depth?: number
}) {
  const isSelected = selectedIds.includes(item.id)
  const isCollapsed = collapsed.has(item.id)
  const hasChildren = item.children.length > 0
  const prompt = item.prompt

  return (
    <div className="sidebar-lineage-tree__branch">
      <div
        aria-selected={isSelected}
        className={`sidebar-lineage-node ${isSelected ? 'sidebar-lineage-node--selected' : ''}`}
        data-depth={depth}
        data-selected={isSelected || undefined}
        onClick={() => onSelectNode(item.id)}
        onContextMenu={(e) => onContextMenu(e, item.node)}
        role="treeitem"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button
          aria-label={isCollapsed ? '展开分支' : '折叠分支'}
          className="sidebar-lineage-node__disclosure"
          disabled={!hasChildren}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCollapse(item.id)
          }}
          type="button"
        >
          {hasChildren ? (
            isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />
          ) : (
            <span className="sidebar-lineage-node__leaf-dot" />
          )}
        </button>

        <LineageNodeThumb node={item.node} />

        <div className="sidebar-lineage-node__content">
          <div className="sidebar-lineage-node__title-row">
            <span className="sidebar-lineage-node__name" title={item.node.name}>
              {item.node.name || '未命名节点'}
            </span>
          </div>
          {prompt ? (
            <span className="sidebar-lineage-node__prompt-snippet" title={prompt}>
              {prompt}
            </span>
          ) : null}
        </div>
      </div>

      {hasChildren && !isCollapsed ? (
        <div className="sidebar-lineage-tree__children">
          {item.children.map((child) => (
            <LineageBranchItem
              collapsed={collapsed}
              depth={depth + 1}
              item={child}
              key={child.id}
              onContextMenu={onContextMenu}
              onSelectNode={onSelectNode}
              onToggleCollapse={onToggleCollapse}
              selectedIds={selectedIds}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function LineageSidebarPanel({
  nodes,
  edges,
  selectedIds,
  onSelect,
  onFocusNode,
  onNotify,
}: LineageSidebarPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const lineageGraph = useMemo(() => {
    return buildCanvasLineage(nodes, edges)
  }, [nodes, edges])

  // Only display trees that have actual branches (exclude isolated standalone nodes)
  const connectedTrees = useMemo(() => {
    return lineageGraph.trees.filter((tree) => tree.children.length > 0)
  }, [lineageGraph.trees])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSelectNode = useCallback(
    (id: string) => {
      onSelect(id)
      onFocusNode?.(id)
    },
    [onSelect, onFocusNode],
  )

  const handleContextMenu = useCallback((event: React.MouseEvent, node: CanvasNode) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      node,
    })
  }, [])

  const copyPrompt = useCallback(
    (node: CanvasNode) => {
      const prompt = extractNodePrompt(node) || ''
      if (!prompt) {
        onNotify?.('该节点未包含提示词', 'info')
        return
      }
      void navigator.clipboard.writeText(prompt).then(
        () => onNotify?.('提示词已复制到剪贴板', 'success'),
        () => onNotify?.('复制失败，请检查浏览器权限', 'error'),
      )
    },
    [onNotify],
  )

  const copySettings = useCallback(
    (node: CanvasNode) => {
      let settings: unknown = null
      if (node.type === 'image' || node.type === 'video') {
        settings = node.data.generationSettings || node.data.generation?.actualSettings
      }
      if (!settings) {
        onNotify?.('该节点无生成参数', 'info')
        return
      }
      const json = JSON.stringify(settings, null, 2)
      void navigator.clipboard.writeText(json).then(
        () => onNotify?.('生成参数已复制到剪贴板', 'success'),
        () => onNotify?.('复制失败，请检查浏览器权限', 'error'),
      )
    },
    [onNotify],
  )

  const filteredTrees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const trees = connectedTrees

    if (!query) return trees

    const filterTree = (item: LineageTreeNode): LineageTreeNode | null => {
      const matchesName = item.node.name?.toLowerCase().includes(query)
      const matchesPrompt = item.prompt?.toLowerCase().includes(query)
      const filteredChildren = item.children
        .map(filterTree)
        .filter((c): c is LineageTreeNode => c !== null)

      if (matchesName || matchesPrompt || filteredChildren.length > 0) {
        return {
          ...item,
          children: filteredChildren,
        }
      }
      return null
    }

    return trees.map(filterTree).filter((t): t is LineageTreeNode => t !== null)
  }, [connectedTrees, searchQuery])

  return (
    <div
      aria-label="AI 演化血缘树"
      className="sidebar-lineage-panel"
      onClick={() => setContextMenu(null)}
    >
      <div className="sidebar-lineage-panel__top">
        <div className="sidebar-lineage-panel__title-row">
          <strong className="sidebar-lineage-panel__title">AI 演化谱系</strong>
          <span className="sidebar-lineage-panel__stats" title="当前画布中有血缘关系的生成分支">
            {connectedTrees.length} 个演化分支
          </span>
        </div>

        <label className="sidebar-lineage-panel__search">
          <Search size={14} />
          <input
            aria-label="搜索节点或提示词"
            autoComplete="off"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索节点名称或 Prompt..."
            spellCheck={false}
            value={searchQuery}
          />
        </label>
      </div>

      <div className="sidebar-lineage-panel__content" role="tree">
        {filteredTrees.length > 0 ? (
          <div className="sidebar-lineage-tree">
            {filteredTrees.map((tree) => (
              <LineageBranchItem
                collapsed={collapsed}
                depth={0}
                item={tree}
                key={tree.id}
                onContextMenu={handleContextMenu}
                onSelectNode={handleSelectNode}
                onToggleCollapse={toggleCollapse}
                selectedIds={selectedIds}
              />
            ))}
          </div>
        ) : (
          <div className="sidebar-lineage-panel__empty">
            <GitBranch size={28} strokeWidth={1.5} />
            <p>{searchQuery ? '未找到匹配的演化节点' : '当前画布暂无节点'}</p>
            <small>从 Prompt 或图片衍生出新内容时，此处将自动呈现生成血缘树。</small>
          </div>
        )}
      </div>

      {contextMenu ? (
        <div
          className="sidebar-lineage-menu"
          onClick={(e) => e.stopPropagation()}
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            className="sidebar-lineage-menu__item"
            onClick={() => {
              handleSelectNode(contextMenu.node.id)
              setContextMenu(null)
            }}
            type="button"
          >
            <Crosshair size={14} />
            <span>在画布中定位</span>
          </button>
          <button
            className="sidebar-lineage-menu__item"
            onClick={() => {
              copyPrompt(contextMenu.node)
              setContextMenu(null)
            }}
            type="button"
          >
            <Copy size={14} />
            <span>复制提示词 (Prompt)</span>
          </button>
          <button
            className="sidebar-lineage-menu__item"
            onClick={() => {
              copySettings(contextMenu.node)
              setContextMenu(null)
            }}
            type="button"
          >
            <Sliders size={14} />
            <span>复制生成参数</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
