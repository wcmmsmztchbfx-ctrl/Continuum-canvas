import {
  Cable,
  Clock3,
  Copy,
  LayoutDashboard,
  PanelTop,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { NodeSize, Point, Viewport } from '../../model/project'
import type {
  WorkspaceCanvas,
  WorkspaceManifestV1,
  WorkspaceProject,
} from '../../workspace/model'
import { useActiveCollaboration } from '../../collaboration/activeCollaborationStore'
import './workspace-home.css'

type WorkspaceFilter = 'all' | 'recent' | 'favorites' | 'trash'
type WorkspaceSort = 'updated' | 'name' | 'created'

export interface WorkspaceCanvasMove {
  position: Point
  projectId: string
}

export interface WorkspaceHomeViewProps {
  editingItem?: { kind: 'project' | 'canvas'; id: string }
  manifest: WorkspaceManifestV1
  onApiIntegration?: () => void
  onCreateCanvas?: (position: Point) => void
  onCreateProject?: (position: Point) => void
  onCancelRename?: () => void
  onCommitRename?: (name: string) => void
  onMoveCanvas?: (canvas: WorkspaceCanvas, move: WorkspaceCanvasMove) => void
  onMoveProject?: (project: WorkspaceProject, position: Point) => void
  onOpenCanvas?: (canvas: WorkspaceCanvas) => void
  onResizeProject?: (project: WorkspaceProject, size: NodeSize) => void
  onRestoreCanvas?: (canvas: WorkspaceCanvas) => void
  onRestoreProject?: (project: WorkspaceProject) => void
  onDeleteCanvas?: (canvas: WorkspaceCanvas) => void
  onDeleteProject?: (project: WorkspaceProject) => void
  onDuplicateCanvas?: (canvas: WorkspaceCanvas) => void
  onDuplicateProject?: (project: WorkspaceProject) => void
  onRenameCanvas?: (canvas: WorkspaceCanvas) => void
  onRenameProject?: (project: WorkspaceProject) => void
  onTrashCanvas?: (canvas: WorkspaceCanvas) => void
  onTrashProject?: (project: WorkspaceProject) => void
  onToggleCanvasFavorite?: (canvas: WorkspaceCanvas) => void
  onToggleProjectFavorite?: (project: WorkspaceProject) => void
  onViewportChange?: (viewport: Viewport) => void
  thumbnailUrls?: Readonly<Record<string, string>>
}

const FILTERS: ReadonlyArray<{
  id: WorkspaceFilter
  label: string
  icon: typeof LayoutDashboard
}> = [
  { id: 'all', label: '全部', icon: LayoutDashboard },
  { id: 'recent', label: '最近', icon: Clock3 },
  { id: 'favorites', label: '收藏', icon: Star },
  { id: 'trash', label: '回收站', icon: Trash2 },
]

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '刚刚更新'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function InlineWorkspaceName({
  name,
  onCancel,
  onCommit,
}: {
  name: string
  onCancel?: () => void
  onCommit?: (name: string) => void
}) {
  const [value, setValue] = useState(name)
  const commit = () => onCommit?.(value.trim() || name)
  return (
    <input
      aria-label="名称"
      autoFocus
      className="workspace-inline-name"
      maxLength={60}
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel?.()
        }
      }}
      value={value}
    />
  )
}

function compareCanvases(
  left: WorkspaceCanvas,
  right: WorkspaceCanvas,
  sort: WorkspaceSort,
): number {
  if (sort === 'name') {
    return left.name.localeCompare(right.name, 'zh-CN')
  }
  const key = sort === 'created' ? 'createdAt' : 'updatedAt'
  const difference = Date.parse(right[key]) - Date.parse(left[key])
  return Number.isNaN(difference) || difference === 0
    ? left.canvasId.localeCompare(right.canvasId)
    : difference
}

function CanvasCard({
  canvas,
  editing,
  trashMode,
  props,
}: {
  canvas: WorkspaceCanvas
  editing: boolean
  trashMode: boolean
  props: WorkspaceHomeViewProps
}) {
  const activeCollab = useActiveCollaboration()
  const isCollaborating = Boolean(
    activeCollab &&
    activeCollab.status === 'active' &&
    activeCollab.canvasId === canvas.canvasId &&
    activeCollab.projectId === canvas.projectId,
  )

  const cardContent = (
    <>
      <span className="workspace-canvas-card__preview">
        {props.thumbnailUrls?.[canvas.canvasId] ? (
          <img
            alt={`${canvas.name}预览`}
            decoding="async"
            loading="lazy"
            src={props.thumbnailUrls[canvas.canvasId]}
          />
        ) : (
          <PanelTop aria-hidden="true" />
        )}
        {isCollaborating ? (
          <span className="workspace-canvas-card__collab-tag" title="当前正在协作中">
            <span className="floating-collab-pulse" />
            协作中
          </span>
        ) : null}
      </span>
      <span className="workspace-canvas-card__details">
        {editing ? (
          <InlineWorkspaceName
            name={canvas.name}
            onCancel={props.onCancelRename}
            onCommit={props.onCommitRename}
          />
        ) : (
          <strong>{canvas.name}</strong>
        )}
        <span>{canvas.nodeCount} 个节点</span>
        <time dateTime={canvas.updatedAt}>{formatUpdatedAt(canvas.updatedAt)} 更新</time>
      </span>
    </>
  )
  return (
    <article className="workspace-canvas-card" id={`workspace-canvas-${canvas.canvasId}`}>
      {editing ? (
        <div className="workspace-canvas-card__open">{cardContent}</div>
      ) : (
        <button
          aria-label={`${canvas.name}，${canvas.nodeCount} 个节点`}
          className="workspace-canvas-card__open"
          onClick={() => props.onOpenCanvas?.(canvas)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            props.onOpenCanvas?.(canvas)
          }}
          type="button"
        >
          {cardContent}
        </button>
      )}
      <div className="workspace-canvas-card__actions">
        {trashMode ? (
          <>
            <button aria-label={`恢复 ${canvas.name}`} onClick={() => props.onRestoreCanvas?.(canvas)} type="button">
              <RotateCcw aria-hidden="true" />
            </button>
            <button aria-label={`永久删除 ${canvas.name}`} onClick={() => props.onDeleteCanvas?.(canvas)} type="button">
              <Trash2 aria-hidden="true" />
            </button>
          </>
        ) : (
          <>
            <button aria-label={`重命名 ${canvas.name}`} onClick={() => props.onRenameCanvas?.(canvas)} type="button">
              <Pencil aria-hidden="true" />
            </button>
            <button aria-label={`复制 ${canvas.name}`} onClick={() => props.onDuplicateCanvas?.(canvas)} type="button">
              <Copy aria-hidden="true" />
            </button>
            <button
              aria-label={canvas.favorite ? `取消收藏 ${canvas.name}` : `收藏 ${canvas.name}`}
              aria-pressed={canvas.favorite}
              onClick={() => props.onToggleCanvasFavorite?.(canvas)}
              type="button"
            >
              <Star aria-hidden="true" fill={canvas.favorite ? 'currentColor' : 'none'} />
            </button>
            <button aria-label={`移入回收站 ${canvas.name}`} onClick={() => props.onTrashCanvas?.(canvas)} type="button">
              <Trash2 aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </article>
  )
}

export function WorkspaceHomeView(props: WorkspaceHomeViewProps) {
  const { manifest } = props
  const [filter, setFilter] = useState<WorkspaceFilter>('all')
  const [sort, setSort] = useState<WorkspaceSort>('updated')
  const [query, setQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')

  const canvasResults = normalizedQuery
    ? manifest.canvases.filter(
        (canvas) =>
          !canvas.deletedAt &&
          canvas.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery),
      )
    : []

  const visibleCanvases = useMemo(
    () =>
      manifest.canvases
        .filter((canvas) => {
          if (filter === 'trash') return Boolean(canvas.deletedAt)
          if (canvas.deletedAt) return false
          if (filter === 'favorites') return canvas.favorite
          return true
        })
        .sort((left, right) => compareCanvases(left, right, sort)),
    [filter, manifest.canvases, sort],
  )

  useEffect(() => {
    if (!searchTarget) return
    const target = document.getElementById(`workspace-canvas-${searchTarget}`)
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    setSearchTarget(null)
  }, [searchTarget, visibleCanvases])

  return (
    <main className="workspace-home" data-testid="workspace-home">
      <aside className="workspace-home__rail" aria-label="工作区导航">
        <div className="workspace-home__brand">
          <span aria-hidden="true"><PanelTop /></span>
          <strong>工作区</strong>
        </div>
        <nav>
          {FILTERS.map(({ id, label, icon: Icon }) => (
            <button
              aria-current={filter === id ? 'page' : undefined}
              key={id}
              onClick={() => setFilter(id)}
              type="button"
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className="workspace-home__summary">
          <span>{manifest.canvases.filter((item) => !item.deletedAt).length} 个画布</span>
        </div>
      </aside>

      <header className="workspace-home__topbar">
        <div className="workspace-home__search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索工作区"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索画布"
            role="searchbox"
            value={query}
          />
          {normalizedQuery ? (
            <div aria-label="搜索结果" className="workspace-home__search-results" role="listbox">
              {canvasResults.map((canvas) => (
                <button
                  key={canvas.canvasId}
                  onClick={() => {
                    setFilter('all')
                    setSearchTarget(canvas.canvasId)
                    setQuery('')
                  }}
                  role="option"
                  type="button"
                >
                  <PanelTop aria-hidden="true" />
                  <span>{canvas.name}</span>
                </button>
              ))}
              {canvasResults.length === 0 ? <p>没有匹配的画布</p> : null}
            </div>
          ) : null}
        </div>
        <div className="workspace-home__actions">
          <button className="is-primary" onClick={() => props.onCreateCanvas?.({ x: 320, y: 180 })} type="button">
            <Plus aria-hidden="true" />
            新建画布
          </button>
          <button onClick={props.onApiIntegration} type="button">
            <Cable aria-hidden="true" />
            API 接入
          </button>
        </div>
      </header>

      <section className="workspace-home__content" aria-label="画布列表">
        <div className="workspace-home__content-header">
          <div>
            <h1>{filter === 'trash' ? '回收站' : filter === 'favorites' ? '收藏画布' : '所有画布'}</h1>
            <span>{visibleCanvases.length} 个画布</span>
          </div>
          <label>
            <span>排序</span>
            <select aria-label="画布排序" onChange={(event) => setSort(event.target.value as WorkspaceSort)} value={sort}>
              <option value="updated">最近修改</option>
              <option value="name">名称</option>
              <option value="created">创建时间</option>
            </select>
          </label>
        </div>
        {visibleCanvases.length ? (
          <div className="workspace-canvas-grid">
            {visibleCanvases.map((canvas) => (
              <CanvasCard
                canvas={canvas}
                editing={props.editingItem?.kind === 'canvas' && props.editingItem.id === canvas.canvasId}
                key={canvas.canvasId}
                props={props}
                trashMode={filter === 'trash'}
              />
            ))}
          </div>
        ) : (
          <div className="workspace-home__empty">
            <PanelTop aria-hidden="true" />
            <strong>{filter === 'trash' ? '回收站为空' : '这里还没有画布'}</strong>
            {filter !== 'trash' ? (
              <button onClick={() => props.onCreateCanvas?.({ x: 320, y: 180 })} type="button">
                <Plus aria-hidden="true" /> 新建画布
              </button>
            ) : null}
          </div>
        )}
      </section>
    </main>
  )
}
