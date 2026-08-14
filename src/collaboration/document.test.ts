import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as Y from 'yjs'

import type {
  CanvasSnapshotV2,
  ProjectSnapshotV1,
} from '../model/project'
import {
  deterministicLegacyCanvasId,
  parseCanvasSnapshot,
} from '../model/project'
import type {
  CollaborationRole,
  CollaborationRoomMetadata,
  CollaborationSession,
  CollaborativeCanvasDocumentV1,
  NodeLease,
  PresenceState,
} from '../contracts/collaboration'
import {
  applyCollaborativeEntityChanges,
  applyCollaborativeCanvasSnapshot,
  applyCollaborativeSnapshotChange,
  COLLABORATIVE_CANVAS_DOCUMENT_VERSION,
  createCollaborativeCanvasDocument,
  exportCollaborativeCanvasSnapshot,
  observeCollaborativeEntityChanges,
} from './document'

function complexSnapshot(): CanvasSnapshotV2 {
  return {
    version: 2,
    canvasId: 'canvas-collaboration',
    projectId: 'project-collaboration',
    name: 'Collaboration fixture',
    viewport: { x: 120, y: -80, zoom: 0.75 },
    nodes: [
      {
        id: 'group-1',
        type: 'group',
        name: 'Scene group',
        position: { x: 400, y: 200 },
        size: { width: 720, height: 480 },
        data: {
          childIds: ['text-1', 'image-target'],
          nodeKind: 'group',
        },
      },
      {
        id: 'text-1',
        type: 'text',
        name: 'Script',
        parentId: 'group-1',
        position: { x: 32, y: 48 },
        size: { width: 320, height: 180 },
        data: {
          text: 'A collaborative line',
          nodeKind: 'script',
        },
      },
      {
        id: 'image-source',
        type: 'image',
        name: 'Reference',
        position: { x: 0, y: 240 },
        size: { width: 360, height: 360 },
        data: {
          url: '/api/assets/reference',
          assetId: 'asset-reference',
          alt: 'Reference portrait',
        },
      },
      {
        id: 'image-target',
        type: 'image',
        name: 'Generated image',
        parentId: 'group-1',
        position: { x: 384, y: 48 },
        size: { width: 270, height: 480 },
        data: {
          url: '/api/assets/generated',
          assetId: 'asset-generated',
          promptDraft: 'Place @1 in the courtyard',
          unresolvedReferenceNodeIds: ['missing-reference'],
          generationSettings: {
            kind: 'image',
            providerId: 'aistartlab',
            catalogVersion: 'catalog-1',
            channel: 46,
            model: 'gpt-image-2',
            mode: 'image2image',
            quality: 'low',
            resolution: '1K',
            aspectRatio: '9:16',
            count: 1,
          },
          generation: {
            prompt: 'Place @1 in the courtyard',
            status: 'complete',
            phase: 'complete',
            jobId: 'job-1',
            progress: 100,
            providerId: 'aistartlab',
            outputAspectRatio: '9:16',
            outputs: [
              {
                assetId: 'asset-generated',
                url: '/api/assets/generated',
                contentType: 'image/png',
                size: 1024,
              },
            ],
            actualSettings: {
              kind: 'image',
              providerId: 'aistartlab',
              catalogVersion: 'catalog-1',
              channel: 46,
              model: 'gpt-image-2',
              mode: 'image2image',
              quality: 'low',
              resolution: '1K',
              aspectRatio: '9:16',
              count: 1,
            },
          },
        },
      },
    ],
    edges: [
      {
        id: 'reference-edge',
        source: 'image-source',
        target: 'image-target',
        sourceHandle: 'output',
        targetHandle: 'input',
        type: 'canvas',
        relation: 'reference',
        referenceAlias: 1,
      },
      {
        id: 'flow-edge',
        source: 'text-1',
        target: 'image-target',
        relation: 'flow',
      },
    ],
  }
}

describe('collaboration contracts', () => {
  it('defines the stable public collaboration contract', () => {
    expect(COLLABORATIVE_CANVAS_DOCUMENT_VERSION).toBe(1)
    expectTypeOf<CollaborationRole>().toEqualTypeOf<
      'owner' | 'editor' | 'viewer'
    >()
    expectTypeOf<CollaborationSession>().toHaveProperty('role')
    expectTypeOf<CollaborationRoomMetadata>().toHaveProperty('ownerId')
    expectTypeOf<PresenceState>().toHaveProperty('selectedNodeIds')
    expectTypeOf<NodeLease>().toHaveProperty('expiresAt')
    expectTypeOf<CollaborativeCanvasDocumentV1>().toHaveProperty('doc')
  })
})

describe('collaborative canvas document', () => {
  it('publishes only transaction-affected entities without exporting a full snapshot', () => {
    const base = parseCanvasSnapshot(JSON.stringify({
      ...complexSnapshot(),
      nodes: [
        { id: 'a', type: 'text', name: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'A' } },
        { id: 'b', type: 'text', name: 'B', position: { x: 200, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'B' } },
      ],
      edges: [{ id: 'a-b', source: 'a', target: 'b', relation: 'flow' }],
    }))
    const collaborative = createCollaborativeCanvasDocument(base)
    const listener = vi.fn()
    const stop = observeCollaborativeEntityChanges(
      collaborative,
      () => 'remote',
      listener,
    )

    collaborative.doc.transact(() => {
      collaborative.doc.getMap<Y.Map<unknown>>('nodes').get('b')?.set('name', 'Changed B')
    }, { type: 'remote-test' })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      origin: 'remote',
      nodes: { upserted: [{ ...base.nodes[1], name: 'Changed B' }], removed: [] },
      edges: { upserted: [], removed: [] },
    })
    stop()
    collaborative.destroy()
  })

  it('keeps a deleted node deleted when a stale peer update arrives and undo restores it', () => {
    const base = parseCanvasSnapshot(JSON.stringify({
      ...complexSnapshot(),
      nodes: [{ id: 'a', type: 'text', name: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'A' } }],
      edges: [],
    }))
    const owner = createCollaborativeCanvasDocument(base)
    const stalePeer = createCollaborativeCanvasDocument()
    Y.applyUpdate(stalePeer.doc, Y.encodeStateAsUpdate(owner.doc))
    const staleBefore = Y.encodeStateVector(stalePeer.doc)

    owner.transact(() => applyCollaborativeEntityChanges(owner, {
      origin: 'local',
      nodes: { upserted: [], removed: ['a'] },
      edges: { upserted: [], removed: [] },
    }))
    stalePeer.transact(() => applyCollaborativeEntityChanges(stalePeer, {
      origin: 'local',
      nodes: { upserted: [{ ...base.nodes[0]!, name: 'Stale edit' }], removed: [] },
      edges: { upserted: [], removed: [] },
    }))
    Y.applyUpdate(owner.doc, Y.encodeStateAsUpdate(stalePeer.doc, staleBefore))

    expect(exportCollaborativeCanvasSnapshot(owner).nodes).toEqual([])
    owner.undoManager.undo()
    expect(exportCollaborativeCanvasSnapshot(owner).nodes).toEqual([base.nodes[0]])
    stalePeer.destroy()
    owner.destroy()
  })

  it('applies entity changes without changing the exported snapshot format', () => {
    const base = parseCanvasSnapshot(JSON.stringify({
      ...complexSnapshot(),
      nodes: [
        { id: 'a', type: 'text', name: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'A' } },
        { id: 'b', type: 'text', name: 'B', position: { x: 200, y: 0 }, size: { width: 100, height: 80 }, data: { text: 'B' } },
      ],
      edges: [{ id: 'a-b', source: 'a', target: 'b', relation: 'flow' }],
    }))
    const collaborative = createCollaborativeCanvasDocument(base)

    collaborative.transact(() => applyCollaborativeEntityChanges(collaborative, {
      origin: 'local', name: 'Changed canvas',
      nodes: {
        upserted: [{ ...base.nodes[1]!, name: 'Changed B' }],
        removed: ['a'],
      },
      edges: { upserted: [], removed: ['a-b'] },
      nodeOrder: ['b'], edgeOrder: [],
    }))

    expect(exportCollaborativeCanvasSnapshot(collaborative)).toMatchObject({
      version: 3,
      canvasId: base.canvasId,
      projectId: base.projectId,
      name: 'Changed canvas',
      nodes: [{ id: 'b', name: 'Changed B' }],
      edges: [],
    })
    collaborative.destroy()
  })
  it('round-trips every durable v2 canvas field without normalization loss', () => {
    const snapshot = parseCanvasSnapshot(JSON.stringify(complexSnapshot()))
    const collaborative = createCollaborativeCanvasDocument(snapshot)

    expect(exportCollaborativeCanvasSnapshot(collaborative)).toEqual(snapshot)
    expect(collaborative.undoManager.undoStack).toHaveLength(0)

    collaborative.destroy()
  })

  it('compatibly upgrades a v1 project before initializing the document', () => {
    const legacy: ProjectSnapshotV1 = {
      version: 1,
      projectId: 'legacy-project',
      name: 'Legacy project',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    }
    const collaborative = createCollaborativeCanvasDocument(legacy)

    expect(exportCollaborativeCanvasSnapshot(collaborative)).toEqual({
      ...legacy,
      version: 3,
      canvasId: deterministicLegacyCanvasId(legacy.projectId),
      name: '画布 1',
      comments: [],
    })

    collaborative.destroy()
  })

  it('rejects snapshot initialization into non-empty collaborative roots', () => {
    const externalDoc = new Y.Doc()
    const staleNode = new Y.Map<unknown>()
    staleNode.set('id', 'stale-node')
    externalDoc.getMap<Y.Map<unknown>>('nodes').set('stale-node', staleNode)

    expect(() =>
      createCollaborativeCanvasDocument(complexSnapshot(), {
        doc: externalDoc,
      }),
    ).toThrow(
      'Cannot initialize collaborative canvas from snapshot: document roots are not empty',
    )
    expect(
      externalDoc.getMap<Y.Map<unknown>>('nodes').get('stale-node'),
    ).toBe(staleNode)

    externalDoc.destroy()
  })

  it('stores editable body and prompt fields as Y.Text', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const nodes = collaborative.doc.getMap<Y.Map<unknown>>('nodes')
    const textData = nodes.get('text-1')?.get('data')
    const imageData = nodes.get('image-target')?.get('data')

    expect(textData).toBeInstanceOf(Y.Map)
    expect((textData as Y.Map<unknown>).get('text')).toBeInstanceOf(Y.Text)
    expect(imageData).toBeInstanceOf(Y.Map)
    expect((imageData as Y.Map<unknown>).get('promptDraft')).toBeInstanceOf(Y.Text)
    const generation = (imageData as Y.Map<unknown>).get('generation')
    expect(generation).toBeInstanceOf(Y.Map)
    expect((generation as Y.Map<unknown>).get('prompt')).toBeInstanceOf(Y.Text)

    collaborative.destroy()
  })

  it('applies a stable-id snapshot diff while preserving collaborative text instances', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const nodes = collaborative.doc.getMap<Y.Map<unknown>>('nodes')
    const textData = nodes.get('text-1')?.get('data') as Y.Map<unknown>
    const promptData = nodes.get('image-target')?.get('data') as Y.Map<unknown>
    const text = textData.get('text')
    const prompt = promptData.get('promptDraft')
    const next = complexSnapshot()
    next.name = 'Renamed together'
    next.viewport = { x: 999, y: 888, zoom: 2 }
    next.nodes = next.nodes
      .filter((node) => node.id !== 'image-source')
      .map((node) => node.id === 'text-1'
        ? { ...node, data: { ...node.data, text: 'A changed collaborative line' } }
        : node.id === 'image-target'
          ? { ...node, data: { ...node.data, promptDraft: 'Place @1 at dusk' } }
          : node)
    next.edges = next.edges.filter((edge) => edge.source !== 'image-source')

    collaborative.transact(() => {
      applyCollaborativeCanvasSnapshot(collaborative, next, {
        includeViewport: false,
      })
    })

    expect(nodes.get('text-1')?.get('data')).toBe(textData)
    expect(textData.get('text')).toBe(text)
    expect((text as Y.Text).toString()).toBe('A changed collaborative line')
    expect(promptData.get('promptDraft')).toBe(prompt)
    expect((prompt as Y.Text).toString()).toBe('Place @1 at dusk')
    expect(nodes.has('image-source')).toBe(false)
    expect(exportCollaborativeCanvasSnapshot(collaborative)).toMatchObject({
      name: 'Renamed together',
      viewport: complexSnapshot().viewport,
      nodes: expect.not.arrayContaining([
        expect.objectContaining({ id: 'image-source' }),
      ]),
    })

    collaborative.undoManager.undo()
    expect(exportCollaborativeCanvasSnapshot(collaborative)).toEqual(
      parseCanvasSnapshot(JSON.stringify(complexSnapshot())),
    )
    collaborative.destroy()
  })

  it('merges offline changes to different nodes and different fields of one node', () => {
    const seed = createCollaborativeCanvasDocument(complexSnapshot())
    const left = createCollaborativeCanvasDocument()
    const right = createCollaborativeCanvasDocument()
    const initial = Y.encodeStateAsUpdate(seed.doc)
    Y.applyUpdate(left.doc, initial)
    Y.applyUpdate(right.doc, initial)
    const base = complexSnapshot()
    const leftNext = structuredClone(base)
    leftNext.nodes[1]!.name = 'Left text name'
    leftNext.nodes[2]!.position.x = 77
    const rightNext = structuredClone(base)
    rightNext.nodes[1]!.position.y = 99
    rightNext.nodes[3]!.name = 'Right image name'

    left.transact(() => applyCollaborativeSnapshotChange(left, base, leftNext))
    right.transact(() => applyCollaborativeSnapshotChange(right, base, rightNext))
    const leftUpdate = Y.encodeStateAsUpdate(left.doc, Y.encodeStateVector(seed.doc))
    const rightUpdate = Y.encodeStateAsUpdate(right.doc, Y.encodeStateVector(seed.doc))
    Y.applyUpdate(left.doc, rightUpdate)
    Y.applyUpdate(right.doc, leftUpdate)

    const leftResult = exportCollaborativeCanvasSnapshot(left)
    expect(exportCollaborativeCanvasSnapshot(right)).toEqual(leftResult)
    expect(leftResult.nodes.find((node) => node.id === 'text-1')).toMatchObject({ name: 'Left text name', position: { x: 32, y: 99 } })
    expect(leftResult.nodes.find((node) => node.id === 'image-source')).toMatchObject({ position: { x: 77, y: 240 } })
    expect(leftResult.nodes.find((node) => node.id === 'image-target')?.name).toBe('Right image name')
    seed.destroy(); left.destroy(); right.destroy()
  })

  it('merges concurrent offline Y.Text edits without replacing the shared text object', () => {
    const seed = createCollaborativeCanvasDocument(complexSnapshot())
    const left = createCollaborativeCanvasDocument()
    const right = createCollaborativeCanvasDocument()
    const initial = Y.encodeStateAsUpdate(seed.doc)
    Y.applyUpdate(left.doc, initial); Y.applyUpdate(right.doc, initial)
    const base = complexSnapshot()
    const leftNext = structuredClone(base)
    const rightNext = structuredClone(base)
    ;(leftNext.nodes[1]!.data as { text: string }).text += ' LEFT'
    ;(rightNext.nodes[1]!.data as { text: string }).text = `RIGHT ${(rightNext.nodes[1]!.data as { text: string }).text}`
    const leftText = ((left.doc.getMap<Y.Map<unknown>>('nodes').get('text-1')!.get('data') as Y.Map<unknown>).get('text'))
    left.transact(() => applyCollaborativeSnapshotChange(left, base, leftNext))
    right.transact(() => applyCollaborativeSnapshotChange(right, base, rightNext))
    const leftUpdate = Y.encodeStateAsUpdate(left.doc, Y.encodeStateVector(seed.doc))
    const rightUpdate = Y.encodeStateAsUpdate(right.doc, Y.encodeStateVector(seed.doc))
    Y.applyUpdate(left.doc, rightUpdate); Y.applyUpdate(right.doc, leftUpdate)
    const result = exportCollaborativeCanvasSnapshot(left)
    expect(exportCollaborativeCanvasSnapshot(right)).toEqual(result)
    expect((result.nodes[1]!.data as { text: string }).text).toContain('LEFT')
    expect((result.nodes[1]!.data as { text: string }).text).toContain('RIGHT')
    expect(((left.doc.getMap<Y.Map<unknown>>('nodes').get('text-1')!.get('data') as Y.Map<unknown>).get('text'))).toBe(leftText)
    seed.destroy(); left.destroy(); right.destroy()
  })

  it('converges concurrent add, delete, and reorder without duplicate order entries', () => {
    const seed = createCollaborativeCanvasDocument(complexSnapshot())
    const left = createCollaborativeCanvasDocument()
    const right = createCollaborativeCanvasDocument()
    const initial = Y.encodeStateAsUpdate(seed.doc)
    Y.applyUpdate(left.doc, initial); Y.applyUpdate(right.doc, initial)
    const base = complexSnapshot()
    const leftNext = structuredClone(base)
    leftNext.nodes = [
      { ...structuredClone(base.nodes[2]!), id: 'left-added', name: 'Left added' },
      ...leftNext.nodes.slice().reverse(),
    ]
    const rightNext = structuredClone(base)
    rightNext.nodes = rightNext.nodes
      .filter((node) => node.id !== 'image-source')
      .slice(1).concat(rightNext.nodes.slice(0, 1))
    rightNext.edges = rightNext.edges.filter((edge) => edge.source !== 'image-source')

    left.transact(() => applyCollaborativeSnapshotChange(left, base, leftNext))
    right.transact(() => applyCollaborativeSnapshotChange(right, base, rightNext))
    const leftUpdate = Y.encodeStateAsUpdate(left.doc, Y.encodeStateVector(seed.doc))
    const rightUpdate = Y.encodeStateAsUpdate(right.doc, Y.encodeStateVector(seed.doc))
    Y.applyUpdate(left.doc, rightUpdate); Y.applyUpdate(right.doc, leftUpdate)

    const result = exportCollaborativeCanvasSnapshot(left)
    expect(exportCollaborativeCanvasSnapshot(right)).toEqual(result)
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length)
    expect([...left.doc.getMap<Y.Map<unknown>>('nodes').values()]
      .every((node) => typeof node.get('__collaborationOrder') === 'number')).toBe(true)
    seed.destroy(); left.destroy(); right.destroy()
  })

  it('keeps stable order storage bounded across repeated reorder transactions', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    let previous = complexSnapshot()
    for (let index = 0; index < 120; index += 1) {
      const next = structuredClone(previous)
      next.nodes = [...next.nodes.slice(1), next.nodes[0]!]
      collaborative.transact(() => applyCollaborativeSnapshotChange(collaborative, previous, next))
      previous = next
    }

    expect([...collaborative.doc.getMap<Y.Map<unknown>>('nodes').values()]
      .every((node) => typeof node.get('__collaborationOrder') === 'number')).toBe(true)
    expect(Y.encodeStateAsUpdate(collaborative.doc).byteLength).toBeLessThan(50_000)
    collaborative.destroy()
  })

  it('undoes only transactions from the current local origin', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const nodes = collaborative.doc.getMap<Y.Map<unknown>>('nodes')
    const textNode = nodes.get('text-1')
    const imageNode = nodes.get('image-target')
    if (!textNode || !imageNode) throw new Error('Expected fixture nodes')

    collaborative.transact(() => textNode.set('name', 'Local rename'))
    collaborative.doc.transact(
      () => imageNode.set('name', 'Remote rename'),
      { memberId: 'remote-member' },
    )

    expect(collaborative.undoManager.undoStack).toHaveLength(1)
    collaborative.undoManager.undo()
    expect(textNode.get('name')).toBe('Script')
    expect(imageNode.get('name')).toBe('Remote rename')

    collaborative.destroy()
  })

  it('keeps every public transaction as a separate undo item', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const textNode = collaborative.doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('text-1')
    if (!textNode) throw new Error('Expected fixture text node')

    collaborative.transact(() => textNode.set('name', 'First rename'))
    collaborative.transact(() => textNode.set('name', 'Second rename'))

    collaborative.undoManager.undo()
    expect(textNode.get('name')).toBe('First rename')
    collaborative.undoManager.undo()
    expect(textNode.get('name')).toBe('Script')

    collaborative.destroy()
  })

  it('converges after applying a Yjs update to an empty peer document', () => {
    const source = createCollaborativeCanvasDocument(complexSnapshot())
    const peer = createCollaborativeCanvasDocument()

    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(source.doc), {
      source: 'remote',
    })

    expect(exportCollaborativeCanvasSnapshot(peer)).toEqual(
      exportCollaborativeCanvasSnapshot(source),
    )
    expect(peer.undoManager.undoStack).toHaveLength(0)

    source.destroy()
    peer.destroy()
  })

  it('destroys only documents owned by the collaborative handle', () => {
    const externalDoc = new Y.Doc()
    const externalDestroyed = vi.fn()
    externalDoc.on('destroy', externalDestroyed)
    const externalHandle = createCollaborativeCanvasDocument(undefined, {
      doc: externalDoc,
    })

    externalHandle.destroy()
    expect(externalDestroyed).not.toHaveBeenCalled()

    const internalHandle = createCollaborativeCanvasDocument()
    const internalDestroyed = vi.fn()
    internalHandle.doc.on('destroy', internalDestroyed)
    internalHandle.destroy()
    expect(internalDestroyed).toHaveBeenCalledOnce()

    externalDoc.destroy()
  })

  it('rejects an unsupported collaborative document version', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    collaborative.doc.getMap('meta').set('version', 2)

    expect(() => exportCollaborativeCanvasSnapshot(collaborative)).toThrow(
      'Unsupported collaborative canvas document version: 2',
    )

    collaborative.destroy()
  })

  it('rejects a remotely supplied structure beyond the decode depth limit', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const data = collaborative.doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('text-1')
      ?.get('data')
    if (!(data instanceof Y.Map)) throw new Error('Expected text node data')
    const payload = new Y.Map<unknown>()
    let cursor = payload
    for (let depth = 0; depth < 40; depth += 1) {
      const child = new Y.Map<unknown>()
      cursor.set('next', child)
      cursor = child
    }
    data.set('payload', payload)

    expect(() => exportCollaborativeCanvasSnapshot(collaborative)).toThrow(
      'Collaborative canvas document exceeds maximum decode depth of 32',
    )

    collaborative.destroy()
  })

  it('rejects a remotely supplied array beyond the per-array limit', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const data = collaborative.doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('text-1')
      ?.get('data')
    if (!(data instanceof Y.Map)) throw new Error('Expected text node data')
    const payload = new Y.Array<number>()
    payload.insert(0, Array.from({ length: 20_001 }, (_, index) => index))
    data.set('payload', payload)

    expect(() => exportCollaborativeCanvasSnapshot(collaborative)).toThrow(
      'Collaborative canvas document exceeds maximum array length of 20000',
    )

    collaborative.destroy()
  })

  it('rejects remote fields and elements beyond the total decode budget', () => {
    const collaborative = createCollaborativeCanvasDocument(complexSnapshot())
    const data = collaborative.doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('text-1')
      ?.get('data')
    if (!(data instanceof Y.Map)) throw new Error('Expected text node data')
    const payload = new Y.Map<unknown>()
    for (let chunk = 0; chunk < 5; chunk += 1) {
      const values = new Y.Array<number>()
      values.insert(0, Array.from({ length: 20_000 }, (_, index) => index))
      payload.set(`chunk-${chunk}`, values)
    }
    data.set('payload', payload)

    expect(() => exportCollaborativeCanvasSnapshot(collaborative)).toThrow(
      'Collaborative canvas document exceeds maximum decoded entries of 100000',
    )

    collaborative.destroy()
  })
})
