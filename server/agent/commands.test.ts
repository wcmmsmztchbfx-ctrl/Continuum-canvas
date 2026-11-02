import { describe, expect, it } from 'vitest'
import { createCanvasStore } from '../../src/store/canvas-store.ts'
import { defaultInitialCanvas } from '../canvas-storage.ts'
import type { CanvasNode } from '../../src/model/project.ts'
import { parseCanvasSnapshot } from '../../src/model/project.ts'
import { computeCanvasCommand, describeCanvasCommand, listCanvasCommands } from './commands.ts'
import type { CanvasStoreState } from '../../src/store/types.ts'

const node = (id: string, x: number, y = 0, width = 100): CanvasNode => ({ id, type: 'text', name: id, position: { x, y }, size: { width, height: 80 }, data: { text: id } })
const canvas = () => ({ ...defaultInitialCanvas('canvas-test', 'project-test', 'Test'), nodes: [node('a', 0), node('b', 240, 100, 140), node('c', 600, 300)] })
const compute = (name: string, args: Record<string, unknown>, source = canvas()) => computeCanvasCommand(source, name, args, 'operation-test')

describe('canvas command candidates', () => {
  it('discovers one contract per handler and validates every advertised example', () => {
    expect(new Set(listCanvasCommands().map(c => c.name)).size).toBe(listCanvasCommands().length)
    for (const entry of listCanvasCommands()) {
      const contract = describeCanvasCommand(entry.name)
      expect(contract.examples.length).toBeGreaterThan(0)
      for (const example of contract.examples) expect(() => contract.validate(example)).not.toThrow()
    }
  })
  it('preserves grid positions, grouping padding and one-step manual undo', () => {
    for (const [command, args, manual] of [
      ['geometry.layout', { nodeIds: ['a', 'b', 'c'] }, (s: ReturnType<typeof createCanvasStore>['getState'] extends () => infer T ? T : never) => s.layoutNodes(['a', 'b', 'c'])],
      ['hierarchy.group', { nodeIds: ['a', 'b'], name: 'Group' }, (s: ReturnType<typeof createCanvasStore>['getState'] extends () => infer T ? T : never) => s.groupNodes(['a', 'b'], 'agent-node-operation-test', 'Group')],
    ] as const) {
      const before = canvas(); const store = createCanvasStore({ ...structuredClone(before), version: 1 })
      manual(store.getState())
      const savedManual = parseCanvasSnapshot(JSON.stringify({ ...before, ...store.getState().snapshot, version: before.version }))
      expect(compute(command, args, before).snapshot.nodes).toEqual(savedManual.nodes)
      store.getState().undo(); expect(store.getState().snapshot.nodes).toEqual(before.nodes)
      expect(before).toEqual(canvas())
    }
  })
  it('matches container deletion, orphan positions and reference compaction', () => {
    const before = compute('hierarchy.group', { nodeIds: ['a', 'b'], name: 'G' }).snapshot
    const id = before.nodes.find(n => n.type === 'group')!.id
    const store = createCanvasStore({ ...structuredClone(before), version: 1 })
    store.getState().deleteNodes([id])
    expect(compute('nodes.delete', { nodeIds: [id] }, before).snapshot.nodes).toEqual(store.getState().snapshot.nodes)
  })
  it('aligns deterministically in world coordinates and distributes equal free gaps', () => {
    const aligned = compute('geometry.align', { nodeIds: ['a', 'b', 'c'], alignment: 'left' }).snapshot
    expect(aligned.nodes.map(n => n.position.x)).toEqual([0, 0, 0])
    const distributed = compute('geometry.distribute', { nodeIds: ['a', 'b', 'c'], axis: 'x' }).snapshot
    expect(distributed.nodes.map(n => n.position.x)).toEqual([0, 280, 600])
  })
  it('rejects unknown fields, unsupported styles and malformed paths rather than dropping them', () => {
    expect(() => compute('nodes.rename', { nodeId: 'a', name: 'x', script: 'bad' })).toThrow()
    expect(() => compute('styles.set', { nodeId: 'a', style: { radius: 10 } })).toThrow()
    expect(() => compute('path.set', { nodeId: 'a', anchors: [], closed: true })).toThrow()
  })
  it('keeps continuous manual previews to one history entry', () => {
    const before = canvas(); const store = createCanvasStore({ ...before, version: 1 })
    store.getState().patchNode('a', { data: { fontSize: 28 } }, false)
    store.getState().patchNode('a', { data: { fontSize: 32 } }, false)
    expect(store.getState().canUndo).toBe(false)
    store.getState().patchNode('a', { data: { fontSize: 32 } }, true)
    store.getState().undo(); expect(store.getState().snapshot).toEqual({ ...before, version: 1 })
    expect(store.getState().canUndo).toBe(false)
  })
  it('matches existing store rules for geometry, hierarchy, flags and references', () => {
    const media = (id: string): CanvasNode => ({ id, type: 'image', name: id, position: { x: 10, y: 20 }, size: { width: 200, height: 100 }, data: { url: '', promptDraft: '参考 @1 与 @2' } })
    const initial = parseCanvasSnapshot(JSON.stringify({ ...canvas(), nodes: [...canvas().nodes, media('image-a'), media('image-b'), media('image-c'), { id: 'frame', type: 'frame', name: 'Frame', position: { x: 200, y: 100 }, size: { width: 640, height: 420 }, data: { childIds: [] } }] }))
    const cases: [string, Record<string, unknown>, (s: CanvasStoreState) => unknown][] = [
      ['nodes.rename', { nodeId: 'a', name: 'New' }, s => s.renameNode('a', 'New')],
      ['nodes.duplicate', { nodeIds: ['a', 'b'] }, s => s.duplicateNodes(['a', 'b'])],
      ['geometry.move', { moves: [{ nodeId: 'a', position: { x: 50, y: 80 } }] }, s => s.moveNodes([{ id: 'a', position: { x: 50, y: 80 } }])],
      ['geometry.resize', { nodeId: 'a', size: { width: 200, height: 120 } }, s => s.resizeNode('a', { width: 200, height: 120 })],
      ['hierarchy.reparent', { nodeIds: ['a'], parentId: 'frame' }, s => s.reparentNodes(['a'], 'frame')],
      ['hierarchy.reorder', { nodeIds: ['a'], targetId: 'b', placement: 'after' }, s => s.reorderNodes(['a'], 'b', 'after')],
      ['hierarchy.layer', { nodeId: 'a', direction: 'front' }, s => s.moveNodeLayer('a', 'front')],
      ['styles.flags', { nodeId: 'a', visible: false, locked: true }, s => { s.setNodeVisibility('a', false); s.setNodeLocked('a', true) }],
      ['references.attach', { source: 'image-a', target: 'image-b' }, s => s.attachReference('image-b', 'image-a')],
      ['generation.prompt', { nodeId: 'image-a', prompt: '苹果' }, s => s.updateGenerationPrompt('image-a', '苹果')],
      ['generation.settings', { nodeId: 'image-a', settings: { kind: 'image', quality: 'standard', resolution: '2K', aspectRatio: '1:1', count: 4 } }, s => s.updateGenerationSettings('image-a', { kind: 'image', quality: 'standard', resolution: '2K', aspectRatio: '1:1', count: 4 })],
    ]
    for (const [command, parameters, manual] of cases) {
      const store = createCanvasStore({ ...structuredClone(initial), version: 1 }); manual(store.getState())
      const saved = parseCanvasSnapshot(JSON.stringify({ ...initial, ...store.getState().snapshot, version: initial.version }))
      expect(compute(command, parameters, initial).snapshot, command).toEqual(saved)
    }
    const store = createCanvasStore({ ...initial, version: 1 }); store.getState().attachReference('image-c', 'image-a'); store.getState().attachReference('image-c', 'image-b')
    const referenced = parseCanvasSnapshot(JSON.stringify({ ...initial, ...store.getState().snapshot, version: initial.version }))
    store.getState().detachReference('image-c', 'image-a')
    expect(compute('references.detach', { source: 'image-a', target: 'image-c' }, referenced).snapshot.nodes).toEqual(store.getState().snapshot.nodes)
    expect(store.getState().snapshot.nodes.find(n => n.id === 'image-c')!.data).toHaveProperty('promptDraft', '参考 与 @1')
  })
  it('creates all actual types and preserves multilayer style arrays and legacy fallbacks', () => {
    for (const type of ['image', 'video', 'text', 'group', 'frame', 'shape', 'path']) {
      const created = compute('nodes.create', { type, name: type }).snapshot.nodes.at(-1)!
      expect(created.type).toBe(type)
    }
    const source = compute('nodes.create', { type: 'shape', name: 'shape' }).snapshot
    const id = source.nodes.at(-1)!.id
    const style = { fills: [], strokes: [{ id: 's1', color: '#000', width: 2, enabled: true, position: 'outside' }], effects: [{ id: 'fx', type: 'glass', enabled: true, intensity: 0.4 }] }
    const updated = compute('styles.set', { nodeId: id, style }, source).snapshot.nodes.at(-1)!
    expect(updated.data).toMatchObject({ ...style, fill: '#d9d9d9', stroke: '#8c8c8c' })
  })
  it('resolves stable assets through the adapter and retains original image versions', () => {
    const source = compute('nodes.create', { type: 'image', name: 'Image' }).snapshot
    const id = source.nodes.at(-1)!.id
    Object.assign(source.nodes.at(-1)!.data, { url: '/old-image', thumbnailUrl: '/old-preview', assetId: 'old' })
    const associated = computeCanvasCommand(source, 'assets.associate', { nodeId: id, assetId: 'stable' }, 'asset-operation', { assets: { stable: { id: 'stable', url: '/api/assets/stable', contentType: 'image/png' } }, timestamp: '2026-11-02T00:00:00.000Z' }).snapshot
    const image = associated.nodes.find(n => n.id === id)!
    expect(image.data).toMatchObject({ assetId: 'stable', url: '/api/assets/stable', activeVersionId: 'agent-version-asset-operation' })
    expect(image.type === 'image' && image.data.versions).toHaveLength(2)
    expect(image.data).not.toHaveProperty('thumbnailUrl')
    expect(image.type === 'image' && image.data.versions![0].assetId).toBe('old')
    expect(() => compute('assets.associate', { nodeId: id, assetId: 'missing' }, source)).toThrow()
  })
  it('updates legacy flags consistently without changing manual entrypoints', () => {
    const source = compute('nodes.create', { type: 'shape', name: 'Shape' }).snapshot
    const shape = source.nodes.at(-1)!
    Object.assign(shape, { locked: true, hidden: true }); Object.assign(shape.data, { locked: true, hidden: true })
    const updated = compute('styles.flags', { nodeId: shape.id, locked: false, visible: true }, source).snapshot.nodes.at(-1)!
    expect(updated.data).toMatchObject({ locked: false, hidden: false }); expect(Boolean(updated.locked || updated.hidden)).toBe(false)
  })
  it('executes every published example against real typed fixtures, not a mocked handler', () => {
    const fixtures = parseCanvasSnapshot(JSON.stringify({ ...canvas(), nodes: [...canvas().nodes,
      { ...node('group-id', 0), type: 'group', data: { childIds: [] } },
      { ...node('frame-id', 0), type: 'frame', data: { childIds: [] } },
      { ...node('shape-id', 0), type: 'shape', data: { kind: 'rectangle' } },
      { ...node('path-id', 0), type: 'path', data: { kind: 'pen', anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }], closed: false } },
      ...['image-a', 'image-b'].map(id => ({ ...node(id, 0), type: 'image', data: { url: '', activeVersionId: 'version-id', versions: [{ id: 'version-id', url: '/api/assets/old', createdAt: '2026-01-01T00:00:00.000Z' }] } })),
    ], edges: [{ id: 'edge-id', source: 'a', target: 'b', relation: 'flow' }] }))
    for (const entry of listCanvasCommands()) for (const example of describeCanvasCommand(entry.name).examples) {
      expect(() => computeCanvasCommand(fixtures, entry.name, example, `example-${entry.name}`, { assets: { 'asset-id': { id: 'asset-id', url: '/api/assets/asset-id', contentType: 'image/png' } } }), entry.name).not.toThrow()
    }
  })
})
