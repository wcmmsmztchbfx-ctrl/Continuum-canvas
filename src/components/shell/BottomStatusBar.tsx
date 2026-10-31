import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  LayoutGrid,
  Library,
  History,
  Magnet,
  Map,
  Waypoints,
} from 'lucide-react'

import { IconButton } from './IconButton'

export interface BottomStatusBarProps {
  hideConnections?: boolean
  historyOpen?: boolean
  onAssetManager?: () => void
  onHistory?: () => void
  onFitCanvas?: () => void
  onLayout?: () => void
  onToggleConnections?: () => void
  onToggleMiniMap?: () => void
  onToggleSnap?: () => void
  onToggleGridSnap?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomTo?: (zoom: number) => void
  showMiniMap?: boolean
  snapToGrid?: boolean
  smartSnap?: boolean
  zoom?: number
}

export function BottomStatusBar({
  hideConnections = false,
  historyOpen = false,
  onAssetManager,
  onHistory,
  onFitCanvas,
  onLayout,
  onToggleConnections,
  onToggleMiniMap,
  onToggleSnap,
  onToggleGridSnap,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  showMiniMap = false,
  snapToGrid = false,
  smartSnap = true,
  zoom = 20,
}: BottomStatusBarProps) {
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [zoomInput, setZoomInput] = useState(() => String(Math.round(zoom)))
  const zoomMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => setZoomInput(String(Math.round(zoom))), [zoom])

  useEffect(() => {
    if (!zoomMenuOpen) return

    const closeOnOutside = (event: PointerEvent) => {
      if (!zoomMenuRef.current?.contains(event.target as Node)) {
        setZoomMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside, true)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [zoomMenuOpen])

  const applyZoomInput = () => {
    const next = Number(zoomInput)
    if (!Number.isFinite(next)) return
    onZoomTo?.(Math.min(800, Math.max(10, next)) / 100)
  }

  return (
    <footer
      aria-label="画布状态"
      className="bottom-status-bar"
      data-testid="bottom-status-bar"
      role="status"
    >
      {onAssetManager ? (
        <button
          aria-label="资产管理"
          className="bottom-status-bar__assets"
          data-tooltip="资产管理"
          onClick={onAssetManager}
          title="资产管理"
          type="button"
        >
          <Library aria-hidden="true" focusable="false" />
          <span>资产管理</span>
        </button>
      ) : null}
      <IconButton
        icon={History}
        label="历史记录"
        onClick={onHistory}
        pressed={historyOpen}
      />
      <IconButton
        icon={LayoutGrid}
        label="整理画布，Alt+Shift+F"
        onClick={onLayout}
      />
      <IconButton
        icon={Map}
        label="切换小地图"
        onClick={onToggleMiniMap}
        pressed={showMiniMap}
      />
      <IconButton
        icon={Waypoints}
        label={hideConnections ? '显示节点连线' : '隐藏节点连线'}
        onClick={onToggleConnections}
        pressed={!hideConnections}
      />
      <IconButton
        icon={Magnet}
        label="智能吸附"
        onClick={onToggleSnap}
        pressed={smartSnap}
      />
      <div className="bottom-status-bar__zoom-wrap" ref={zoomMenuRef}>
        <button
          aria-expanded={zoomMenuOpen}
          aria-haspopup="menu"
          aria-label="缩放选项"
          className="bottom-status-bar__zoom"
          onClick={() => setZoomMenuOpen((current) => !current)}
          type="button"
        >
          <span>{Math.round(zoom)}%</span>
          <ChevronDown aria-hidden="true" />
        </button>
        {zoomMenuOpen ? (
          <div aria-label="缩放选项" className="canvas-zoom-menu" role="menu">
            <label className="canvas-zoom-menu__input">
              <input
                aria-label="缩放比例"
                inputMode="numeric"
                onBlur={applyZoomInput}
                onChange={(event) => setZoomInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyZoomInput()
                }}
                value={zoomInput}
              />
              <span>%</span>
            </label>
            <button onClick={onZoomIn} role="menuitem" type="button">
              <span>放大</span><kbd>Ctrl +</kbd>
            </button>
            <button onClick={onZoomOut} role="menuitem" type="button">
              <span>缩小</span><kbd>Ctrl -</kbd>
            </button>
            <button onClick={onFitCanvas} role="menuitem" type="button">
              <span>适合屏幕</span><kbd>Ctrl 0</kbd>
            </button>
            <button aria-pressed={snapToGrid} onClick={onToggleGridSnap} role="menuitem" type="button">
              <span>网格吸附</span><kbd>{snapToGrid ? '开' : '关'}</kbd>
            </button>
            {[0.5, 1, 8].map((value) => (
              <button
                key={value}
                onClick={() => onZoomTo?.(value)}
                role="menuitem"
                type="button"
              >
                缩放至{value * 100}%
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </footer>
  )
}
