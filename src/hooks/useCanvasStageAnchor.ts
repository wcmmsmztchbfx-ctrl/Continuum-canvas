import { useLayoutEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'

import { canvasStore } from '../store/canvas-store'

export function useCanvasStageAnchor(stageRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const measureRef = useRef<(() => void) | undefined>(undefined)

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!enabled || !stage) return
    let active = true
    let previous: { left: number; top: number } | undefined
    const measure = (flush: boolean) => {
      if (!active) return
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
    measureRef.current = () => measure(false)
    const onLayout = () => measure(true)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onLayout)
    resizeObserver?.observe(stage)
    const parent = stage.parentElement
    if (parent) resizeObserver?.observe(parent)
    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(onLayout)
    if (parent) mutations?.observe(parent, { attributes: true })
    window.addEventListener('resize', onLayout)
    return () => {
      active = false
      measureRef.current = undefined
      resizeObserver?.disconnect()
      mutations?.disconnect()
      window.removeEventListener('resize', onLayout)
    }
  }, [enabled, stageRef])

  useLayoutEffect(() => { measureRef.current?.() })
}
