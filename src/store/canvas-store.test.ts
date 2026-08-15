import { describe, expect, it, vi } from 'vitest'

import { referenceProjectSnapshot } from '../fixtures/reference'
import { parseProjectSnapshot } from '../model/project'
import type { ProjectSnapshot } from '../model/project'
import { canvasStore, createCanvasStore } from './canvas-store'

const initialSnapshot: ProjectSnapshot = {
  version: 1,
  projectId: 'project-1',
  name: 'Test project',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'image-1',
      type: 'image',
      name: 'Image',
      position: { x: 10, y: 20 },
      size: { width: 320, height: 180 },
      data: { url: 'https://example.com/image.png' },
    },
    {
      id: 'text-1',
      type: 'text',
      name: 'Text',
      position: { x: 40, y: 50 },
      size: { width: 200, height: 100 },
      data: { text: 'Hello' },
    },
  ],
  edges: [],
}

describe('default canvas store', () => {
  it('starts from the empty canvas snapshot at default viewport', () => {
    expect(canvasStore.getState().snapshot.nodes).toHaveLength(0)
    expect(canvasStore.getState().snapshot.edges).toHaveLength(0)
    expect(canvasStore.getState().snapshot.viewport).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    })
  })
})

describe('canvas store selection and mode', () => {
  it('starts in select mode with no selected nodes', () => {
    const store = createCanvasStore(initialSnapshot)

    expect(store.getState().mode).toBe('select')
    expect(store.getState().selectedNodeIds).toEqual([])
  })

  it('selects, toggles, and clears existing nodes', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().selectNode('image-1')
    expect(store.getState().selectedNodeIds).toEqual(['image-1'])

    store.getState().selectNode('text-1', true)
    expect(store.getState().selectedNodeIds).toEqual(['image-1', 'text-1'])

    store.getState().selectNode('image-1', true)
    expect(store.getState().selectedNodeIds).toEqual(['text-1'])

    store.getState().selectNode(null)
    expect(store.getState().selectedNodeIds).toEqual([])
  })

  it('ignores unknown node ids and switches interaction mode', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().selectNode('missing')
    expect(store.getState().selectedNodeIds).toEqual([])

    store.getState().setMode('pan')
    expect(store.getState().mode).toBe('pan')

    store.getState().setMode('connect')
    expect(store.getState().mode).toBe('connect')
  })
})

describe('canvas store entity changes', () => {
  it('applies one entity change in one store notification and preserves unchanged identities', () => {
    const store = createCanvasStore({
      ...initialSnapshot,
      edges: [{ id: 'edge-1', source: 'image-1', target: 'text-1', relation: 'flow' }],
    })
    const before = store.getState().snapshot
    const unchangedNode = before.nodes[1]
    const unchangedEdge = before.edges[0]
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().applyEntityChanges({
      origin: 'remote',
      nodes: {
        upserted: [{ ...before.nodes[0]!, name: 'Remote image' }],
        removed: [],
      },
      edges: { upserted: [], removed: [] },
    })

    const after = store.getState().snapshot
    expect(listener).toHaveBeenCalledTimes(1)
    expect(after.nodes[0]?.name).toBe('Remote image')
    expect(after.nodes[1]).toBe(unchangedNode)
    expect(after.edges[0]).toBe(unchangedEdge)
    unsubscribe()
  })

  it('does not notify for materially identical entity changes', () => {
    const store = createCanvasStore(initialSnapshot)
    const before = store.getState().snapshot
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().applyEntityChanges({
      origin: 'remote',
      nodes: { upserted: [structuredClone(before.nodes[0]!)], removed: [] },
      edges: { upserted: [], removed: [] },
    })

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState().snapshot).toBe(before)
    expect(store.getState().snapshot.nodes[0]).toBe(before.nodes[0])
    unsubscribe()
  })

  it('removes incident edges and prunes selection when a remote node is deleted', () => {
    const store = createCanvasStore({
      ...initialSnapshot,
      edges: [{ id: 'edge-1', source: 'image-1', target: 'text-1', relation: 'flow' }],
    })
    store.setState({ selectedNodeIds: ['image-1', 'text-1'] })

    store.getState().applyEntityChanges({
      origin: 'remote',
      nodes: { upserted: [], removed: ['image-1'] },
      edges: { upserted: [], removed: [] },
    })

    expect(store.getState().snapshot.nodes.map((node) => node.id)).toEqual(['text-1'])
    expect(store.getState().snapshot.edges).toEqual([])
    expect(store.getState().selectedNodeIds).toEqual(['text-1'])
  })
})

describe('creative canvas state', () => {
  it('keeps image versions switchable and undoable', () => {
    const store = createCanvasStore(initialSnapshot)
    store.getState().addImageVersion('image-1', {
      id: 'edit-1', url: '/api/assets/edit-1', assetId: 'edit-1',
      createdAt: '2026-08-12T00:00:00.000Z', label: '编辑版本',
    })
    expect(store.getState().snapshot.nodes[0]?.data).toMatchObject({ url: '/api/assets/edit-1', activeVersionId: 'edit-1' })
    store.getState().undo()
    expect(store.getState().snapshot.nodes[0]?.data).toEqual(initialSnapshot.nodes[0]?.data)
  })

  it('moves nodes into frames and releases children when the frame is deleted', () => {
    const store = createCanvasStore({
      ...initialSnapshot,
      nodes: [{ id: 'frame-1', type: 'frame', name: 'Frame', position: { x: 0, y: 0 }, size: { width: 500, height: 400 }, data: { childIds: [], fill: '#222', stroke: '#555', strokeWidth: 1 } }, initialSnapshot.nodes[0]!],
    })
    store.getState().reconcileFrameMembership(['image-1'])
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'image-1')).toMatchObject({ parentId: 'frame-1', position: { x: 10, y: 20 } })
    store.getState().deleteNodes(['frame-1'])
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'image-1')).toMatchObject({ position: { x: 10, y: 20 } })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'image-1')).not.toHaveProperty('parentId')
  })

  it('moves anchored comments and preserves them when their node is deleted', () => {
    const store = createCanvasStore(initialSnapshot)
    store.getState().addComment({ id: 'comment-1', authorId: 'a', authorName: 'A', body: '检查这里', position: { x: 10, y: 20 }, nodeId: 'image-1', createdAt: '2026-08-12T00:00:00.000Z', replies: [] })
    store.getState().moveNode('image-1', { x: 30, y: 45 })
    expect(store.getState().snapshot.comments?.[0]?.position).toEqual({ x: 30, y: 45 })
    store.getState().deleteNodes(['image-1'])
    expect(store.getState().snapshot.comments?.[0]).toMatchObject({ nodeDeleted: true, position: { x: 30, y: 45 } })
  })
})

describe('canvas store node movement history', () => {
  it('moves multiple nodes atomically with one undo entry', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().moveNodes([
      { id: 'image-1', position: { x: 120, y: 240 } },
      { id: 'text-1', position: { x: 75, y: 90 } },
    ])

    expect(
      store.getState().snapshot.nodes.map((node) => node.position),
    ).toEqual([
      { x: 120, y: 240 },
      { x: 75, y: 90 },
    ])

    store.getState().undo()
    expect(store.getState().snapshot).toBe(initialSnapshot)
    expect(store.getState().canUndo).toBe(false)

    store.getState().redo()
    expect(
      store.getState().snapshot.nodes.map((node) => node.position),
    ).toEqual([
      { x: 120, y: 240 },
      { x: 75, y: 90 },
    ])
  })

  it('keeps child positions relative when a multi-node move is persisted', () => {
    const groupedSnapshot: ProjectSnapshot = {
      ...initialSnapshot,
      nodes: [
        {
          id: 'group-1',
          type: 'group',
          name: 'Group',
          position: { x: 100, y: 120 },
          size: { width: 600, height: 400 },
          data: { childIds: ['image-1'] },
        },
        {
          ...initialSnapshot.nodes[0],
          parentId: 'group-1',
          position: { x: 24, y: 32 },
        },
        initialSnapshot.nodes[1],
      ],
    }
    const store = createCanvasStore(groupedSnapshot)

    store.getState().moveNodes([
      { id: 'group-1', position: { x: 140, y: 160 } },
      { id: 'image-1', position: { x: 30, y: 38 } },
    ])

    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'group-1')
        ?.position,
    ).toEqual({ x: 140, y: 160 })
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'image-1'),
    ).toMatchObject({
      parentId: 'group-1',
      position: { x: 30, y: 38 },
    })

    store.getState().undo()
    expect(store.getState().snapshot).toBe(groupedSnapshot)
  })

  it('moves a node without mutating the initial snapshot', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().moveNode('image-1', { x: 120, y: 240 })

    expect(store.getState().snapshot.nodes[0].position).toEqual({
      x: 120,
      y: 240,
    })
    expect(initialSnapshot.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(store.getState().canUndo).toBe(true)
    expect(store.getState().canRedo).toBe(false)
  })

  it('does not record unknown or unchanged node moves', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().moveNode('missing', { x: 1, y: 2 })
    store.getState().moveNode('image-1', { x: 10, y: 20 })

    expect(store.getState().snapshot).toBe(initialSnapshot)
    expect(store.getState().canUndo).toBe(false)
  })

  it('undoes and redoes document changes', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().moveNode('image-1', { x: 120, y: 240 })
    store.getState().undo()

    expect(store.getState().snapshot.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(store.getState().canUndo).toBe(false)
    expect(store.getState().canRedo).toBe(true)

    store.getState().redo()

    expect(store.getState().snapshot.nodes[0].position).toEqual({
      x: 120,
      y: 240,
    })
    expect(store.getState().canUndo).toBe(true)
    expect(store.getState().canRedo).toBe(false)
  })

  it('clears the redo branch after a new document change', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().moveNode('image-1', { x: 120, y: 240 })
    store.getState().undo()
    store.getState().moveNode('text-1', { x: 75, y: 90 })
    store.getState().redo()

    expect(store.getState().snapshot.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(store.getState().snapshot.nodes[1].position).toEqual({ x: 75, y: 90 })
    expect(store.getState().canRedo).toBe(false)
  })
})

describe('canvas store edges', () => {
  it('pastes an imported graph as one normalized undoable transaction', () => {
    const store = createCanvasStore(initialSnapshot)

    const pastedIds = store.getState().pasteImportedGraph({
      nodes: [
        {
          id: 'source-frame',
          type: 'frame',
          name: 'Frame',
          position: { x: 100, y: 100 },
          size: { width: 300, height: 240 },
          data: { childIds: ['source-child', 'missing-child'], fill: '#111111', stroke: '#555555', strokeWidth: 1 },
        },
        {
          id: 'source-child',
          type: 'text',
          name: 'Child',
          parentId: 'source-frame',
          position: { x: 20, y: 30 },
          size: { width: 120, height: 80 },
          data: { text: 'Child', nodeKind: 'text' },
        },
      ],
      edges: [
        { id: 'source-edge', source: 'source-frame', target: 'source-child', relation: 'flow' },
        { id: 'broken-edge', source: 'source-frame', target: 'missing', relation: 'flow' },
      ],
      anchor: { x: 600, y: 400 },
    })

    expect(pastedIds).toHaveLength(2)
    expect(new Set(pastedIds).intersection(new Set(['source-frame', 'source-child']))).toHaveLength(0)
    const pasted = store.getState().snapshot.nodes.filter((node) => pastedIds.includes(node.id))
    const frame = pasted.find((node) => node.type === 'frame')
    const child = pasted.find((node) => node.type === 'text')
    expect(frame).toMatchObject({ position: { x: 600, y: 400 } })
    expect(child).toMatchObject({ parentId: frame?.id, position: { x: 20, y: 30 } })
    expect(frame?.type === 'frame' ? frame.data.childIds : []).toEqual([child?.id])
    expect(store.getState().snapshot.edges).toEqual([
      expect.objectContaining({ source: frame?.id, target: child?.id }),
    ])
    expect(store.getState().selectedNodeIds).toEqual(pastedIds)

    store.getState().undo()
    expect(store.getState().snapshot).toBe(initialSnapshot)
    expect(store.getState().selectedNodeIds).toEqual([])
  })

  it('rejects duplicate imported node ids without leaving incident edges', () => {
    const store = createCanvasStore(initialSnapshot)

    expect(store.getState().pasteImportedGraph({
      nodes: [
        { id: 'duplicate', type: 'text', name: 'First', position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, data: { text: 'A', nodeKind: 'text' } },
        { id: 'duplicate', type: 'text', name: 'Second', position: { x: 20, y: 0 }, size: { width: 10, height: 10 }, data: { text: 'B', nodeKind: 'text' } },
      ],
      edges: [{ id: 'edge', source: 'duplicate', target: 'duplicate', relation: 'flow' }],
      anchor: { x: 0, y: 0 },
    })).toEqual([])
    expect(store.getState().snapshot).toBe(initialSnapshot)
  })

  it('breaks cyclic imported hierarchy before applying the paste anchor', () => {
    const store = createCanvasStore(initialSnapshot)

    const pastedIds = store.getState().pasteImportedGraph({
      nodes: [
        { id: 'a', type: 'frame', name: 'A', parentId: 'b', position: { x: 10, y: 20 }, size: { width: 100, height: 100 }, data: { childIds: ['b'], fill: '#111111', stroke: '#555555', strokeWidth: 1 } },
        { id: 'b', type: 'frame', name: 'B', parentId: 'a', position: { x: 30, y: 40 }, size: { width: 80, height: 80 }, data: { childIds: ['a'], fill: '#111111', stroke: '#555555', strokeWidth: 1 } },
      ],
      edges: [],
      anchor: { x: 700, y: 500 },
    })

    const pasted = store.getState().snapshot.nodes.filter((node) => pastedIds.includes(node.id))
    expect(pasted.some((node) => !node.parentId && node.position.x === 700 && node.position.y === 500)).toBe(true)
  })

  it('adds an edge as an undoable document change', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().addEdge({
      id: 'edge-1',
      source: 'image-1',
      target: 'text-1',
      sourceHandle: 'source',
      targetHandle: 'target',
    })

    expect(store.getState().snapshot.edges).toEqual([
      {
        id: 'edge-1',
        source: 'image-1',
        target: 'text-1',
        sourceHandle: 'source',
        targetHandle: 'target',
      },
    ])
    expect(initialSnapshot.edges).toEqual([])

    store.getState().undo()
    expect(store.getState().snapshot.edges).toEqual([])

    store.getState().redo()
    expect(store.getState().snapshot.edges).toHaveLength(1)
  })

  it('ignores duplicate ids and edges with missing endpoints', () => {
    const store = createCanvasStore(initialSnapshot)
    const edge = { id: 'edge-1', source: 'image-1', target: 'text-1' }

    store.getState().addEdge(edge)
    store.getState().addEdge(edge)
    store
      .getState()
      .addEdge({ id: 'edge-2', source: 'missing', target: 'text-1' })

    expect(store.getState().snapshot.edges).toEqual([edge])

    store.getState().undo()
    expect(store.getState().snapshot).toBe(initialSnapshot)
    expect(store.getState().canUndo).toBe(false)
  })
})

describe('canvas store serialization and restoration', () => {
  it('serializes only the current project snapshot', () => {
    const store = createCanvasStore(initialSnapshot)
    store.getState().selectNode('image-1')
    store.getState().setMode('pan')
    store.getState().moveNode('image-1', { x: 120, y: 240 })

    const serialized = store.getState().serialize()
    const value = JSON.parse(serialized) as Record<string, unknown>

    expect(value).toEqual(store.getState().snapshot)
    expect(value).not.toHaveProperty('selectedNodeIds')
    expect(value).not.toHaveProperty('mode')
    expect(value).not.toHaveProperty('canUndo')
  })

  it('restores v1 JSON and resets transient state and history', () => {
    const store = createCanvasStore(initialSnapshot)
    const restoredSnapshot: ProjectSnapshot = {
      ...initialSnapshot,
      name: 'Restored project',
      viewport: { x: 50, y: 60, zoom: 0.5 },
    }
    store.getState().selectNode('image-1')
    store.getState().setMode('pan')
    store.getState().moveNode('image-1', { x: 120, y: 240 })

    store.getState().restore(JSON.stringify(restoredSnapshot))

    const normalized = parseProjectSnapshot(JSON.stringify(restoredSnapshot))
    expect(store.getState().snapshot).toEqual(normalized)
    expect(store.getState().selectedNodeIds).toEqual([])
    expect(store.getState().mode).toBe('select')
    expect(store.getState().canUndo).toBe(false)
    expect(store.getState().canRedo).toBe(false)

    store.getState().undo()
    expect(store.getState().snapshot).toEqual(normalized)
  })

  it('leaves state unchanged when restoration fails', () => {
    const store = createCanvasStore(initialSnapshot)

    expect(() => store.getState().restore('{bad json')).toThrow(
      'Invalid project snapshot JSON',
    )
    expect(() =>
      store
        .getState()
        .restore(JSON.stringify({ ...initialSnapshot, version: 2 })),
    ).toThrow('Unsupported project snapshot version: 2')

    expect(store.getState().snapshot).toBe(initialSnapshot)
    expect(store.getState().canUndo).toBe(false)
  })
})

describe('canvas store document mutations', () => {
  it('creates a new media node from history at the requested viewport center', () => {
    const store = createCanvasStore(initialSnapshot)
    const nodeId = store.getState().createNodeFromHistory({
      id: 'history-entry',
      projectId: initialSnapshot.projectId,
      jobId: 'job-history',
      outputIndex: 0,
      mediaType: 'image',
      asset: {
        id: '33333333-3333-4333-8333-333333333333',
        filename: 'portrait.png',
        contentType: 'image/png',
        size: 100,
        url: '/api/assets/33333333-3333-4333-8333-333333333333',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
      prompt: 'portrait',
      providerId: 'aistartlab',
      channel: 46,
      model: 'gpt-image-2',
      settings: { quality: '2K', aspectRatio: '9:16', count: 1 },
      references: [],
      completedAt: '2026-07-17T00:01:00.000Z',
    }, { x: 600, y: 400 })

    const created = store.getState().snapshot.nodes.find((node) => node.id === nodeId)
    expect(created).toMatchObject({
      type: 'image',
      position: { x: 465, y: 160 },
      size: { width: 270, height: 480 },
      data: {
        assetId: '33333333-3333-4333-8333-333333333333',
        generation: { jobId: 'job-history', status: 'complete' },
      },
    })
    expect(nodeId).not.toBe('image-1')
    expect(store.getState().selectedNodeIds).toEqual([nodeId])
  })

  it('rejects history entries that belong to another project', () => {
    const store = createCanvasStore(initialSnapshot)
    const before = store.getState().snapshot

    expect(() => store.getState().createNodeFromHistory({
      id: 'history-entry',
      projectId: 'another-project',
      jobId: 'job-history',
      outputIndex: 0,
      mediaType: 'image',
      asset: {
        id: '33333333-3333-4333-8333-333333333333',
        filename: 'portrait.png',
        contentType: 'image/png',
        size: 100,
        url: '/api/assets/33333333-3333-4333-8333-333333333333',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
      prompt: 'portrait',
      providerId: 'aistartlab',
      channel: 46,
      model: 'gpt-image-2',
      settings: { quality: '2K', aspectRatio: '9:16', count: 1 },
      references: [],
      completedAt: '2026-07-17T00:01:00.000Z',
    }, { x: 600, y: 400 })).toThrow('History entry belongs to another project')
    expect(store.getState().snapshot).toBe(before)
  })

  it('renames nodes with normalization and keeps the change undoable', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().renameNode('text-1', `  ${'镜'.repeat(60)}  `)

    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'text-1')?.name,
    ).toBe('镜'.repeat(48))
    expect(store.getState().canUndo).toBe(true)

    store.getState().undo()
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === 'text-1')?.name,
    ).toBe('Text')
  })

  it('ignores empty node names and preserves a special node presentation hint', () => {
    const specialSnapshot: ProjectSnapshot = {
      ...initialSnapshot,
      nodes: [
        {
          id: 'audio-1',
          type: 'text',
          name: '音频节点',
          position: { x: 0, y: 0 },
          size: { width: 320, height: 180 },
          data: { text: '' },
        },
      ],
    }
    const store = createCanvasStore(specialSnapshot)

    store.getState().renameNode('audio-1', '   ')
    expect(store.getState().snapshot.nodes[0]?.name).toBe('音频节点')

    store.getState().renameNode('audio-1', '环境声设计')
    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      name: '环境声设计',
      data: { nodeKind: 'audio' },
    })
  })

  it('persists text edits as undoable document changes', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().updateTextNode('text-1', 'Updated script')

    expect(store.getState().snapshot.nodes[1]).toMatchObject({
      id: 'text-1',
      data: { text: 'Updated script' },
    })
    expect(store.getState().canUndo).toBe(true)

    store.getState().undo()
    expect(store.getState().snapshot.nodes[1]).toMatchObject({
      id: 'text-1',
      data: { text: 'Hello' },
    })
  })

  it('adds, duplicates, resizes, and deletes nodes as undoable changes', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const source = referenceProjectSnapshot.nodes[0]!
    const added = {
      ...source,
      id: 'local-added-node',
      name: '本地新增节点',
      position: { x: 12, y: 34 },
    }

    store.getState().addNode(added)
    expect(store.getState().snapshot.nodes.at(-1)).toEqual(added)

    store.getState().resizeNode(added.id, { width: 640, height: 360 })
    expect(
      store.getState().snapshot.nodes.find((node) => node.id === added.id)?.size,
    ).toEqual({ width: 640, height: 360 })

    store.getState().duplicateNodes([added.id])
    const duplicate = store
      .getState()
      .snapshot.nodes.find((node) => node.id.startsWith(`${added.id}-copy-`))
    expect(duplicate).toMatchObject({
      name: '本地新增节点 - 副本',
      position: { x: 52, y: 74 },
    })

    store.getState().selectNode(added.id)
    store.getState().deleteNodes([added.id])
    expect(
      store.getState().snapshot.nodes.some((node) => node.id === added.id),
    ).toBe(false)
    expect(store.getState().selectedNodeIds).toEqual([])

    store.getState().undo()
    expect(
      store.getState().snapshot.nodes.some((node) => node.id === added.id),
    ).toBe(true)
  })

  it('adds a connected node and its edge as one undoable document change', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const source = referenceProjectSnapshot.nodes[0]!
    const node = {
      id: 'generated-video-node',
      type: 'video' as const,
      name: '视频节点',
      position: { x: source.position.x + source.size.width + 180, y: source.position.y },
      size: { width: 480, height: 270 },
      data: { url: '', referenceNodeIds: [source.id] },
    }
    const edge = {
      id: 'generated-video-edge',
      source: source.id,
      target: node.id,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'canvas',
    }

    store.getState().addConnectedNode(node, edge)

    expect(store.getState().snapshot.nodes).toContainEqual(node)
    expect(store.getState().snapshot.edges).toContainEqual(edge)
    expect(store.getState().selectedNodeIds).toEqual([node.id])

    store.getState().undo()
    expect(
      store.getState().snapshot.nodes.some((candidate) => candidate.id === node.id),
    ).toBe(false)
    expect(
      store.getState().snapshot.edges.some((candidate) => candidate.id === edge.id),
    ).toBe(false)
  })

  it('creates a paid multi-output batch atomically and blocks undo or removal while recoverable', () => {
    const source = initialSnapshot.nodes[0]!
    const store = createCanvasStore(initialSnapshot)
    const targets = [1, 2].map((index) => ({
      id: `result-${index}`,
      type: 'image' as const,
      name: `Result ${index}`,
      position: { x: 200 + index * 120, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: '' },
    }))
    const edges = targets.map((target, index) => ({
      id: `output-${index}`,
      source: source.id,
      target: target.id,
      relation: 'output' as const,
    }))

    expect(
      store.getState().createGenerationBatch({
        projectId: initialSnapshot.projectId,
        sourceNodeId: source.id,
        clientRequestId: 'client-1',
        prompt: 'two outputs',
        createdAt: '2026-07-16T00:00:00.000Z',
        settings: {
          kind: 'image',
          quality: '1K',
          resolution: '1K',
          aspectRatio: '1:1',
          count: 3,
        },
        targetNodes: targets,
        outputEdges: edges,
        existingTargetNodeIds: [source.id],
      }),
    ).toEqual([source.id, ...targets.map((target) => target.id)])
    expect(store.getState().snapshot.nodes).toHaveLength(
      initialSnapshot.nodes.length + 2,
    )
    expect(store.getState().snapshot.edges).toHaveLength(2)

    store.getState().undo()
    store.getState().deleteNodes([source.id, targets[0]!.id])
    expect(store.getState().snapshot.nodes).toHaveLength(
      initialSnapshot.nodes.length + 2,
    )

    for (const [outputIndex, target] of [source, ...targets].entries()) {
      expect(
        store.getState().setMediaGenerationGuarded({
          projectId: initialSnapshot.projectId,
          nodeId: target.id,
          clientRequestId: 'client-1',
          expectedJobId: null,
          generation: {
            prompt: 'two outputs',
            status: 'complete',
            phase: 'complete',
            sourceNodeId: source.id,
            clientRequestId: 'client-1',
            outputIndex,
          },
          asset: {
            assetId: `asset-${outputIndex}`,
            url: `/api/assets/asset-${outputIndex}`,
          },
        }),
      ).toBe(true)
    }

    store.getState().undo()
    expect(store.getState().snapshot.nodes).toEqual(initialSnapshot.nodes)
    expect(store.getState().snapshot.edges).toEqual(initialSnapshot.edges)
  })

  it('does not expose the legacy fake generation store API', () => {
    const state = createCanvasStore(initialSnapshot).getState()

    expect(state).not.toHaveProperty('startGeneration')
    expect(state).not.toHaveProperty('completeGeneration')
  })

  it('persists generation settings on one media node through serialization', () => {
    const store = createCanvasStore(initialSnapshot)
    const settings = {
      kind: 'image' as const,
      quality: 'high' as const,
      resolution: '4K' as const,
      aspectRatio: '4:3' as const,
      count: 4 as const,
    }

    store.getState().updateGenerationSettings('image-1', settings)

    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      data: { generationSettings: settings },
    })
    const restored = createCanvasStore(initialSnapshot)
    restored.getState().restore(store.getState().serialize())
    expect(restored.getState().snapshot.nodes[0]).toMatchObject({
      data: { generationSettings: settings },
    })
  })

  it('resizes image ratios around the node center while quality stays geometry-neutral', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().updateGenerationSettings('image-1', {
      kind: 'image',
      quality: '1K',
      resolution: '1K',
      aspectRatio: '9:16',
      count: 1,
    })

    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: { x: 35, y: -130 },
      size: { width: 270, height: 480 },
      data: {
        generationSettings: {
          aspectRatio: '9:16',
          quality: '1K',
        },
      },
    })

    store.getState().updateGenerationSettings('image-1', {
      kind: 'image',
      quality: '2K',
      resolution: '2K',
      aspectRatio: '9:16',
      count: 1,
    })
    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: { x: 35, y: -130 },
      size: { width: 270, height: 480 },
    })
  })

  it('keeps image geometry unchanged when the requested ratio is Auto', () => {
    const store = createCanvasStore(initialSnapshot)
    const original = store.getState().snapshot.nodes[0]!

    store.getState().updateGenerationSettings('image-1', {
      kind: 'image',
      quality: '1K',
      resolution: '1K',
      aspectRatio: 'Auto',
      count: 1,
    })

    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: original.position,
      size: original.size,
      data: { generationSettings: { aspectRatio: 'Auto' } },
    })
  })

  it('resizes video ratios around the node center while Auto remains neutral', () => {
    const snapshot: ProjectSnapshot = {
      ...initialSnapshot,
      nodes: [{
        id: 'video-1',
        type: 'video',
        name: 'Video',
        position: { x: 10, y: 20 },
        size: { width: 480, height: 270 },
        data: { url: '' },
      }],
    }
    const store = createCanvasStore(snapshot)

    store.getState().updateGenerationSettings('video-1', {
      kind: 'video',
      resolution: '720P',
      aspectRatio: '9:16',
      durationSec: 6,
      generateAudio: false,
      count: 1,
    })
    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: { x: 115, y: -85 },
      size: { width: 270, height: 480 },
      data: { generationSettings: { aspectRatio: '9:16' } },
    })

    const portrait = store.getState().snapshot.nodes[0]!
    store.getState().updateGenerationSettings('video-1', {
      kind: 'video',
      resolution: '720P',
      aspectRatio: 'Auto',
      durationSec: 6,
      generateAudio: false,
      count: 1,
    })
    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: portrait.position,
      size: portrait.size,
      data: { generationSettings: { aspectRatio: 'Auto' } },
    })
  })

  it('records a materially different natural image ratio without rewriting requested settings', () => {
    const generatedSnapshot = structuredClone(initialSnapshot)
    const image = generatedSnapshot.nodes[0]!
    if (image.type !== 'image') throw new Error('Expected image')
    image.data.generation = {
      prompt: 'portrait',
      status: 'complete',
      actualSettings: {
        kind: 'image',
        quality: '2K',
        resolution: '2K',
        aspectRatio: '16:9',
        count: 1,
      },
    }
    const store = createCanvasStore(generatedSnapshot)
    store.getState().updateGenerationSettings('image-1', {
      kind: 'image',
      quality: '2K',
      resolution: '2K',
      aspectRatio: '16:9',
      count: 1,
    })

    store.getState().reconcileImageNaturalSize('image-1', 1440, 2560)

    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      position: { x: 35, y: -130 },
      size: { width: 270, height: 480 },
      data: {
        generationSettings: { aspectRatio: '16:9', quality: '2K' },
        generation: {
          outputAspectRatio: '9:16',
          actualSettings: { aspectRatio: '16:9', quality: '2K' },
        },
      },
    })
  })

  it('persists a media prompt draft through serialization and undo', () => {
    const store = createCanvasStore(initialSnapshot)

    store.getState().updateGenerationPrompt('image-1', '人物从院门走入 @1 ')
    expect(store.getState().snapshot.nodes[0]).toMatchObject({
      data: { promptDraft: '人物从院门走入 @1 ' },
    })

    const restored = createCanvasStore(initialSnapshot)
    restored.getState().restore(store.getState().serialize())
    expect(restored.getState().snapshot.nodes[0]).toMatchObject({
      data: { promptDraft: '人物从院门走入 @1 ' },
    })

    store.getState().undo()
    expect(store.getState().snapshot.nodes[0]).not.toHaveProperty(
      'data.promptDraft',
    )
  })

  it('deletes edges and incident edges when their nodes are removed', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const edge = referenceProjectSnapshot.edges[0]!

    store.getState().deleteEdges([edge.id])
    expect(
      store.getState().snapshot.edges.some((candidate) => candidate.id === edge.id),
    ).toBe(false)

    store.getState().undo()
    store.getState().deleteNodes([edge.source])
    expect(
      store
        .getState()
        .snapshot.edges.some(
          (candidate) =>
            candidate.source === edge.source || candidate.target === edge.source,
        ),
    ).toBe(false)
  })

  it('persists the live viewport without adding an undo history entry', () => {
    const store = createCanvasStore(referenceProjectSnapshot)

    store.getState().setViewport({ x: 120, y: -40, zoom: 0.75 })

    expect(store.getState().snapshot.viewport).toEqual({
      x: 120,
      y: -40,
      zoom: 0.75,
    })
    expect(store.getState().canUndo).toBe(false)
  })

  it('lays out selected nodes on a grid centered around their original centroid', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const originalNodes = referenceProjectSnapshot.nodes.slice(0, 3)
    const nodeIds = originalNodes.map((node) => node.id)

    const origMinX = Math.min(...originalNodes.map((n) => n.position.x))
    const origMaxX = Math.max(...originalNodes.map((n) => n.position.x + (n.size?.width || 400)))
    const origMinY = Math.min(...originalNodes.map((n) => n.position.y))
    const origMaxY = Math.max(...originalNodes.map((n) => n.position.y + (n.size?.height || 300)))
    const origCenterX = (origMinX + origMaxX) / 2
    const origCenterY = (origMinY + origMaxY) / 2

    store.getState().layoutNodes(nodeIds)

    const updatedNodes = store
      .getState()
      .snapshot.nodes.filter((node) => nodeIds.includes(node.id))

    const newMinX = Math.min(...updatedNodes.map((n) => n.position.x))
    const newMaxX = Math.max(...updatedNodes.map((n) => n.position.x + (n.size?.width || 400)))
    const newMinY = Math.min(...updatedNodes.map((n) => n.position.y))
    const newMaxY = Math.max(...updatedNodes.map((n) => n.position.y + (n.size?.height || 300)))
    const newCenterX = (newMinX + newMaxX) / 2
    const newCenterY = (newMinY + newMaxY) / 2

    // Centroid is preserved within rounding tolerances
    expect(Math.abs(newCenterX - origCenterX)).toBeLessThan(100)
    expect(Math.abs(newCenterY - origCenterY)).toBeLessThan(100)
    // Does NOT drift to (0, 0)
    expect(newMinX).toBeGreaterThan(2000)
  })

  it('creates a real parent group with relative child coordinates', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const selected = referenceProjectSnapshot.nodes.slice(0, 2)

    store
      .getState()
      .groupNodes(
        selected.map((node) => node.id),
        'local-group-test',
        '测试分组',
      )

    const snapshot = store.getState().snapshot
    const group = snapshot.nodes.find((node) => node.id === 'local-group-test')
    const children = snapshot.nodes.filter((node) =>
      selected.some((candidate) => candidate.id === node.id),
    )
    expect(group).toMatchObject({
      type: 'group',
      name: '测试分组',
      data: { childIds: selected.map((node) => node.id) },
    })
    expect(children.every((node) => node.parentId === group?.id)).toBe(true)
    expect(snapshot.nodes.indexOf(group!)).toBeLessThan(
      Math.min(...children.map((node) => snapshot.nodes.indexOf(node))),
    )
    expect(children.every((node) => node.position.x >= 0 && node.position.y >= 0)).toBe(
      true,
    )
    expect(store.getState().selectedNodeIds).toEqual(['local-group-test'])

    store.getState().undo()
    expect(
      store.getState().snapshot.nodes.some((node) => node.id === 'local-group-test'),
    ).toBe(false)
  })

  it('requires two top-level nodes and preserves edges while grouping', () => {
    const snapshot: ProjectSnapshot = {
      ...initialSnapshot,
      edges: [
        {
          id: 'edge-1',
          source: 'image-1',
          target: 'text-1',
          type: 'canvas',
        },
      ],
    }
    const store = createCanvasStore(snapshot)

    store.getState().groupNodes(['image-1'], 'single-group', '单节点分组')
    expect(
      store.getState().snapshot.nodes.some((node) => node.id === 'single-group'),
    ).toBe(false)

    store.getState().groupNodes(
      ['image-1', 'text-1'],
      'edge-group',
      '连线分组',
    )
    expect(store.getState().snapshot.edges).toEqual(snapshot.edges)

    store.getState().groupNodes(
      ['image-1', 'text-1'],
      'nested-group',
      '嵌套分组',
    )
    expect(
      store.getState().snapshot.nodes.some((node) => node.id === 'nested-group'),
    ).toBe(false)
  })

  it('ungroups a parent while preserving every child absolute position', () => {
    const store = createCanvasStore(referenceProjectSnapshot)
    const selected = referenceProjectSnapshot.nodes.slice(0, 2)
    const absolutePositions = new Map(
      selected.map((node) => [node.id, node.position]),
    )

    store.getState().groupNodes(
      selected.map((node) => node.id),
      'group-to-release',
      '测试分组',
    )
    store.getState().ungroupNodes(['group-to-release'])

    const snapshot = store.getState().snapshot
    expect(snapshot.nodes.some((node) => node.id === 'group-to-release')).toBe(false)
    for (const child of selected) {
      const released = snapshot.nodes.find((node) => node.id === child.id)
      expect(released?.parentId).toBeUndefined()
      expect(released).toMatchObject({
        position: absolutePositions.get(child.id),
      })
    }
    expect(store.getState().selectedNodeIds).toEqual(selected.map((node) => node.id))
  })
})

describe('canvas store reference relations', () => {
  const referenceSnapshot: ProjectSnapshot = {
    version: 1,
    projectId: 'references',
    name: 'References',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'source-a',
        type: 'image',
        name: 'A',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        data: { url: '/api/assets/a' },
      },
      {
        id: 'source-b',
        type: 'image',
        name: 'B',
        position: { x: 120, y: 0 },
        size: { width: 100, height: 100 },
        data: { url: '/api/assets/b' },
      },
      {
        id: 'source-c',
        type: 'image',
        name: 'C',
        position: { x: 240, y: 0 },
        size: { width: 100, height: 100 },
        data: { url: '/api/assets/c' },
      },
      {
        id: 'target',
        type: 'video',
        name: 'Target',
        position: { x: 360, y: 0 },
        size: { width: 160, height: 90 },
        data: { url: '' },
      },
    ],
    edges: [
      {
        id: 'output-edge',
        source: 'source-c',
        target: 'target',
        relation: 'output',
      },
    ],
  }

  it('assigns the lowest unused alias and keeps remaining aliases stable', () => {
    const store = createCanvasStore(referenceSnapshot)

    const first = store.getState().attachReference('target', 'source-a')
    const second = store.getState().attachReference('target', 'source-b')
    expect(first?.referenceAlias).toBe(1)
    expect(second?.referenceAlias).toBe(2)

    store.getState().detachReference('target', 'source-a')
    expect(
      store.getState().getOrderedReferences('target').map(({ edge, node }) => [
        edge.referenceAlias,
        node.id,
      ]),
    ).toEqual([[2, 'source-b']])

    const reused = store.getState().attachReference('target', 'source-c')
    expect(reused?.referenceAlias).toBe(1)
    expect(
      store.getState().snapshot.edges.find((edge) => edge.id === 'output-edge'),
    ).toMatchObject({ relation: 'output' })
  })

  it('does not duplicate references and never treats output edges as inputs', () => {
    const store = createCanvasStore(referenceSnapshot)

    const first = store.getState().attachReference('target', 'source-a')
    const duplicate = store.getState().attachReference('target', 'source-a')

    expect(duplicate).toEqual(first)
    expect(store.getState().getOrderedReferences('target')).toHaveLength(1)
    expect(
      store.getState().getOrderedReferences('target').some(({ node }) => node.id === 'source-c'),
    ).toBe(false)
  })

  it('duplicates a target with stable references but without transient generation state', () => {
    const snapshot = structuredClone(referenceSnapshot)
    const target = snapshot.nodes.find((node) => node.id === 'target')
    if (!target || target.type !== 'video') throw new Error('Missing video target')
    target.data.promptDraft = 'Use @1 and @2'
    target.data.generationSettings = {
      kind: 'video',
      providerId: 'aistartlab',
      channel: 'video',
      model: 'video-model',
      mode: 'image2video',
      resolution: '720P',
      aspectRatio: '16:9',
      durationSec: 5,
      generateAudio: true,
      count: 1,
    }
    target.data.generation = {
      prompt: 'Use @1 and @2',
      status: 'generating',
      sourceNodeId: 'target',
      phase: 'running',
      jobId: 'job-original',
      clientRequestId: 'request-original',
      progress: 30,
    }
    snapshot.edges.push(
      {
        id: 'reference-a',
        source: 'source-a',
        target: 'target',
        relation: 'reference',
        referenceAlias: 1,
      },
      {
        id: 'reference-b',
        source: 'source-b',
        target: 'target',
        relation: 'reference',
        referenceAlias: 2,
      },
    )
    const store = createCanvasStore(snapshot)

    store.getState().duplicateNodes(['target'])

    const duplicate = store
      .getState()
      .snapshot.nodes.find((node) => node.id.startsWith('target-copy-'))
    expect(duplicate).toMatchObject({
      data: {
        promptDraft: 'Use @1 and @2',
        generationSettings: target.data.generationSettings,
      },
    })
    expect(duplicate?.parentId).toBeUndefined()
    expect(
      duplicate && (duplicate.type === 'image' || duplicate.type === 'video')
        ? duplicate.data.generation
        : 'not-media',
    ).toBeUndefined()
    expect(
      duplicate
        ? store.getState().getOrderedReferences(duplicate.id).map(({ edge, node }) => [
            edge.referenceAlias,
            node.id,
          ])
        : [],
    ).toEqual([
      [1, 'source-a'],
      [2, 'source-b'],
    ])
  })

  it('updates creative geometry and styles as one undoable document change', () => {
    const snapshot = structuredClone(referenceSnapshot)
    snapshot.nodes.push({
      id: 'shape-creative', type: 'shape', name: '矩形', position: { x: 10, y: 20 },
      size: { width: 100, height: 80 },
      data: { kind: 'rectangle', fill: '#ffffff', stroke: '#000000', strokeWidth: 1, opacity: 1 },
    })
    const store = createCanvasStore(snapshot)
    store.getState().updateCreativeNode('shape-creative', {
      position: { x: 30, y: 40 }, size: { width: 240, height: 160 },
      rotation: 30, fill: '#ff0000', radius: 12,
    })
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'shape-creative')).toMatchObject({
      position: { x: 30, y: 40 }, size: { width: 240, height: 160 },
      data: { rotation: 30, fill: '#ff0000', radius: 12 },
    })
    store.getState().undo()
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'shape-creative')).toMatchObject({
      position: { x: 10, y: 20 }, size: { width: 100, height: 80 }, data: { fill: '#ffffff' },
    })
  })

  it('moves a creative object to the front or back of the shared layer order', () => {
    const snapshot = structuredClone(referenceSnapshot)
    const target = snapshot.nodes[1]!
    const store = createCanvasStore(snapshot)
    store.getState().moveNodeLayer(target.id, 'front')
    expect(store.getState().snapshot.nodes.at(-1)?.id).toBe(target.id)
    store.getState().moveNodeLayer(target.id, 'back')
    expect(store.getState().snapshot.nodes[0]?.id).toBe(target.id)
  })

  it('reparents nested frames, preserves absolute position, and rejects cycles', () => {
    const snapshot = structuredClone(referenceSnapshot)
    snapshot.nodes = [
      { id: 'outer', type: 'frame', name: 'Outer', position: { x: 100, y: 100 }, size: { width: 500, height: 500 }, data: { childIds: [], fill: '#111111', stroke: '#555555', strokeWidth: 1 } },
      { id: 'inner', type: 'frame', name: 'Inner', position: { x: 300, y: 300 }, size: { width: 200, height: 200 }, data: { childIds: [], fill: '#111111', stroke: '#555555', strokeWidth: 1 } },
      referenceSnapshot.nodes[0]!,
    ]
    const store = createCanvasStore(snapshot)
    expect(store.getState().reparentNodes(['inner'], 'outer')).toBe(true)
    expect(store.getState().snapshot.nodes.find((node) => node.id === 'inner')).toMatchObject({ parentId: 'outer', position: { x: 200, y: 200 } })
    expect(store.getState().reparentNodes(['outer'], 'inner')).toBe(false)
    store.getState().moveNodesInHierarchy([{ id: referenceSnapshot.nodes[0]!.id, positionAbsolute: { x: 350, y: 360 } }], 'inner')
    expect(store.getState().snapshot.nodes.find((node) => node.id === referenceSnapshot.nodes[0]!.id)).toMatchObject({ parentId: 'inner', position: { x: 50, y: 60 } })
  })

  it('reorders siblings and applies visibility and lock flags to every node type', () => {
    const snapshot = structuredClone(referenceSnapshot)
    const [first, second] = snapshot.nodes
    const store = createCanvasStore(snapshot)
    expect(store.getState().reorderNodes([first!.id], second!.id, 'after')).toBe(true)
    expect(store.getState().snapshot.nodes.findIndex((node) => node.id === first!.id)).toBeGreaterThan(store.getState().snapshot.nodes.findIndex((node) => node.id === second!.id))
    store.getState().setNodeVisibility(first!.id, false)
    store.getState().setNodeLocked(first!.id, true)
    expect(store.getState().snapshot.nodes.find((node) => node.id === first!.id)).toMatchObject({ hidden: true, locked: true })
  })

  it('allows moving, deleting, and resizing nodes freely', () => {
    const generatingSnapshot: ProjectSnapshot = {
      ...initialSnapshot,
      nodes: [
        {
          id: 'gen-image-1',
          type: 'image',
          name: '生成图片',
          position: { x: 100, y: 100 },
          size: { width: 300, height: 200 },
          data: {
            generation: {
              status: 'generating',
              prompt: 'a cinematic cat',
              jobId: 'job-1',
            },
          },
        },
        {
          id: 'static-text-1',
          type: 'text',
          name: '文本',
          position: { x: 500, y: 500 },
          size: { width: 200, height: 100 },
          data: { text: 'Hello' },
        },
      ],
    }
    const store = createCanvasStore(generatingSnapshot)

    // Can move node freely
    store.getState().moveNode('gen-image-1', { x: 200, y: 200 })
    expect(store.getState().snapshot.nodes.find((n) => n.id === 'gen-image-1')?.position).toEqual({ x: 200, y: 200 })

    // Can patch position and size freely
    store.getState().patchNode('gen-image-1', { position: { x: 300, y: 300 }, size: { width: 400, height: 400 } })
    expect(store.getState().snapshot.nodes.find((n) => n.id === 'gen-image-1')?.position).toEqual({ x: 300, y: 300 })
    expect(store.getState().snapshot.nodes.find((n) => n.id === 'gen-image-1')?.size).toEqual({ width: 400, height: 400 })

    // Non-generating node can be deleted
    store.getState().deleteNodes(['static-text-1'])
    expect(store.getState().snapshot.nodes.some((n) => n.id === 'static-text-1')).toBe(false)
  })
})
