import { describe, expect, it } from 'vitest'
import { SpatialHashGrid } from './spatialHashGrid'

describe('SpatialHashGrid', () => {
  it('inserts and queries elements within bounding box', () => {
    const grid = new SpatialHashGrid<{ id: string; x: number; y: number; width: number; height: number }>(100)
    grid.insert({ id: 'a', x: 10, y: 10, width: 50, height: 50 })
    grid.insert({ id: 'b', x: 250, y: 250, width: 50, height: 50 })
    grid.insert({ id: 'c', x: 1000, y: 1000, width: 50, height: 50 })

    const result = grid.queryRect({ x: 0, y: 0, width: 100, height: 100 })
    expect(result.map((i) => i.id)).toEqual(['a'])

    const resultWithBuffer = grid.queryRect({ x: 0, y: 0, width: 100, height: 100 }, 200)
    expect(resultWithBuffer.map((i) => i.id).sort()).toEqual(['a', 'b'])
  })

  it('correctly indexes elements spanning multiple grid cells', () => {
    const grid = new SpatialHashGrid(100)
    grid.insert({ id: 'large', x: 50, y: 50, width: 250, height: 250 })

    expect(grid.queryPoint({ x: 60, y: 60 }).map((i) => i.id)).toEqual(['large'])
    expect(grid.queryPoint({ x: 280, y: 280 }).map((i) => i.id)).toEqual(['large'])
    expect(grid.queryPoint({ x: 400, y: 400 })).toEqual([])
  })

  it('handles negative coordinates correctly', () => {
    const grid = new SpatialHashGrid(100)
    grid.insert({ id: 'neg', x: -150, y: -150, width: 80, height: 80 })

    const result = grid.queryRect({ x: -200, y: -200, width: 100, height: 100 })
    expect(result.map((i) => i.id)).toEqual(['neg'])
    expect(grid.queryPoint({ x: -100, y: -100 }).map((i) => i.id)).toEqual(['neg'])
    expect(grid.queryPoint({ x: 0, y: 0 })).toEqual([])
  })

  it('supports removal and update by id', () => {
    const grid = new SpatialHashGrid(100)
    grid.insert({ id: 'node1', x: 10, y: 10, width: 20, height: 20 })
    expect(grid.size).toBe(1)

    grid.insert({ id: 'node1', x: 500, y: 500, width: 20, height: 20 })
    expect(grid.size).toBe(1)
    expect(grid.queryPoint({ x: 10, y: 10 })).toEqual([])
    expect(grid.queryPoint({ x: 505, y: 505 }).map((i) => i.id)).toEqual(['node1'])

    grid.remove('node1')
    expect(grid.size).toBe(0)
    expect(grid.queryPoint({ x: 505, y: 505 })).toEqual([])
  })

  it('clears all cells properly', () => {
    const grid = new SpatialHashGrid(100)
    grid.insert({ id: 'a', x: 0, y: 0, width: 50, height: 50 })
    grid.insert({ id: 'b', x: 200, y: 200, width: 50, height: 50 })
    expect(grid.size).toBe(2)

    grid.clear()
    expect(grid.size).toBe(0)
    expect(grid.queryRect({ x: -1000, y: -1000, width: 2000, height: 2000 })).toEqual([])
  })
})
