import {
  Check,
  CheckSquare,
  Download,
  Eye,
  FileAudio,
  Image as ImageIcon,
  Loader2,
  Package,
  Plus,
  Search,
  Square,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react'
import { createPortal } from 'react-dom'

import {
  assetRegistry,
  type CanvasAssetEntry,
} from '../../services/assetRegistry'
import '../../styles/asset-manager.css'

export interface AssetManagerModalProps {
  open: boolean
  onClose: () => void
  onInsertAsset: (asset: CanvasAssetEntry) => void | Promise<void>
  projectId?: string
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
}

type MediaTypeTab = 'all' | 'image' | 'video' | 'audio'
type SortOrder = 'newest' | 'oldest' | 'size' | 'name'

function formatBytes(bytes?: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatDuration(seconds?: number): string {
  if (!seconds) return ''
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function AssetManagerModal({
  open,
  onClose,
  onInsertAsset,
  projectId,
  onNotify,
}: AssetManagerModalProps) {
  const [activeTab, setActiveTab] = useState<MediaTypeTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [assets, setAssets] = useState<CanvasAssetEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [previewAsset, setPreviewAsset] = useState<CanvasAssetEntry | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const refreshAssets = useCallback(() => {
    const list = assetRegistry.listAssets({
      type: activeTab === 'all' ? undefined : activeTab,
      projectId: scope === 'project' ? projectId : undefined,
      query: searchQuery,
    })
    setAssets(list)
  }, [activeTab, scope, projectId, searchQuery])

  useEffect(() => {
    if (open) {
      refreshAssets()
    }
  }, [open, refreshAssets])

  // Keydown listener for Escape
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (previewAsset) {
          setPreviewAsset(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, previewAsset, onClose])

  // Sort assets
  const sortedAssets = useMemo(() => {
    const list = [...assets]
    if (sortOrder === 'newest') {
      return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    if (sortOrder === 'oldest') {
      return list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    }
    if (sortOrder === 'size') {
      return list.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    }
    if (sortOrder === 'name') {
      return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    }
    return list
  }, [assets, sortOrder])

  // Tab counts
  const tabCounts = useMemo(() => {
    const all = assetRegistry.listAssets({ projectId: scope === 'project' ? projectId : undefined })
    return {
      all: all.length,
      image: all.filter((a) => a.type === 'image').length,
      video: all.filter((a) => a.type === 'video').length,
      audio: all.filter((a) => a.type === 'audio').length,
    }
  }, [scope, projectId, assets])

  // Upload handler
  const handleFilesUpload = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return
    setUploading(true)
    let successCount = 0
    try {
      for (const file of Array.from(files)) {
        await assetRegistry.uploadAndRegisterAsset(file, scope === 'project' ? projectId : undefined)
        successCount += 1
      }
      refreshAssets()
      onNotify?.(`成功上传 ${successCount} 个资产`, 'success')
    } catch (err: unknown) {
      console.error('Upload asset error:', err)
      onNotify?.('上传资产失败，请检查网络或文件格式', 'error')
    } finally {
      setUploading(false)
    }
  }

  // Drag & drop handlers
  const handleDragOver = (e: ReactDragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDragLeave = (e: ReactDragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = (e: ReactDragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFilesUpload(e.dataTransfer.files)
    }
  }

  // Single asset actions
  const handleInsert = (asset: CanvasAssetEntry) => {
    onInsertAsset(asset)
    onNotify?.(`已将「${asset.name}」置入画布`, 'success')
  }

  const handleDelete = async (asset: CanvasAssetEntry) => {
    try {
      await assetRegistry.deleteAsset(asset.id)
      refreshAssets()
      onNotify?.(`已删除资产「${asset.name}」`, 'info')
    } catch (err: unknown) {
      onNotify?.(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const handleDownload = (asset: CanvasAssetEntry) => {
    const a = document.createElement('a')
    a.href = asset.url
    a.download = asset.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    onNotify?.('已开始下载文件', 'info')
  }

  // Batch actions
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (selectedIds.size === sortedAssets.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sortedAssets.map((a) => a.id)))
    }
  }

  const [cleaning, setCleaning] = useState(false)
  const handleCleanUnreferenced = async () => {
    setCleaning(true)
    try {
      const { count } = await assetRegistry.cleanUnreferenced()
      refreshAssets()
      if (count > 0) {
        onNotify?.(`已清理 ${count} 个未引用的资产`, 'success')
      } else {
        onNotify?.('所有资产均在画布中被引用，无需清理', 'info')
      }
    } catch (err: unknown) {
      onNotify?.(err instanceof Error ? err.message : '清理失败', 'error')
    } finally {
      setCleaning(false)
    }
  }

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    try {
      const deleted = await assetRegistry.deleteAssets(ids)
      setSelectedIds(new Set())
      refreshAssets()
      onNotify?.(`已批量删除 ${deleted.length} 个资产`, 'info')
    } catch (err: unknown) {
      refreshAssets()
      onNotify?.(err instanceof Error ? err.message : '批量删除失败', 'error')
    }
  }

  const handleBatchInsert = () => {
    const selectedAssets = sortedAssets.filter((a) => selectedIds.has(a.id))
    for (const asset of selectedAssets) {
      onInsertAsset(asset)
    }
    setSelectedIds(new Set())
    setBatchMode(false)
    onClose()
    onNotify?.(`已将 ${selectedAssets.length} 个资产置入画布`, 'success')
  }

  if (!open) return null

  return createPortal(
    <div
      aria-label="资产管理"
      aria-modal="true"
      className="asset-manager-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
    >
      <div
        className="asset-manager-modal"
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        ref={modalRef}
      >
        {/* Header */}
        <header className="asset-manager-modal__header">
          <div className="asset-manager-modal__title-group">
            <span className="asset-manager-modal__icon">
              <Package size={18} />
            </span>
            <h2 className="asset-manager-modal__title">资产管理</h2>
            <span className="asset-manager-modal__count-pill">
              共 {tabCounts.all} 个资产
            </span>
          </div>
          <div className="asset-manager-modal__header-actions">
            <input
              accept="image/*,video/*,audio/*"
              multiple
              onChange={(e) => {
                if (e.target.files) void handleFilesUpload(e.target.files)
              }}
              ref={fileInputRef}
              style={{ display: 'none' }}
              type="file"
            />
            <button
              aria-label="上传资产"
              className="asset-manager-modal__upload-btn"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {uploading ? <Loader2 className="spinning" size={14} /> : <Upload size={14} />}
              <span>{uploading ? '上传中...' : '上传资产'}</span>
            </button>
            <button
              aria-label="清理未引用资产"
              className="asset-manager-modal__upload-btn"
              disabled={cleaning}
              onClick={() => void handleCleanUnreferenced()}
              style={{ background: 'var(--canvas-toolbar-btn-hover-bg, rgba(255,255,255,0.08))', border: '1px solid rgba(255,255,255,0.1)' }}
              title="扫描所有画布，安全清理未被任何画布引用的孤儿素材"
              type="button"
            >
              {cleaning ? <Loader2 className="spinning" size={14} /> : <Trash2 size={14} />}
              <span>{cleaning ? '清理中...' : '清理未引用'}</span>
            </button>
            <button
              aria-label="关闭资产管理"
              className="asset-manager-modal__close-btn"
              onClick={onClose}
              type="button"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Toolbar */}
        <div className="asset-manager-modal__toolbar">
          {/* Media Type Tabs */}
          <nav aria-label="媒体类型筛选" className="asset-manager-modal__tabs">
            <button
              className={`asset-manager-modal__tab ${activeTab === 'all' ? 'asset-manager-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('all')}
              type="button"
            >
              <span>全部</span>
              <span className="asset-manager-modal__tab-badge">{tabCounts.all}</span>
            </button>
            <button
              className={`asset-manager-modal__tab ${activeTab === 'image' ? 'asset-manager-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('image')}
              type="button"
            >
              <ImageIcon size={14} />
              <span>图片</span>
              <span className="asset-manager-modal__tab-badge">{tabCounts.image}</span>
            </button>
            <button
              className={`asset-manager-modal__tab ${activeTab === 'video' ? 'asset-manager-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('video')}
              type="button"
            >
              <Video size={14} />
              <span>视频</span>
              <span className="asset-manager-modal__tab-badge">{tabCounts.video}</span>
            </button>
            <button
              className={`asset-manager-modal__tab ${activeTab === 'audio' ? 'asset-manager-modal__tab--active' : ''}`}
              onClick={() => setActiveTab('audio')}
              type="button"
            >
              <FileAudio size={14} />
              <span>音频</span>
              <span className="asset-manager-modal__tab-badge">{tabCounts.audio}</span>
            </button>
          </nav>

          {/* Controls */}
          <div className="asset-manager-modal__controls">
            {/* Scope Filter */}
            <select
              aria-label="资产范围"
              className="asset-manager-modal__sort-select"
              onChange={(e) => setScope(e.target.value as 'all' | 'project')}
              value={scope}
            >
              <option value="all">跨画布通用资产</option>
              <option value="project">当前画布资产</option>
            </select>

            {/* Search */}
            <label className="asset-manager-modal__search">
              <Search size={14} />
              <input
                aria-label="搜索资产"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索资产名称/标签..."
                type="search"
                value={searchQuery}
              />
            </label>

            {/* Sort */}
            <select
              aria-label="排序方式"
              className="asset-manager-modal__sort-select"
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
              value={sortOrder}
            >
              <option value="newest">最新上传</option>
              <option value="oldest">最早上传</option>
              <option value="size">文件大小</option>
              <option value="name">文件名</option>
            </select>

            {/* Batch mode toggle */}
            <button
              className={`asset-manager-modal__batch-toggle ${batchMode ? 'asset-manager-modal__batch-toggle--active' : ''}`}
              onClick={() => {
                setBatchMode((prev) => !prev)
                setSelectedIds(new Set())
              }}
              type="button"
            >
              {batchMode ? <CheckSquare size={14} /> : <Square size={14} />}
              <span>{batchMode ? '退出多选' : '多选管理'}</span>
            </button>
          </div>
        </div>

        {/* Body / Grid */}
        <div className="asset-manager-modal__body">
          {dragOver && (
            <div className="asset-manager-modal__drop-active">
              <Upload size={36} />
              <p style={{ marginTop: 10, fontSize: 14, fontWeight: 600 }}>释放文件以上传到资产库</p>
            </div>
          )}

          {sortedAssets.length === 0 ? (
            <div className="asset-manager-modal__empty">
              <Package className="asset-manager-modal__empty-icon" size={48} />
              <p className="asset-manager-modal__empty-text">
                {searchQuery ? '未搜索到匹配的资产' : '资产库暂无资产'}
              </p>
              <span className="asset-manager-modal__empty-hint">
                拖拽图片、视频或音频文件到此处，或点击右上角「上传资产」
              </span>
            </div>
          ) : (
            <div className="asset-manager-modal__grid">
              {sortedAssets.map((asset) => {
                const isSelected = selectedIds.has(asset.id)
                return (
                  <div
                    className={`asset-card ${isSelected ? 'asset-card--selected' : ''}`}
                    key={asset.id}
                  >
                    {/* Thumbnail Box */}
                    <div className="asset-card__thumb-box">
                      {asset.type === 'image' ? (
                        <img
                          alt={asset.name}
                          className="asset-card__thumb"
                          loading="lazy"
                          src={asset.thumbnailUrl || asset.url}
                        />
                      ) : asset.type === 'video' ? (
                        <img
                          alt={asset.name}
                          className="asset-card__thumb"
                          loading="lazy"
                          src={asset.posterUrl || asset.thumbnailUrl || asset.url}
                        />
                      ) : (
                        <FileAudio size={36} style={{ color: '#0d99ff' }} />
                      )}

                      {/* Type Badge */}
                      <span className="asset-card__type-badge">
                        {asset.type === 'image' ? 'IMG' : asset.type === 'video' ? 'VID' : 'AUD'}
                      </span>

                      {/* Duration for video/audio */}
                      {asset.durationSec ? (
                        <span className="asset-card__duration-badge">
                          {formatDuration(asset.durationSec)}
                        </span>
                      ) : null}

                      {/* Batch Checkbox */}
                      {batchMode && (
                        <button
                          className="asset-card__checkbox"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleSelect(asset.id)
                          }}
                          type="button"
                        >
                          {isSelected ? <Check size={14} /> : null}
                        </button>
                      )}

                      {/* Card Overlay Actions */}
                      {!batchMode && (
                        <div className="asset-card__overlay">
                          <div className="asset-card__overlay-top">
                            <button
                              aria-label="预览"
                              className="asset-card__overlay-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                setPreviewAsset(asset)
                              }}
                              title="预览原画"
                              type="button"
                            >
                              <Eye size={14} />
                            </button>
                            <button
                              aria-label="下载"
                              className="asset-card__overlay-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDownload(asset)
                              }}
                              title="下载到本地"
                              type="button"
                            >
                              <Download size={14} />
                            </button>
                            <button
                              aria-label="删除"
                              className="asset-card__overlay-btn asset-card__overlay-btn--danger"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDelete(asset)
                              }}
                              title="删除资产"
                              type="button"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <button
                            className="asset-card__insert-btn"
                            onClick={() => handleInsert(asset)}
                            type="button"
                          >
                            <Plus size={14} />
                            <span>置入画布</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Metadata */}
                    <div className="asset-card__info">
                      <h4 className="asset-card__name" title={asset.name}>
                        {asset.name}
                      </h4>
                      <div className="asset-card__meta">
                        <span>{formatBytes(asset.size)}</span>
                        <span>{new Date(asset.createdAt).toLocaleDateString('zh-CN')}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Batch Footer Bar */}
        {batchMode && selectedIds.size > 0 && (
          <div className="asset-manager-modal__batch-bar">
            <span>已选择 {selectedIds.size} 项</span>
            <div className="asset-manager-modal__batch-actions">
              <button
                className="asset-manager-modal__batch-btn"
                onClick={selectAll}
                type="button"
              >
                {selectedIds.size === sortedAssets.length ? '取消全选' : '全选'}
              </button>
              <button
                className="asset-manager-modal__batch-btn"
                onClick={handleBatchInsert}
                type="button"
              >
                <Plus size={14} />
                <span>批量置入画布</span>
              </button>
              <button
                className="asset-manager-modal__batch-btn asset-manager-modal__batch-btn--danger"
                onClick={handleBatchDelete}
                type="button"
              >
                <Trash2 size={14} />
                <span>批量删除</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen Preview Lightbox */}
      {previewAsset && (
        <div
          className="asset-preview-lightbox"
          onClick={() => setPreviewAsset(null)}
        >
          <div
            className="asset-preview-lightbox__container"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="asset-preview-lightbox__close"
              onClick={() => setPreviewAsset(null)}
              type="button"
            >
              <X size={20} />
            </button>

            {previewAsset.type === 'image' ? (
              <img
                alt={previewAsset.name}
                className="asset-preview-lightbox__media"
                src={previewAsset.url}
              />
            ) : previewAsset.type === 'video' ? (
              <video
                autoPlay
                className="asset-preview-lightbox__media"
                controls
                src={previewAsset.url}
              />
            ) : (
              <audio controls src={previewAsset.url} style={{ width: 400 }} />
            )}

            <div className="asset-preview-lightbox__footer">
              <div>
                <strong>{previewAsset.name}</strong>
                <span style={{ marginLeft: 12, opacity: 0.7 }}>
                  {formatBytes(previewAsset.size)}
                  {previewAsset.width && previewAsset.height
                    ? ` • ${previewAsset.width} × ${previewAsset.height}`
                    : ''}
                </span>
              </div>
              <button
                className="asset-card__insert-btn"
                onClick={() => {
                  handleInsert(previewAsset)
                  setPreviewAsset(null)
                }}
                style={{ width: 'auto', padding: '0 16px' }}
                type="button"
              >
                <Plus size={14} />
                <span>置入当前画布</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
