export interface SpatialItem {
  id?: string
  x: number
  y: number
  width: number
  height: number
  _queryStamp?: number
}

/**
 * 2D Spatial Hash Grid
 * Ultra high-performance spatial indexing with Smi integer hashing and zero-allocation queries.
 */
export class SpatialHashGrid<T extends SpatialItem> {
  private readonly cellSize: number
  private readonly cells: Map<number, T[]> = new Map()
  private readonly itemCells: Map<T, number[]> = new Map()
  private readonly itemById: Map<string, T> = new Map()
  private queryStamp = 0

  constructor(cellSize = 512) {
    this.cellSize = Math.max(1, cellSize)
  }

  private cellCoord(val: number): number {
    return Math.floor((Math.abs(val) < 1e-9 ? 0 : val) / this.cellSize)
  }

  /**
   * Packs 2D cell coords into a 32-bit Smi integer (zero heap string allocation in V8).
   * Range: -32,768 to +32,767 cells (covers +/- 16,000,000px canvas space).
   */
  private cellKey(cx: number, cy: number): number {
    return (((cx + 32768) & 0xffff) << 16) | ((cy + 32768) & 0xffff)
  }

  insert(item: T): void {
    if (item.id) {
      if (this.itemById.has(item.id)) {
        this.remove(item.id)
      }
      this.itemById.set(item.id, item)
    }

    const normX = item.width >= 0 ? item.x : item.x + item.width
    const normW = Math.abs(item.width)
    const normY = item.height >= 0 ? item.y : item.y + item.height
    const normH = Math.abs(item.height)

    const minX = this.cellCoord(normX)
    const maxX = this.cellCoord(normX + normW)
    const minY = this.cellCoord(normY)
    const maxY = this.cellCoord(normY + normH)

    const keys: number[] = []
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const key = this.cellKey(cx, cy)
        keys.push(key)
        let cell = this.cells.get(key)
        if (!cell) {
          cell = []
          this.cells.set(key, cell)
        }
        cell.push(item)
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
    const item = typeof idOrItem === 'string'
      ? this.itemById.get(idOrItem)
      : (idOrItem.id && this.itemById.get(idOrItem.id)) ?? idOrItem
    if (!item) return false

    if (item.id) {
      this.itemById.delete(item.id)
    }

    const keys = this.itemCells.get(item)
    if (!keys) return false

    for (const key of keys) {
      const cell = this.cells.get(key)
      if (cell) {
        const idx = cell.indexOf(item)
        if (idx !== -1) {
          cell.splice(idx, 1)
        }
        if (cell.length === 0) {
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

  /**
   * Queries items intersecting rect.
   * Uses query stamping for O(1) deduplication without allocating temporary Set.
   */
  queryRect(
    rect: { x: number; y: number; width: number; height: number },
    buffer = 0,
    out: T[] = [],
  ): T[] {
    const normX = rect.width >= 0 ? rect.x : rect.x + rect.width
    const normW = Math.abs(rect.width)
    const normY = rect.height >= 0 ? rect.y : rect.y + rect.height
    const normH = Math.abs(rect.height)

    const minX = this.cellCoord(normX - buffer)
    const maxX = this.cellCoord(normX + normW + buffer)
    const minY = this.cellCoord(normY - buffer)
    const maxY = this.cellCoord(normY + normH + buffer)

    this.queryStamp += 1
    const stamp = this.queryStamp

    out.length = 0
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const cell = this.cells.get(this.cellKey(cx, cy))
        if (!cell) continue
        for (let i = 0; i < cell.length; i += 1) {
          const item = cell[i]!
          if (item._queryStamp !== stamp) {
            item._queryStamp = stamp
            out.push(item)
          }
        }
      }
    }
    return out
  }

  queryPoint(point: { x: number; y: number }, out: T[] = []): T[] {
    const cx = this.cellCoord(point.x)
    const cy = this.cellCoord(point.y)
    const cell = this.cells.get(this.cellKey(cx, cy))
    out.length = 0
    if (cell) {
      for (let i = 0; i < cell.length; i += 1) {
        out.push(cell[i]!)
      }
    }
    return out
  }

  get size(): number {
    return this.itemCells.size
  }
}
