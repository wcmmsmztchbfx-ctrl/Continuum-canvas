export interface SpatialItem {
  id?: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * 2D Spatial Hash Grid
 * Efficient O(1) ~ O(K) spatial indexing for canvas geometric queries (snapping, collisions, bounds).
 */
export class SpatialHashGrid<T extends SpatialItem> {
  private readonly cellSize: number
  private readonly cells: Map<string, Set<T>> = new Map()
  private readonly itemCells: Map<T, Set<string>> = new Map()
  private readonly itemById: Map<string, T> = new Map()

  constructor(cellSize = 512) {
    this.cellSize = Math.max(1, cellSize)
  }

  private cellCoord(val: number): number {
    return Math.floor(val / this.cellSize)
  }

  private cellKey(cx: number, cy: number): string {
    return `${cx},${cy}`
  }

  insert(item: T): void {
    if (item.id) {
      if (this.itemById.has(item.id)) {
        this.remove(item.id)
      }
      this.itemById.set(item.id, item)
    }

    const minX = this.cellCoord(item.x)
    const maxX = this.cellCoord(item.x + item.width)
    const minY = this.cellCoord(item.y)
    const maxY = this.cellCoord(item.y + item.height)

    const keys = new Set<string>()
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const key = this.cellKey(cx, cy)
        keys.add(key)
        let cell = this.cells.get(key)
        if (!cell) {
          cell = new Set<T>()
          this.cells.set(key, cell)
        }
        cell.add(item)
      }
    }
    this.itemCells.set(item, keys)
  }

  insertAll(items: Iterable<T>): void {
    for (const item of items) {
      this.insert(item)
    }
  }

  remove(idOrItem: string | T): boolean {
    const item = typeof idOrItem === 'string' ? this.itemById.get(idOrItem) : idOrItem
    if (!item) return false

    if (item.id) {
      this.itemById.delete(item.id)
    }

    const keys = this.itemCells.get(item)
    if (!keys) return false

    for (const key of keys) {
      const cell = this.cells.get(key)
      if (cell) {
        cell.delete(item)
        if (cell.size === 0) {
          this.cells.delete(key)
        }
      }
    }
    this.itemCells.delete(item)
    return true
  }

  clear(): void {
    this.cells.clear()
    this.itemCells.clear()
    this.itemById.clear()
  }

  queryRect(rect: { x: number; y: number; width: number; height: number }, buffer = 0): T[] {
    const minX = this.cellCoord(rect.x - buffer)
    const maxX = this.cellCoord(rect.x + rect.width + buffer)
    const minY = this.cellCoord(rect.y - buffer)
    const maxY = this.cellCoord(rect.y + rect.height + buffer)

    const result = new Set<T>()
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const cell = this.cells.get(this.cellKey(cx, cy))
        if (cell) {
          for (const item of cell) {
            result.add(item)
          }
        }
      }
    }
    return Array.from(result)
  }

  queryPoint(point: { x: number; y: number }): T[] {
    const cx = this.cellCoord(point.x)
    const cy = this.cellCoord(point.y)
    const cell = this.cells.get(this.cellKey(cx, cy))
    if (!cell) return []
    return Array.from(cell)
  }

  get size(): number {
    return this.itemCells.size
  }
}
