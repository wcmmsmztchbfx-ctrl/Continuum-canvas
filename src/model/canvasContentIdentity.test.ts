import { describe, expect, it } from 'vitest'
import { canvasContentIdentity } from './canvasContentIdentity'
import type { CanvasSnapshotV2 } from './project'

describe('canvas content identity', () => {
  it('ignores JSON object key ordering and viewport while retaining ordered content', () => {
    const snapshot: CanvasSnapshotV2 = { version: 3, canvasId: 'a', projectId: 'a', name: 'name',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
    const { canvasId, ...project } = snapshot
    expect(canvasContentIdentity({ ...project, canvasId, viewport: { x: 100, y: 80, zoom: .2 } }))
      .toBe(canvasContentIdentity(snapshot))
    expect(canvasContentIdentity({ ...snapshot, name: 'new' })).not.toBe(canvasContentIdentity(snapshot))
  })
})
