import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  MAX_INSPECTOR_WIDTH,
  MAX_LAYERS_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_LAYERS_WIDTH,
  normalizeInspectorWidth,
  normalizeLayersWidth,
  type UiPreferences,
} from '../persistence'

export interface UseSidebarResizeOptions {
  appShellRef: React.RefObject<HTMLElement | null>
  initialLayersWidth: number
  initialInspectorWidth: number
  onPersistPreferences: (changes: Partial<UiPreferences>) => void
}

export function useSidebarResize({
  appShellRef,
  initialLayersWidth,
  initialInspectorWidth,
  onPersistPreferences,
}: UseSidebarResizeOptions) {
  const [layersWidth, setLayersWidth] = useState(initialLayersWidth)
  const [layersResizing, setLayersResizing] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(initialInspectorWidth)
  const [inspectorResizing, setInspectorResizing] = useState(false)

  const layersResizeRef = useRef<{
    startX: number
    startWidth: number
    width: number
    cleanup: () => void
  } | undefined>(undefined)

  const inspectorResizeRef = useRef<{
    startX: number
    startWidth: number
    width: number
    cleanup: () => void
  } | undefined>(undefined)

  const finishLayersResize = useCallback(() => {
    const resize = layersResizeRef.current
    if (!resize) return
    layersResizeRef.current = undefined
    resize.cleanup()
    setLayersResizing(false)
    setLayersWidth(resize.width)
    onPersistPreferences({ layersWidth: resize.width })
  }, [onPersistPreferences])

  const startLayersResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (window.innerWidth <= 720 || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const move = (moveEvent: MouseEvent) => {
        const resize = layersResizeRef.current
        if (!resize) return
        const maximum = Math.min(MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7))
        const width = Math.min(
          maximum,
          Math.max(MIN_LAYERS_WIDTH, resize.startWidth + moveEvent.clientX - resize.startX),
        )
        resize.width = normalizeLayersWidth(width)
        if (appShellRef.current) {
          appShellRef.current.style.setProperty('--layers-sidebar-width', `${resize.width}px`)
        }
      }
      const end = () => finishLayersResize()
      const cleanup = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', end)
        window.removeEventListener('blur', end)
      }
      layersResizeRef.current = {
        startX: event.clientX,
        startWidth: layersWidth,
        width: layersWidth,
        cleanup,
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', end)
      window.addEventListener('blur', end)
      setLayersResizing(true)
    },
    [appShellRef, finishLayersResize, layersWidth],
  )

  const finishInspectorResize = useCallback(() => {
    const resize = inspectorResizeRef.current
    if (!resize) return
    inspectorResizeRef.current = undefined
    resize.cleanup()
    setInspectorResizing(false)
    setInspectorWidth(resize.width)
    onPersistPreferences({ inspectorWidth: resize.width })
  }, [onPersistPreferences])

  const startInspectorResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (window.innerWidth <= 720 || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const startWidth = inspectorWidth
      const move = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        const maximum = Math.min(MAX_INSPECTOR_WIDTH, Math.floor(window.innerWidth * 0.6))
        const width = Math.min(maximum, Math.max(MIN_INSPECTOR_WIDTH, startWidth + delta))
        const normalized = normalizeInspectorWidth(width)
        if (inspectorResizeRef.current) {
          inspectorResizeRef.current.width = normalized
        }
        if (appShellRef.current) {
          appShellRef.current.style.setProperty('--inspector-sidebar-width', `${normalized}px`)
        }
      }
      const end = () => finishInspectorResize()
      const cleanup = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', end)
        window.removeEventListener('blur', end)
      }
      inspectorResizeRef.current = {
        startX,
        startWidth,
        width: startWidth,
        cleanup,
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', end)
      window.addEventListener('blur', end)
      setInspectorResizing(true)
    },
    [appShellRef, finishInspectorResize, inspectorWidth],
  )

  const resizeLayersByKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? 40 : 10
      const maximum = Math.min(MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7))
      const width = Math.min(
        maximum,
        Math.max(MIN_LAYERS_WIDTH, layersWidth + (event.key === 'ArrowRight' ? step : -step)),
      )
      setLayersWidth(width)
      onPersistPreferences({ layersWidth: width })
    },
    [layersWidth, onPersistPreferences],
  )

  return {
    layersWidth,
    setLayersWidth,
    layersResizing,
    inspectorWidth,
    setInspectorWidth,
    inspectorResizing,
    startLayersResize,
    startInspectorResize,
    resizeLayersByKeyboard,
  }
}
