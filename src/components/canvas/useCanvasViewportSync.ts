import { useCallback, useEffect, useRef } from 'react'
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

  const writeViewportUi = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport
    workspaceRef.current?.style.setProperty(
      '--canvas-ui-scale',
      String(1 / Math.max(nextViewport.zoom, CANVAS_MIN_ZOOM)),
    )
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
