import type { Viewport } from '../../model/project'
export type ViewportOrigin = 'local' | 'follow' | 'restore' | 'fit'
export type CanvasViewportRuntime = ReturnType<typeof createCanvasViewportRuntime>
const equal = (a: Viewport, b: Viewport) => a.x === b.x && a.y === b.y && a.zoom === b.zoom
export function createCanvasViewportRuntime(initial: Viewport) {
  let display = { ...initial }, local = { ...initial }, disposed = false
  const listeners = new Set<() => void>()
  const notify = () => { if (!disposed) for (const listener of listeners) listener() }
  return {
    getDisplay: () => display,
    getLocal: () => local,
    set(viewport: Viewport, origin: ViewportOrigin) {
      if (disposed || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return
      const changed = !equal(display, viewport)
      display = changed ? { ...viewport } : display
      if (origin !== 'follow' && !equal(local, viewport)) local = { ...viewport }
      if (changed) notify()
    },
    compensateLayout(dx: number, dy: number) {
      if (disposed || (!dx && !dy)) return
      display = { ...display, x: display.x - dx, y: display.y - dy }
      local = { ...local, x: local.x - dx, y: local.y - dy }
      notify()
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() { disposed = true; listeners.clear() },
  }
}
