import {
  CheckSquare,
  ChevronDown,
  Download,
  Eye,
  FileAudio,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  Trash2,
  Video,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import type {
  GenerationHistoryEntry,
  GenerationHistoryMediaType,
} from '../../contracts/generation'
import {
  gatewayClient,
  type GatewayClient,
  type GatewayRequestOptions,
} from '../../services/gatewayClient'
import '../../styles/generation-history.css'

const PAGE_SIZE = 48
const THUMBNAIL_SIZES = [112, 144, 168] as const
const FOCUSABLE = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type HistoryClient = Pick<
  GatewayClient,
  'listGenerationHistory' | 'deleteGenerationHistoryEntry'
>

type NotifyTone = 'info' | 'success' | 'error'
type SortDirection = 'newest' | 'oldest'

export interface GenerationHistoryModalProps {
  client?: HistoryClient
  onClose: () => void
  onNotify?: (message: string, tone?: NotifyTone) => void
  onUse: (entry: GenerationHistoryEntry) => void | Promise<void>
  open: boolean
  projectId: string
}

const mediaTabs: Array<{
  icon: typeof ImageIcon
  label: string
  type: GenerationHistoryMediaType
}> = [
  { icon: ImageIcon, label: '图片', type: 'image' },
  { icon: Video, label: '视频', type: 'video' },
  { icon: FileAudio, label: '音频', type: 'audio' },
]

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  )
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function dateKey(timestamp: string): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function dateLabel(timestamp: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function resultMeta(entry: GenerationHistoryEntry): string {
  return [
    entry.settings.aspectRatio,
    entry.settings.quality,
    entry.settings.duration ? `${entry.settings.duration}s` : undefined,
  ].filter(Boolean).join(' · ')
}

function HistoryMedia({ entry, preview = false }: {
  entry: GenerationHistoryEntry
  preview?: boolean
}) {
  if (entry.mediaType === 'image') {
    return <img alt={entry.prompt || entry.asset.filename} src={entry.asset.url} />
  }
  if (entry.mediaType === 'video') {
    if (!preview) {
      const assetAny = entry.asset as { posterUrl?: string; thumbnailBlob?: string }
      const poster = assetAny.posterUrl || assetAny.thumbnailBlob
      return (
        <div className="generation-history-modal__video-poster">
          {poster ? (
            <img alt={entry.prompt || entry.asset.filename} src={poster} />
          ) : (
            <video
              aria-label={entry.asset.filename}
              muted
              playsInline
              preload="none"
              src={entry.asset.url}
            />
          )}
          <span className="generation-history-modal__video-badge" aria-hidden="true">
            <Video size={14} />
          </span>
        </div>
      )
    }
    return (
      <video
        aria-label={entry.asset.filename}
        controls
        playsInline
        preload="metadata"
        src={entry.asset.url}
      />
    )
  }
  return (
    <div className="generation-history-modal__audio-art">
      <FileAudio aria-hidden="true" />
      {preview ? <audio controls src={entry.asset.url} /> : null}
    </div>
  )
}

function HistoryCard({
  batchMode,
  deleting,
  entry,
  onDelete,
  onPreview,
  onSelect,
  onUse,
  selected,
}: {
  batchMode: boolean
  deleting: boolean
  entry: GenerationHistoryEntry
  onDelete: () => void
  onPreview: (trigger: HTMLButtonElement) => void
  onSelect: () => void
  onUse: () => void
  selected: boolean
}) {
  return (
    <article
      className={`generation-history-modal__card${selected ? ' generation-history-modal__card--selected' : ''}`}
      data-testid="generation-history-entry"
    >
      <div className="generation-history-modal__media">
        <HistoryMedia entry={entry} />
        {batchMode ? (
          <label className="generation-history-modal__check">
            <input
              aria-label={`选择 ${entry.asset.filename}`}
              checked={selected}
              onChange={onSelect}
              type="checkbox"
            />
            <CheckSquare aria-hidden="true" />
          </label>
        ) : null}
        <div className="generation-history-modal__actions">
          <button
            aria-label="查看"
            onClick={(event) => onPreview(event.currentTarget)}
            type="button"
          >
            <Eye aria-hidden="true" />
            <span>查看</span>
          </button>
          <button aria-label="使用" onClick={onUse} type="button">
            <Plus aria-hidden="true" />
            <span>使用</span>
          </button>
          <a
            aria-label="下载"
            download={entry.asset.filename}
            href={entry.asset.url}
          >
            <Download aria-hidden="true" />
            <span>下载</span>
          </a>
        </div>
        <button
          aria-label="删除记录"
          className="generation-history-modal__delete"
          disabled={deleting}
          onClick={onDelete}
          title="仅移除历史记录"
          type="button"
        >
          {deleting ? <LoaderCircle aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
        </button>
      </div>
      <div className="generation-history-modal__caption">
        <p>{entry.prompt || entry.asset.filename}</p>
        <span>{resultMeta(entry) || entry.model}</span>
      </div>
    </article>
  )
}

export function GenerationHistoryModal({
  client = gatewayClient,
  onClose,
  onNotify,
  onUse,
  open,
  projectId,
}: GenerationHistoryModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const previewDialogRef = useRef<HTMLElement>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const loadMoreAbortRef = useRef<AbortController>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [mediaType, setMediaType] = useState<GenerationHistoryMediaType>('image')
  const [entries, setEntries] = useState<GenerationHistoryEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [sortDirection, setSortDirection] = useState<SortDirection>('newest')
  const [thumbnailIndex, setThumbnailIndex] = useState(1)
  const [preview, setPreview] = useState<GenerationHistoryEntry>()
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  const closePreview = useCallback(() => {
    const trigger = previewTriggerRef.current
    setPreview(undefined)
    if (trigger?.isConnected) trigger.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    loadMoreAbortRef.current?.abort()
    loadMoreAbortRef.current = null
    const controller = new AbortController()
    setEntries([])
    setNextCursor(undefined)
    setError(false)
    setLoading(true)
    setSelectedIds(new Set())
    void client.listGenerationHistory(
      { projectId, mediaType, limit: PAGE_SIZE },
      { signal: controller.signal } satisfies GatewayRequestOptions,
    ).then((page) => {
      setEntries(page.entries)
      setNextCursor(page.nextCursor)
    }).catch((cause: unknown) => {
      if (isAbort(cause)) return
      setError(true)
      onNotify?.('历史记录加载失败', 'error')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [client, mediaType, onNotify, open, projectId, retryKey])

  useEffect(() => {
    if (!open || !dialogRef.current) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    dialogRef.current.querySelector<HTMLElement>('[aria-label="关闭生成历史"]')?.focus()
    return () => {
      loadMoreAbortRef.current?.abort()
      const previous = previousFocusRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  useEffect(() => {
    if (!preview) return
    previewDialogRef.current
      ?.querySelector<HTMLElement>('[aria-label="关闭预览"]')
      ?.focus()
  }, [preview])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (preview) closePreview()
      else onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closePreview, onClose, open, preview])

  const sortedEntries = useMemo(() => [...entries].sort((left, right) => {
    const delta = Date.parse(right.completedAt) - Date.parse(left.completedAt)
    return sortDirection === 'newest' ? delta : -delta
  }), [entries, sortDirection])

  const groups = useMemo(() => {
    const grouped = new Map<string, GenerationHistoryEntry[]>()
    for (const entry of sortedEntries) {
      const key = dateKey(entry.completedAt)
      grouped.set(key, [...(grouped.get(key) ?? []), entry])
    }
    return [...grouped.values()]
  }, [sortedEntries])

  const removeEntries = useCallback(async (targets: GenerationHistoryEntry[]) => {
    if (targets.length === 0) return
    const ids = targets.map((entry) => entry.id)
    setDeletingIds((current) => new Set([...current, ...ids]))
    const removed = new Set<string>()
    try {
      for (const entry of targets) {
        await client.deleteGenerationHistoryEntry(projectId, entry.id)
        removed.add(entry.id)
      }
      setEntries((current) => current.filter((entry) => !removed.has(entry.id)))
      setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))))
      onNotify?.(
        removed.size === 1 ? '已从历史记录中移除' : `已移除 ${removed.size} 条历史记录`,
        'success',
      )
    } catch {
      if (removed.size > 0) {
        setEntries((current) => current.filter((entry) => !removed.has(entry.id)))
      }
      onNotify?.('历史记录删除失败，请重试', 'error')
    } finally {
      setDeletingIds((current) => new Set([...current].filter((id) => !ids.includes(id))))
    }
  }, [client, onNotify, projectId])

  const handleUse = useCallback(async (entry: GenerationHistoryEntry) => {
    try {
      await onUse(entry)
    } catch {
      onNotify?.('无法将该记录添加到画布', 'error')
    }
  }, [onNotify, onUse])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    loadMoreAbortRef.current?.abort()
    const controller = new AbortController()
    loadMoreAbortRef.current = controller
    setLoadingMore(true)
    try {
      const page = await client.listGenerationHistory({
        projectId,
        mediaType,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      }, { signal: controller.signal })
      if (controller.signal.aborted) return
      setEntries((current) => {
        const known = new Set(current.map((entry) => entry.id))
        return [...current, ...page.entries.filter((entry) => !known.has(entry.id))]
      })
      setNextCursor(page.nextCursor)
    } catch (cause: unknown) {
      if (isAbort(cause)) return
      onNotify?.('更多历史记录加载失败', 'error')
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false)
      if (loadMoreAbortRef.current === controller) loadMoreAbortRef.current = null
    }
  }, [client, loadingMore, mediaType, nextCursor, onNotify, projectId])

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const items = focusableElements(dialogRef.current)
    if (items.length === 0) return
    const first = items[0]!
    const last = items.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const trapPreviewFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !previewDialogRef.current) return
    event.stopPropagation()
    const items = focusableElements(previewDialogRef.current)
    if (items.length === 0) return
    const first = items[0]!
    const last = items.at(-1)!
    if (
      items.length === 1 ||
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)
    ) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }

  if (!open) return null

  const currentSize = THUMBNAIL_SIZES[thumbnailIndex]!
  const selectedEntries = entries.filter((entry) => selectedIds.has(entry.id))
  const emptyLabel = mediaType === 'image'
    ? '暂无图片生成记录'
    : mediaType === 'video'
      ? '暂无视频生成记录'
      : '暂无音频生成记录'
  const modal = (
    <div
      className="generation-history-modal__backdrop"
      data-testid="generation-history-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="generation-history-modal"
        onKeyDown={trapFocus}
        ref={dialogRef}
        role="dialog"
        style={{ '--generation-history-tile-size': `${currentSize}px` } as CSSProperties}
      >
        <header className="generation-history-modal__header">
          <div>
            <h2 id={titleId}>生成历史</h2>
            <span>当前项目</span>
          </div>
          <div className="generation-history-modal__header-actions">
            <div className="generation-history-modal__zoom" aria-label="缩略图大小">
              <button
                aria-label="缩小缩略图"
                disabled={thumbnailIndex === 0}
                onClick={() => setThumbnailIndex((value) => Math.max(0, value - 1))}
                type="button"
              >
                <Minus aria-hidden="true" />
              </button>
              <span>{Math.round(currentSize / 1.44)}%</span>
              <button
                aria-label="放大缩略图"
                disabled={thumbnailIndex === THUMBNAIL_SIZES.length - 1}
                onClick={() => setThumbnailIndex((value) => Math.min(THUMBNAIL_SIZES.length - 1, value + 1))}
                type="button"
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <button
              aria-label="关闭生成历史"
              className="generation-history-modal__icon-button"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="generation-history-modal__toolbar">
          <div aria-label="历史类型" className="generation-history-modal__tabs" role="tablist">
            {mediaTabs.map(({ icon: Icon, label, type }) => (
              <button
                aria-selected={mediaType === type}
                key={type}
                onClick={() => setMediaType(type)}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="generation-history-modal__tools">
            {batchMode ? (
              <>
                <span>已选 {selectedIds.size} 项</span>
                <button
                  onClick={() => setSelectedIds(new Set(entries.map((entry) => entry.id)))}
                  type="button"
                >
                  全选当前页
                </button>
                <button onClick={() => setSelectedIds(new Set())} type="button">清空</button>
                <button
                  className="generation-history-modal__danger-action"
                  disabled={selectedEntries.length === 0}
                  onClick={() => void removeEntries(selectedEntries)}
                  type="button"
                >
                  删除所选
                </button>
              </>
            ) : null}
            <button
              aria-pressed={batchMode}
              onClick={() => {
                setBatchMode((value) => !value)
                setSelectedIds(new Set())
              }}
              type="button"
            >
              <CheckSquare aria-hidden="true" />
              批量选择
            </button>
            <button
              aria-label={sortDirection === 'newest' ? '时间升序' : '时间降序'}
              onClick={() => setSortDirection((value) => value === 'newest' ? 'oldest' : 'newest')}
              type="button"
            >
              {sortDirection === 'newest' ? '时间降序' : '时间升序'}
              <ChevronDown aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="generation-history-modal__body">
          {loading ? (
            <div className="generation-history-modal__state" role="status">
              <LoaderCircle aria-hidden="true" className="generation-history-modal__spinner" />
              正在加载历史记录
            </div>
          ) : error ? (
            <div className="generation-history-modal__state" role="alert">
              <p>历史记录加载失败</p>
              <button onClick={() => setRetryKey((value) => value + 1)} type="button">
                <RotateCcw aria-hidden="true" />
                重试
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="generation-history-modal__state generation-history-modal__state--empty">
              <ImageIcon aria-hidden="true" />
              <p>{emptyLabel}</p>
              <span>完成生成后，结果会保存在当前项目中</span>
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <section className="generation-history-modal__group" key={dateKey(group[0]!.completedAt)}>
                  <h3>{dateLabel(group[0]!.completedAt)}</h3>
                  <div className="generation-history-modal__grid">
                    {group.map((entry) => (
                      <HistoryCard
                        batchMode={batchMode}
                        deleting={deletingIds.has(entry.id)}
                        entry={entry}
                        key={entry.id}
                        onDelete={() => void removeEntries([entry])}
                        onPreview={(trigger) => {
                          previewTriggerRef.current = trigger
                          setPreview(entry)
                        }}
                        onSelect={() => setSelectedIds((current) => {
                          const next = new Set(current)
                          if (next.has(entry.id)) next.delete(entry.id)
                          else next.add(entry.id)
                          return next
                        })}
                        onUse={() => void handleUse(entry)}
                        selected={selectedIds.has(entry.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {nextCursor ? (
                <button
                  className="generation-history-modal__load-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  type="button"
                >
                  {loadingMore ? <LoaderCircle aria-hidden="true" /> : null}
                  {loadingMore ? '加载中' : '加载更多'}
                </button>
              ) : null}
            </>
          )}
        </div>

        {preview ? (
          <div
            className="generation-history-modal__preview-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closePreview()
            }}
          >
            <section
              aria-label="查看生成结果"
              aria-modal="true"
              className="generation-history-modal__preview"
              onKeyDown={trapPreviewFocus}
              ref={previewDialogRef}
              role="dialog"
            >
              <button
                aria-label="关闭预览"
                className="generation-history-modal__preview-close"
                onClick={closePreview}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
              <div className="generation-history-modal__preview-media">
                <HistoryMedia entry={preview} preview />
              </div>
              <div className="generation-history-modal__preview-details">
                <strong>{preview.prompt || preview.asset.filename}</strong>
                <span>{preview.model} · {resultMeta(preview)}</span>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  )

  return typeof document === 'undefined' ? modal : createPortal(modal, document.body)
}
