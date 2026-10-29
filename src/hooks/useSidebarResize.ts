import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  const [layersWidth, setLayersWidth] = useState(() => normalizeLayersWidth(initialLayersWidth))
  const [layersResizing, setLayersResizing] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(() => normalizeInspectorWidth(initialInspectorWidth))
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

  const renderedWidth = useCallback((selector: string, fallback: number) =>
    appShellRef.current?.querySelector(selector)?.getBoundingClientRect().width || fallback,
  [appShellRef])

  const maximumWidth = useCallback((side: 'layers' | 'inspector') => {
    const shell = appShellRef.current
    const available = shell?.getBoundingClientRect().width || window.innerWidth
    const style = shell ? getComputedStyle(shell) : undefined
    const rail = Number.parseFloat(style?.getPropertyValue('--layers-sidebar-rail-width') || '') || 48
    const stageMinimum = Number.parseFloat(style?.getPropertyValue('--canvas-stage-min-width') || '') || 220
    if (side === 'inspector') {
      return Math.max(MIN_INSPECTOR_WIDTH, Math.min(
        MAX_INSPECTOR_WIDTH, Math.floor(window.innerWidth * 0.5),
        (available - rail - stageMinimum) / 2,
        available - rail - renderedWidth('.app-layer-sidebar__content', layersWidth) - stageMinimum,
      ))
    }
    return Math.max(MIN_LAYERS_WIDTH, Math.min(
      MAX_LAYERS_WIDTH, Math.floor(window.innerWidth * 0.7),
      available - rail - renderedWidth('.inspector-panel', inspectorWidth) - stageMinimum,
    ))
  }, [appShellRef, inspectorWidth, layersWidth, renderedWidth])

  useEffect(() => () => {
    layersResizeRef.current?.cleanup()
    inspectorResizeRef.current?.cleanup()
    layersResizeRef.current = undefined
    inspectorResizeRef.current = undefined
  }, [])

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
        const maximum = maximumWidth('layers')
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
        startWidth: renderedWidth('.app-layer-sidebar__content', layersWidth),
        width: renderedWidth('.app-layer-sidebar__content', layersWidth),
        cleanup,
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', end)
      window.addEventListener('blur', end)
      setLayersResizing(true)
    },
    [appShellRef, finishLayersResize, layersWidth, maximumWidth, renderedWidth],
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
      const startWidth = renderedWidth('.inspector-panel', inspectorWidth)
      const move = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX
        const maximum = maximumWidth('inspector')
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
    [appShellRef, finishInspectorResize, inspectorWidth, maximumWidth, renderedWidth],
  )

  const resizeLayersByKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? 40 : 10
      const maximum = maximumWidth('layers')
      const currentWidth = renderedWidth('.app-layer-sidebar__content', layersWidth)
      const width = Math.min(
        maximum,
        Math.max(MIN_LAYERS_WIDTH, currentWidth + (event.key === 'ArrowRight' ? step : -step)),
      )
      setLayersWidth(width)
      onPersistPreferences({ layersWidth: width })
    },
    [layersWidth, maximumWidth, onPersistPreferences, renderedWidth],
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
