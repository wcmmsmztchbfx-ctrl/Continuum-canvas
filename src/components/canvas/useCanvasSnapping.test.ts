// @vitest-environment jsdom

import type { ReactFlowInstance } from '@xyflow/react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CanvasNode, FrameNode, ShapeNode } from '../../model/project'
import { createCanvasStore, EMPTY_CANVAS_SNAPSHOT } from '../../store/canvas-store'
import { mapProjectSnapshotToReactFlow, type CanvasFlowEdge, type CanvasFlowNode } from './mapping'
import { useCanvasSnapping } from './useCanvasSnapping'

function shape(id: string, overrides: Partial<ShapeNode> = {}): ShapeNode {
  return {
    id, type: 'shape', name: id,
    position: { x: 0, y: 0 }, size: { width: 100, height: 50 },
    data: { kind: 'rectangle' },
    ...overrides,
  }
}

function frame(id: string, overrides: Partial<FrameNode> = {}): FrameNode {
  return {
    id, type: 'frame', name: id,
    position: { x: 0, y: 0 }, size: { width: 300, height: 300 },
    data: { childIds: [] },
    ...overrides,
  }
}

function createStore(nodes: CanvasNode[]) {
  return createCanvasStore({ ...EMPTY_CANVAS_SNAPSHOT, nodes })
}

afterEach(cleanup)

describe('canvas snapping', () => {
  it('aligns against the visible bounds of rotated nodes', () => {
    const store = createStore([shape('rotated', {
      position: { x: 100, y: 200 },
      data: { kind: 'rectangle', rotation: 90 },
    })])
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null }))

    const [candidate] = result.current.snapCandidates([])

    expect(candidate).toMatchObject({ id: 'rotated', kind: 'node' })
    expect(candidate!.x).toBeCloseTo(125)
    expect(candidate!.y).toBeCloseTo(175)
    expect(candidate!.width).toBeCloseTo(50)
    expect(candidate!.height).toBeCloseTo(100)
  })

  it('offers inset alignment only for frames with enough space on both axes', () => {
    const store = createStore([
      frame('large', { position: { x: 100, y: 200 }, size: { width: 200, height: 160 } }),
      frame('narrow', { size: { width: 64, height: 160 } }),
      frame('short', { size: { width: 200, height: 64 } }),
    ])
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null }))

    expect(result.current.snapCandidates([])).toEqual([
      { id: 'large', x: 100, y: 200, width: 200, height: 160, kind: 'frame' },
      { id: 'large-inner', x: 116, y: 216, width: 168, height: 128, kind: 'frame' },
      { id: 'narrow', x: 0, y: 0, width: 64, height: 160, kind: 'frame' },
      { id: 'short', x: 0, y: 0, width: 200, height: 64, kind: 'frame' },
    ])
  })

  it('omits hidden, locked and excluded nodes including excluded frame insets', () => {
    const store = createStore([
      shape('visible'), shape('hidden', { hidden: true }),
      shape('locked', { locked: true }), frame('moving-frame'),
    ])
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null }))

    expect(result.current.snapCandidates(['moving-frame'])).toEqual([
      { id: 'visible', x: 0, y: 0, width: 100, height: 50, kind: 'node' },
    ])
  })

  it('uses live absolute coordinates before projected positions for nested candidates', () => {
    const store = createStore([
      frame('parent', { position: { x: 200, y: 300 } }),
      shape('nested', { parentId: 'parent' }), shape('fallback'),
    ])
    const projected = mapProjectSnapshotToReactFlow(store.getState().snapshot).nodes
    const flowInstance = {
      getNodes: () => projected.map((node) => node.id === 'parent'
        ? node
        : { ...node, position: { x: 40, y: 50 } }),
      getInternalNode: (id: string) => id === 'nested'
        ? { internals: { positionAbsolute: { x: 240, y: 350 } } }
        : undefined,
    } as ReactFlowInstance<CanvasFlowNode, CanvasFlowEdge>
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance }))

    expect(result.current.snapCandidates(['parent'])).toEqual([
      { id: 'nested', x: 240, y: 350, width: 100, height: 50, kind: 'node' },
      { id: 'fallback', x: 40, y: 50, width: 100, height: 50, kind: 'node' },
    ])
  })

  it('chooses the deepest overlapping frame then the later sibling', () => {
    const store = createStore([
      frame('outer'),
      frame('first-child', { parentId: 'outer' }),
      frame('last-child', { parentId: 'outer' }),
      frame('later-root'),
    ])
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null }))

    expect(result.current.deepestFrameAt({ x: 50, y: 50 }, [])).toBe('last-child')
    expect(result.current.deepestFrameAt({ x: 50, y: 50 }, ['last-child'])).toBe('first-child')
    expect(result.current.deepestFrameAt({ x: 50, y: 50 }, ['first-child', 'last-child'])).toBe('later-root')
    expect(result.current.deepestFrameAt({ x: 500, y: 500 }, [])).toBeUndefined()
  })

  it('returns parent-relative resize geometry without snapping to the node or its descendants', () => {
    // Parent origin is (150, 260): the moving edge at 277 should snap to 280.
    // Closer descendant, hidden and locked edges must not take precedence.
    const store = createStore([
      frame('outer', { position: { x: 100, y: 200 }, size: { width: 1000, height: 1000 } }),
      frame('parent', { parentId: 'outer', position: { x: 50, y: 60 }, size: { width: 800, height: 800 } }),
      frame('resizing', { parentId: 'parent', position: { x: 20, y: 30 }, size: { width: 107, height: 80 } }),
      frame('child', { parentId: 'resizing', position: { x: 108, y: 0 } }),
      shape('grandchild', { parentId: 'child', position: { x: -1, y: 0 } }),
      shape('hidden', { hidden: true, position: { x: 277, y: 290 } }),
      shape('locked', { locked: true, position: { x: 277, y: 290 } }),
      shape('guide', { position: { x: 280, y: 290 }, size: { width: 50, height: 80 } }),
    ])
    const before = store.getState().snapshot
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null }))
    let geometry: ReturnType<typeof result.current.handleCreativeResizeSnap>

    act(() => {
      geometry = result.current.handleCreativeResizeSnap(
        'resizing', { x: 20, y: 30, width: 107, height: 80, direction: [1, 0] },
        { ctrlKey: false, altKey: false },
      )
    })

    expect(geometry!).toEqual({ x: 20, y: 30, width: 110, height: 80 })
    expect(result.current.snapOverlay.guides).toEqual([{ axis: 'x', value: 280, from: 290, to: 370 }])
    expect(store.getState().snapshot).toBe(before)
    expect(store.getState().canUndo).toBe(false)
  })

  it.each([
    { smartSnap: true, snapToGrid: true, ctrlKey: false, width: 190 },
    { smartSnap: false, snapToGrid: true, ctrlKey: false, width: 182 },
    { smartSnap: true, snapToGrid: true, ctrlKey: true, width: 187 },
  ])('respects resize preferences and control override: %j', ({ width, ctrlKey, ...options }) => {
    const store = createStore([
      shape('resizing', { position: { x: 10, y: 10 }, size: { width: 187, height: 100 } }),
      shape('guide', { position: { x: 200, y: 10 }, size: { width: 100, height: 100 } }),
    ])
    const { result } = renderHook(() => useCanvasSnapping({ store, flowInstance: null, ...options }))
    let geometry: ReturnType<typeof result.current.handleCreativeResizeSnap>

    act(() => {
      geometry = result.current.handleCreativeResizeSnap(
        'resizing', { x: 10, y: 10, width: 187, height: 100, direction: [1, 0] },
        { ctrlKey, altKey: true },
      )
    })

    expect(geometry!).toEqual({ x: 10, y: 10, width, height: 100 })
    expect(result.current.snapOverlay.distances).not.toEqual([])
    if (ctrlKey) expect(result.current.snapOverlay.guides).toEqual([])
  })
})
