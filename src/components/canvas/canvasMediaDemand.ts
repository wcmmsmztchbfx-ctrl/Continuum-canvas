import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { CanvasContentIndex } from '../../model/canvasContentIndex'
import type { Viewport } from '../../model/project'
import { createCanvasSpatialIndex } from './canvasSpatialIndex'
import type { SnapRect } from './smartSnapping'
export type MediaDemand = 'active' | 'visible' | 'nearby' | 'background' | 'none'
export type MediaVariant = 128 | 360 | 960 | 1920 | 'original'
type Stage = { width: number; height: number }
const variants: readonly MediaVariant[] = [128, 360, 960, 1920, 'original']
export function chooseMediaVariant(size: number, zoom: number, dpr: number, previous?: MediaVariant): MediaVariant {
  const pixels = size * zoom * Math.min(2, Math.max(1, dpr))
  if (previous && previous !== 'original' && pixels >= previous * .6 && pixels <= previous * 1.25) return previous
  return variants.find(value => value === 'original' || value >= pixels) ?? 'original'
}
export function getCanvasMediaDemand(bounds: SnapRect, viewport: Viewport, stage: Stage, pinned: boolean, previous: MediaDemand): MediaDemand {
  if (pinned) return 'active'
  if (stage.width <= 0 || stage.height <= 0) return 'none'
  const x = bounds.x * viewport.zoom + viewport.x, y = bounds.y * viewport.zoom + viewport.y
  const right = x + bounds.width * viewport.zoom, bottom = y + bounds.height * viewport.zoom
  const intersects = (padding: number) => right >= -padding && bottom >= -padding && x <= stage.width + padding && y <= stage.height + padding
  if (intersects(0)) return 'visible'
  if (intersects(300)) return 'nearby'
  if (previous !== 'none' && intersects(600)) return 'background'
  return 'none'
}
type DemandState = { demand: MediaDemand; variant: MediaVariant }
const empty: DemandState = Object.freeze({ demand: 'none', variant: 360 })
const standalone: DemandState = Object.freeze({ demand: 'visible', variant: 'original' })
export function createCanvasMediaDemand(content: CanvasContentIndex) {
  let spatial = createCanvasSpatialIndex(content)
  let viewport: Viewport = { x: 0, y: 0, zoom: 1 }, stage: Stage = { width: 0, height: 0 }
  const states = new Map<string, DemandState>()
  const listeners = new Map<string, Set<() => void>>()
  const update = (nextViewport: Viewport, nextStage: Stage, quality: boolean) => {
    viewport = nextViewport; stage = nextStage
    const zoom = viewport.zoom
    const range = { x: (-viewport.x - 600) / zoom, y: (-viewport.y - 600) / zoom,
      width: (stage.width + 1200) / zoom, height: (stage.height + 1200) / zoom }
    const candidates = new Set([...spatial.query(range), ...states.keys()])
    for (const id of candidates) {
      const before = states.get(id) ?? empty
      const bounds = spatial.getBounds(id)
      const node = content.nodeById.get(id)
      if (node && node.type !== 'image' && node.type !== 'video') continue
      const demand = bounds && !node?.hidden ? getCanvasMediaDemand(bounds, viewport, stage, false, before.demand) : 'none'
      const variant = bounds && (quality || before.demand === 'none')
        ? chooseMediaVariant(Math.max(bounds.width, bounds.height), zoom, globalThis.devicePixelRatio || 1, before.demand !== 'none' ? before.variant : undefined)
        : before.variant
      if (demand === before.demand && variant === before.variant) continue
      if (demand === 'none') states.delete(id)
      else states.set(id, { demand, variant })
      for (const listener of listeners.get(id) ?? []) listener()
    }
  }
  return {
    update,
    setContent(next: CanvasContentIndex) { if (next === content) return; content = next; spatial = createCanvasSpatialIndex(next); update(viewport, stage, true) },
    get: (id: string) => states.get(id) ?? empty,
    subscribe(id: string, listener: () => void) {
      let subscriptions = listeners.get(id)
      if (!subscriptions) { subscriptions = new Set(); listeners.set(id, subscriptions) }
      subscriptions.add(listener)
      return () => { subscriptions.delete(listener); if (!subscriptions.size) listeners.delete(id) }
    },
  }
}
export const CanvasMediaDemandContext = createContext<ReturnType<typeof createCanvasMediaDemand> | null>(null)
export function useCanvasMediaDemand(id: string, pinned = false): DemandState {
  const manager = useContext(CanvasMediaDemandContext)
  const subscribe = useCallback((listener: () => void) => manager?.subscribe(id, listener) ?? (() => {}), [manager, id])
  const get = useCallback(() => manager?.get(id) ?? standalone, [manager, id])
  const state = useSyncExternalStore(subscribe, get, () => standalone)
  return pinned ? { ...state, demand: 'active' } : state
}
