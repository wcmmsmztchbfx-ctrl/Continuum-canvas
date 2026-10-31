import { describe, expect, it } from 'vitest'
import { mergeCanvasSnapshots } from './canvasMerge'
import type { CanvasSnapshotV2, CanvasNode } from './project'

const node = (id: string): CanvasNode => ({ id, type: 'text', name: id, position: { x: 0, y: 0 }, size: { width: 200, height: 100 }, data: { text: 'original' } })
const base: CanvasSnapshotV2 = { version: 3, canvasId: 'a', projectId: 'p', name: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('local')], edges: [] }

describe('three-way canvas merge', () => {
  it('keeps local field edits and camera alongside independent remote fields and additions', () => {
    const local = structuredClone(base), remote = structuredClone(base)
    local.nodes[0]!.name = 'My edit'
    local.viewport = { x: 100, y: 200, zoom: .5 }
    remote.nodes[0]!.position = { x: 80, y: 90 }
    remote.nodes.push(node('agent'))
    const result = mergeCanvasSnapshots(base, local, remote)
    expect(result.canvas.nodes.map(n => [n.id, n.name, n.position])).toEqual([
      ['local', 'My edit', { x: 80, y: 90 }], ['agent', 'agent', { x: 0, y: 0 }],
    ])
    expect(result.canvas.viewport).toEqual({ x: 100, y: 200, zoom: .5 })
    expect(result.conflicts).toEqual([])
  })

  it('retains the local field and records both values for a real conflict', () => {
    const local = structuredClone(base), remote = structuredClone(base)
    local.nodes[0]!.name = 'User name'
    remote.nodes[0]!.name = 'Agent name'
    const result = mergeCanvasSnapshots(base, local, remote)
    expect(result.canvas.nodes[0]!.name).toBe('User name')
    expect(result.conflicts).toEqual([{ path: 'nodes.local.name', base: 'local', local: 'User name', remote: 'Agent name' }])
  })

  it('keeps an edited node when the remote deleted it and reports the deletion conflict', () => {
    const local = structuredClone(base), remote = structuredClone(base)
    local.nodes[0]!.name = 'Preserve me'
    remote.nodes = []
    const result = mergeCanvasSnapshots(base, local, remote)
    expect(result.canvas.nodes[0]!.name).toBe('Preserve me')
    expect(result.conflicts[0]!.path).toBe('nodes.local')
    expect(result.conflicts[0]!.remote).toBeUndefined()
  })
})
