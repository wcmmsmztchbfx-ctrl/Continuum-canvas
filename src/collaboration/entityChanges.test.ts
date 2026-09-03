import { describe, expect, it } from 'vitest'
import type { CanvasSnapshotV2 } from '../model/project'
import {
  diffCanvasEntities,
  hasCanvasEntityChanges,
} from './entityChanges'

function createEmptySnapshot(name = 'Test'): CanvasSnapshotV2 {
  return {
    version: 2,
    projectId: 'proj-1',
    name,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

describe('entityChanges', () => {
  it('detects no changes between identical empty snapshots', () => {
    const s1 = createEmptySnapshot()
    const s2 = createEmptySnapshot()

    const diff = diffCanvasEntities(s1, s2, 'local')
    expect(hasCanvasEntityChanges(diff)).toBe(false)
    expect(diff.nodes.upserted).toHaveLength(0)
    expect(diff.nodes.removed).toHaveLength(0)
    expect(diff.edges.upserted).toHaveLength(0)
    expect(diff.edges.removed).toHaveLength(0)
  })

  it('detects name rename change', () => {
    const s1 = createEmptySnapshot('Old Name')
    const s2 = createEmptySnapshot('New Name')

    const diff = diffCanvasEntities(s1, s2, 'local')
    expect(hasCanvasEntityChanges(diff)).toBe(true)
    expect(diff.name).toBe('New Name')
  })

  it('detects added, updated, and removed nodes', () => {
    const s1: CanvasSnapshotV2 = {
      ...createEmptySnapshot(),
      nodes: [
        {
          id: 'n-1',
          type: 'image',
          name: 'Image 1',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          data: { url: 'http://example.com/1.png' },
        },
        {
          id: 'n-2',
          type: 'text',
          name: 'Text 2',
          position: { x: 50, y: 50 },
          size: { width: 100, height: 50 },
          data: { text: 'Old' },
        },
      ],
    }

    const s2: CanvasSnapshotV2 = {
      ...createEmptySnapshot(),
      nodes: [
        // n-1 updated
        {
          id: 'n-1',
          type: 'image',
          name: 'Image 1 renamed',
          position: { x: 10, y: 10 },
          size: { width: 100, height: 100 },
          data: { url: 'http://example.com/1.png' },
        },
        // n-2 removed, n-3 added
        {
          id: 'n-3',
          type: 'video',
          name: 'Video 3',
          position: { x: 200, y: 200 },
          size: { width: 300, height: 200 },
          data: { url: 'http://example.com/video.mp4' },
        },
      ],
    }

    const diff = diffCanvasEntities(s1, s2, 'remote')
    expect(hasCanvasEntityChanges(diff)).toBe(true)
    expect(diff.origin).toBe('remote')
    expect(diff.nodes.removed).toEqual(['n-2'])
    expect(diff.nodes.upserted.map((n) => n.id)).toEqual(['n-1', 'n-3'])
  })

  it('detects node reordering without property changes', () => {
    const nodeA = {
      id: 'n-a',
      type: 'image' as const,
      name: 'A',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: '' },
    }
    const nodeB = {
      id: 'n-b',
      type: 'text' as const,
      name: 'B',
      position: { x: 100, y: 100 },
      size: { width: 100, height: 100 },
      data: { text: '' },
    }

    const s1: CanvasSnapshotV2 = {
      ...createEmptySnapshot(),
      nodes: [nodeA, nodeB],
    }
    const s2: CanvasSnapshotV2 = {
      ...createEmptySnapshot(),
      nodes: [nodeB, nodeA],
    }

    const diff = diffCanvasEntities(s1, s2, 'local')
    expect(hasCanvasEntityChanges(diff)).toBe(true)
    expect(diff.nodeOrder).toEqual(['n-b', 'n-a'])
    expect(diff.nodes.upserted).toHaveLength(0)
    expect(diff.nodes.removed).toHaveLength(0)
  })
})
