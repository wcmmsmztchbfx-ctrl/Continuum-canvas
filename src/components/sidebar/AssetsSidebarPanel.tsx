import {
  FileAudio,
  Image as ImageIcon,
  Loader2,
  Package,
  Plus,
  Search,
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

import {
  assetRegistry,
  type CanvasAssetEntry,
} from '../../services/assetRegistry'

export interface AssetsSidebarPanelProps {
  onInsertAsset: (asset: CanvasAssetEntry) => void
  projectId?: string
  onNotify?: (message: string, tone?: 'info' | 'success' | 'error') => void
}

type MediaTypeTab = 'all' | 'image' | 'video' | 'audio'

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

export function AssetsSidebarPanel({
  onInsertAsset,
  projectId,
  onNotify,
}: AssetsSidebarPanelProps) {
  const [activeTab, setActiveTab] = useState<MediaTypeTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [scope] = useState<'all' | 'project'>('all')
  const [assets, setAssets] = useState<CanvasAssetEntry[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [previewAsset, setPreviewAsset] = useState<CanvasAssetEntry | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const refreshAssets = useCallback(() => {
    const list = assetRegistry.listAssets({
      type: activeTab === 'all' ? undefined : activeTab,
      projectId: scope === 'project' ? projectId : undefined,
      query: searchQuery,
    })
    setAssets(list)
  }, [activeTab, scope, projectId, searchQuery])

  useEffect(() => {
    refreshAssets()
  }, [refreshAssets])

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

  const handleInsert = (asset: CanvasAssetEntry) => {
    onInsertAsset(asset)
    onNotify?.(`已将「${asset.name}」置入画布`, 'success')
  }

  const handleDelete = (asset: CanvasAssetEntry) => {
    assetRegistry.deleteAssets([asset.id])
    refreshAssets()
    onNotify?.(`已删除资产「${asset.name}」`, 'info')
  }

  const tabCounts = useMemo(() => {
    const all = assetRegistry.listAssets({ projectId: scope === 'project' ? projectId : undefined })
    return {
      all: all.length,
      image: all.filter((a) => a.type === 'image').length,
      video: all.filter((a) => a.type === 'video').length,
      audio: all.filter((a) => a.type === 'audio').length,
    }
  }, [scope, projectId, assets])

  return (
    <div
      aria-label="资产库面板"
      className="sidebar-assets-panel"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Top action row */}
      <div className="sidebar-assets-panel__top">
        <strong className="sidebar-assets-panel__title">资产库</strong>
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
          className="sidebar-assets-panel__upload-btn"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          title="上传图片/视频/音频"
          type="button"
        >
          {uploading ? <Loader2 className="spinning" size={12} /> : <Upload size={12} />}
          <span>{uploading ? '上传中' : '上传'}</span>
        </button>
      </div>

      {/* Search Input */}
      <label className="sidebar-assets-panel__search">
        <Search size={13} />
        <input
          aria-label="搜索资产"
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索资产名称..."
          type="search"
          value={searchQuery}
        />
      </label>

      {/* Filter Tabs */}
      <div className="sidebar-assets-panel__tabs">
        <button
          className={`sidebar-assets-panel__tab ${activeTab === 'all' ? 'sidebar-assets-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('all')}
          type="button"
        >
          <span>全部</span>
          <span className="sidebar-assets-panel__tab-badge">{tabCounts.all}</span>
        </button>
        <button
          className={`sidebar-assets-panel__tab ${activeTab === 'image' ? 'sidebar-assets-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('image')}
          type="button"
        >
          <ImageIcon size={11} />
          <span>图片</span>
          <span className="sidebar-assets-panel__tab-badge">{tabCounts.image}</span>
        </button>
        <button
          className={`sidebar-assets-panel__tab ${activeTab === 'video' ? 'sidebar-assets-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('video')}
          type="button"
        >
          <Video size={11} />
          <span>视频</span>
          <span className="sidebar-assets-panel__tab-badge">{tabCounts.video}</span>
        </button>
        <button
          className={`sidebar-assets-panel__tab ${activeTab === 'audio' ? 'sidebar-assets-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('audio')}
          type="button"
        >
          <FileAudio size={11} />
          <span>音频</span>
          <span className="sidebar-assets-panel__tab-badge">{tabCounts.audio}</span>
        </button>
      </div>

      {/* Asset List / Grid */}
      <div className="sidebar-assets-panel__list">
        {dragOver && (
          <div className="sidebar-assets-panel__drop-target">
            <Upload size={24} />
            <span>释放文件以上传到资产库</span>
          </div>
        )}

        {assets.length === 0 ? (
          <div className="sidebar-assets-panel__empty">
            <Package size={28} style={{ opacity: 0.4, marginBottom: 6 }} />
            <span>{searchQuery ? '未找到匹配资产' : '暂无资产'}</span>
            <small>拖入文件或点击右上角「上传」</small>
          </div>
        ) : (
          <div className="sidebar-assets-panel__grid">
            {assets.map((asset) => (
              <div
                className="sidebar-asset-card"
                draggable
                key={asset.id}
                onClick={() => handleInsert(asset)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    'application/x-canvas-asset',
                    JSON.stringify(asset),
                  )
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                title="单击置入画布，或拖拽到画布"
              >
                <div className="sidebar-asset-card__thumb-box">
                  {asset.type === 'image' ? (
                    <img
                      alt={asset.name}
                      className="sidebar-asset-card__thumb"
                      loading="lazy"
                      src={asset.thumbnailUrl || asset.url}
                    />
                  ) : asset.type === 'video' ? (
                    <img
                      alt={asset.name}
                      className="sidebar-asset-card__thumb"
                      loading="lazy"
                      src={asset.posterUrl || asset.thumbnailUrl || asset.url}
                    />
                  ) : (
                    <FileAudio size={24} style={{ color: '#0d99ff' }} />
                  )}

                  <span className="sidebar-asset-card__badge">
                    {asset.type === 'image' ? 'IMG' : asset.type === 'video' ? 'VID' : 'AUD'}
                  </span>

                  {asset.durationSec ? (
                    <span className="sidebar-asset-card__duration">
                      {formatDuration(asset.durationSec)}
                    </span>
                  ) : null}

                  {/* Floating Action Buttons */}
                  <div className="sidebar-asset-card__actions">
                    <button
                      aria-label="置入画布"
                      className="sidebar-asset-card__action-btn sidebar-asset-card__action-btn--primary"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleInsert(asset)
                      }}
                      title="置入当前画布"
                      type="button"
                    >
                      <Plus size={12} />
                    </button>
                    <button
                      aria-label="删除"
                      className="sidebar-asset-card__action-btn sidebar-asset-card__action-btn--danger"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(asset)
                      }}
                      title="删除资产"
                      type="button"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                <div className="sidebar-asset-card__meta">
                  <span className="sidebar-asset-card__name">{asset.name}</span>
                  <span className="sidebar-asset-card__size">{formatBytes(asset.size)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preview Lightbox if active */}
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
              <img alt={previewAsset.name} className="asset-preview-lightbox__media" src={previewAsset.url} />
            ) : previewAsset.type === 'video' ? (
              <video autoPlay className="asset-preview-lightbox__media" controls src={previewAsset.url} />
            ) : (
              <audio controls src={previewAsset.url} style={{ width: 360 }} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
