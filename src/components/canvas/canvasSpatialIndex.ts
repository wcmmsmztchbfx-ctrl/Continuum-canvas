import type { CanvasContentIndex } from '../../model/canvasContentIndex'
import { rotatedBounds, type SnapRect } from './smartSnapping'
const CELL = 512
function cells(rect: SnapRect): string[] | undefined {
  const left = Math.floor(rect.x / CELL), top = Math.floor(rect.y / CELL)
  const right = Math.floor((rect.x + rect.width) / CELL), bottom = Math.floor((rect.y + rect.height) / CELL)
  if ((right - left + 1) * (bottom - top + 1) > 64) return undefined
  const keys = []
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) keys.push(x + ':' + y)
  return keys
}
const intersects = (a: SnapRect, b: SnapRect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
export function createCanvasSpatialIndex(content: CanvasContentIndex) {
  const bounds = new Map<string, SnapRect>()
  const grid = new Map<string, Set<string>>()
  const large = new Set<string>()
  const positions = new Map<string, { x: number; y: number }>()
  const absolute = (id: string, visited = new Set<string>()): { x: number; y: number } => {
    const cached = positions.get(id)
    if (cached) return cached
    const node = content.nodeById.get(id)
    if (!node || visited.has(id)) return { x: 0, y: 0 }
    visited.add(id)
    const parent = node.parentId ? absolute(node.parentId, visited) : { x: 0, y: 0 }
    const position = { x: parent.x + node.position.x, y: parent.y + node.position.y }
    positions.set(id, position)
    return position
  }
  const update = (changes: readonly { id: string; bounds: SnapRect | null }[]) => {
    for (const change of changes) {
      const old = bounds.get(change.id)
      if (old) for (const key of cells(old) ?? []) {
        const entries = grid.get(key)
        entries?.delete(change.id)
        if (entries?.size === 0) grid.delete(key)
      }
      large.delete(change.id)
      bounds.delete(change.id)
      if (!change.bounds) continue
      bounds.set(change.id, change.bounds)
      const keys = cells(change.bounds)
      if (!keys) { large.add(change.id); continue }
      for (const key of keys) {
        let entries = grid.get(key)
        if (!entries) { entries = new Set(); grid.set(key, entries) }
        entries.add(change.id)
      }
    }
  }
  for (const node of content.nodeById.values()) {
    const position = absolute(node.id)
    const rect = { id: node.id, x: position.x, y: position.y, width: node.size.width, height: node.size.height }
    const rotation = 'rotation' in node.data && typeof node.data.rotation === 'number' ? node.data.rotation : 0
    update([{ id: node.id, bounds: rotation ? rotatedBounds(rect, rotation) : rect }])
  }
  return {
    update,
    getBounds: (id: string) => bounds.get(id),
    query(rect: SnapRect): string[] {
      const keys = cells(rect)
      const candidates = keys ? new Set(large) : new Set(bounds.keys())
      for (const key of keys ?? []) for (const id of grid.get(key) ?? []) candidates.add(id)
      return [...candidates].filter(id => intersects(bounds.get(id)!, rect))
    },
  }
}
