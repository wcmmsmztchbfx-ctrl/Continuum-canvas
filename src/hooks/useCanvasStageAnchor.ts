import { useLayoutEffect, type RefObject } from 'react'
import { flushSync } from 'react-dom'

import { canvasDiagnostics } from '../performance/canvasDiagnostics'
import { canvasStore } from '../store/canvas-store'
import type { CanvasViewportRuntime } from '../components/canvas/canvasViewportRuntime'

export function useCanvasStageAnchor(stageRef: RefObject<HTMLElement | null>, enabled: boolean, camera?: CanvasViewportRuntime) {

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!enabled || !stage) return
    let active = true
    let commitTimer: ReturnType<typeof setTimeout> | undefined
    let layoutDirty = false
    const commit = () => {
      clearTimeout(commitTimer)
      if (!layoutDirty || !camera) return
      layoutDirty = false
      const local = camera.getLocal(), display = camera.getDisplay()
      // Following owns a different display camera; layout must not end that follow.
      if (local.x !== display.x || local.y !== display.y || local.zoom !== display.zoom) return
      canvasStore.getState().setViewport(local)
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') commit() }
    let previous: { left: number; top: number } | undefined
    const measure = (flush: boolean) => {
      if (!active) return
      canvasDiagnostics.increment('layout.stageReads')
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        previous = undefined
        return
      }
      const before = previous
      previous = { left: rect.left, top: rect.top }
      if (!before) return
      const dx = rect.left - before.left
      const dy = rect.top - before.top
      if (dx === 0 && dy === 0) return
      const compensate = () => {
        if (camera) {
          camera.compensateLayout(dx, dy)
          layoutDirty = true
          clearTimeout(commitTimer)
          commitTimer = setTimeout(commit, 120)
          return
        }
        const state = canvasStore.getState()
        const viewport = state.snapshot.viewport
        state.setViewport({ ...viewport, x: viewport.x - dx, y: viewport.y - dy })
      }
      // Observer callbacks run before paint. Flush React Flow's viewport update
      // in that frame rather than briefly painting at the new stage origin.
      if (flush) flushSync(compensate)
      else compensate()
    }
    measure(false)
    const onLayout = () => measure(true)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onLayout)
    resizeObserver?.observe(stage)
    const parent = stage.parentElement
    if (parent) resizeObserver?.observe(parent)
    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(onLayout)
    if (parent) mutations?.observe(parent, { attributes: true })
    window.addEventListener('resize', onLayout)
    document.addEventListener('visibilitychange', onVisibility)
    parent?.addEventListener('transitionend', commit)
    window.addEventListener('pointerup', commit)
    return () => {
      active = false
      commit()
      resizeObserver?.disconnect()
      mutations?.disconnect()
      window.removeEventListener('resize', onLayout)
      document.removeEventListener('visibilitychange', onVisibility)
      parent?.removeEventListener('transitionend', commit)
      window.removeEventListener('pointerup', commit)
    }
  }, [enabled, stageRef, camera])
}
