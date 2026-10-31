import { describe, expect, it } from 'vitest'
import { createCanvasSpatialIndex } from './canvasSpatialIndex'
import { createCanvasContentIndex } from '../../model/canvasContentIndex'
describe('canvas space index', () => {
  it('finds nested and rotated bounds, and includes giant containers', () => {
    const content = createCanvasContentIndex([
      { id: 'frame', type: 'frame', name: 'Frame', position: { x: 1000, y: 2000 }, size: { width: 100000, height: 100000 }, data: { childIds: ['child'] } },
      { id: 'child', parentId: 'frame', type: 'shape', name: 'Child', position: { x: 100, y: 100 }, size: { width: 200, height: 100 }, data: { kind: 'rectangle', rotation: 90 } },
    ], [])
    const index = createCanvasSpatialIndex(content)
    expect(index.query({ x: 1155, y: 2055, width: 5, height: 5 }).sort()).toEqual(['child', 'frame'])
    index.update([{ id: 'child', bounds: { x: -100, y: -100, width: 20, height: 20 } }])
    expect(index.query({ x: -100, y: -100, width: 10, height: 10 })).toEqual(['child'])
    index.update([{ id: 'child', bounds: null }])
    expect(index.query({ x: -100, y: -100, width: 10, height: 10 })).toEqual([])
  })
})
