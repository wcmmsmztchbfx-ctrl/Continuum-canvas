import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { canvasPerformanceFlags } from '../../performance/canvasPerformanceFlags'
import type { Viewport } from '../../model/project'

export const CANVAS_MIN_ZOOM = 0.1

export interface CanvasViewportSyncOptions {
  workspaceRef: React.RefObject<HTMLDivElement | null>
  initialViewport?: Viewport
  setCollaborationCursor?: (pos: { x: number; y: number }) => void
}

export function useCanvasViewportSync({
  workspaceRef,
  initialViewport = { x: 0, y: 0, zoom: 1 },
  setCollaborationCursor,
}: CanvasViewportSyncOptions) {
  const viewportRef = useRef<Viewport>(initialViewport)
  const viewportFrameRef = useRef<number | null>(null)
  const cursorFrameRef = useRef<number | null>(null)
  const pendingCursorPos = useRef<{ x: number; y: number } | null>(null)
  const lastScaleRef = useRef<string | null>(null)
  const scaledElements = useRef(new Set<HTMLElement | SVGElement>())
  useLayoutEffect(() => {
    const root = workspaceRef.current
    if (!root || !canvasPerformanceFlags.scopedZoomUi) return
    const selector = '.canvas-node-generator, .collaboration-remote-selection > span, .collaboration-remote-cursor > svg, .collaboration-remote-cursor > span, .collaboration-remote-lock > span'
    const add = (element: HTMLElement | SVGElement) => {
      scaledElements.current.add(element)
      element.style.setProperty('--canvas-ui-scale', String(1 / Math.max(viewportRef.current.zoom, CANVAS_MIN_ZOOM)))
    }
    root.querySelectorAll<HTMLElement | SVGElement>(selector).forEach(add)
    const observer = new MutationObserver(records => {
      for (const element of scaledElements.current) if (!root.contains(element)) scaledElements.current.delete(element)
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue
        if (node.matches(selector)) add(node)
        node.querySelectorAll<HTMLElement | SVGElement>(selector).forEach(add)
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => { observer.disconnect(); scaledElements.current.clear() }
  }, [workspaceRef])

  const writeViewportUi = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport
    const nextScale = String(1 / Math.max(nextViewport.zoom, CANVAS_MIN_ZOOM))
    if (lastScaleRef.current !== nextScale) {
      lastScaleRef.current = nextScale
      if (canvasPerformanceFlags.scopedZoomUi) for (const element of scaledElements.current) element.style.setProperty('--canvas-ui-scale', nextScale)
      else workspaceRef.current?.style.setProperty('--canvas-ui-scale', nextScale)
    }
  }, [workspaceRef])

  const scheduleViewportUi = useCallback(
    (nextViewport: Viewport) => {
      viewportRef.current = nextViewport
      if (viewportFrameRef.current !== null) return
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null
        writeViewportUi(viewportRef.current)
      })
    },
    [writeViewportUi],
  )

  const flushViewportUi = useCallback(
    (nextViewport: Viewport) => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
      writeViewportUi(nextViewport)
    },
    [writeViewportUi],
  )

  const scheduleCollaborationCursor = useCallback((pos: { x: number; y: number }) => {
    if (
      typeof window === 'undefined' ||
      typeof requestAnimationFrame !== 'function' ||
      import.meta.env?.MODE === 'test'
    ) {
      setCollaborationCursor?.(pos)
      return
    }
    pendingCursorPos.current = pos
    if (cursorFrameRef.current !== null) return
    cursorFrameRef.current = requestAnimationFrame(() => {
      cursorFrameRef.current = null
      if (pendingCursorPos.current && setCollaborationCursor) {
        setCollaborationCursor(pendingCursorPos.current)
      }
    })
  }, [setCollaborationCursor])

  useEffect(() => {
    return () => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current)
      }
      if (cursorFrameRef.current !== null) {
        cancelAnimationFrame(cursorFrameRef.current)
      }
    }
  }, [])

  return {
    viewportRef,
    writeViewportUi,
    scheduleViewportUi,
    flushViewportUi,
    scheduleCollaborationCursor,
  }
}
