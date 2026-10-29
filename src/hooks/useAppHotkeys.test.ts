// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canvasStore } from '../store/canvas-store'
import { useAppHotkeys } from './useAppHotkeys'

const initialSnapshot = {
  version: 1 as const,
  projectId: 'test-project',
  name: 'Test Canvas',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    {
      id: 'node-1',
      type: 'image' as const,
      name: 'Image 1',
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      data: { url: '' },
    },
    {
      id: 'node-2',
      type: 'text' as const,
      name: 'Text 2',
      position: { x: 200, y: 0 },
      size: { width: 100, height: 50 },
      data: { text: 'Hello' },
    },
  ],
  edges: [],
}

describe('useAppHotkeys', () => {
  const setActiveTool = vi.fn()
  const performUndo = vi.fn()
  const performRedo = vi.fn()
  const copySelectedNodes = vi.fn().mockResolvedValue(undefined)
  const withBulkLease = vi.fn((_ids, action) => action())
  const notify = vi.fn()
  const controllerRef = { current: null }

  beforeEach(() => {
    vi.clearAllMocks()
    canvasStore.getState().restore(JSON.stringify(initialSnapshot))
  })

  afterEach(() => {
    cleanup()
  })

  it('switches tool with V and B keys', () => {
    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))
    expect(setActiveTool).toHaveBeenCalledWith('brush')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }))
    expect(setActiveTool).toHaveBeenCalledWith('select')
  })

  it('clears selection on Escape key', () => {
    canvasStore.getState().selectNode('node-1')
    expect(canvasStore.getState().selectedNodeIds).toEqual(['node-1'])

    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(canvasStore.getState().selectedNodeIds).toEqual([])
  })

  it('selects all nodes with Ctrl+A', () => {
    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }),
    )
    expect(canvasStore.getState().selectedNodeIds).toContain('node-1')
    expect(canvasStore.getState().selectedNodeIds).toContain('node-2')
  })

  it('deletes selected nodes with Delete key via withBulkLease', () => {
    canvasStore.getState().selectNode('node-1')

    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(withBulkLease).toHaveBeenCalledWith(['node-1'], expect.any(Function))
    expect(
      canvasStore.getState().snapshot.nodes.some((n) => n.id === 'node-1'),
    ).toBe(false)
  })

  it('deletes selected edges with Delete key directly', () => {
    canvasStore.getState().restore(
      JSON.stringify({
        ...initialSnapshot,
        edges: [{ id: 'edge-1', source: 'node-1', target: 'node-2', relation: 'flow' }],
      }),
    )
    canvasStore.getState().selectEdge('edge-1')
    expect(canvasStore.getState().selectedEdgeIds).toEqual(['edge-1'])

    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    expect(canvasStore.getState().selectedEdgeIds).toEqual([])
    expect(
      canvasStore.getState().snapshot.edges.some((e) => e.id === 'edge-1'),
    ).toBe(false)
  })

  it('triggers undo and redo with Ctrl+Z and Ctrl+Shift+Z', () => {
    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }),
    )
    expect(performUndo).toHaveBeenCalled()

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Process', code: 'KeyZ', ctrlKey: true }),
    )
    expect(performUndo).toHaveBeenCalledTimes(2)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }),
    )
    expect(performRedo).toHaveBeenCalled()

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Process', code: 'KeyZ', ctrlKey: true, shiftKey: true }),
    )
    expect(performRedo).toHaveBeenCalledTimes(2)
  })

  it.each(['ctrlKey', 'metaKey'] as const)('groups and ungroups the selected nodes with %s shortcuts', (modifier) => {
    canvasStore.getState().selectNodes(['node-1', 'node-2'])
    renderHook(() => useAppHotkeys({
      hydrated: true, collaborationControllerRef: controllerRef,
      setActiveTool, performUndo, performRedo, copySelectedNodes, withBulkLease, notify,
    }))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', [modifier]: true }))
    const group = canvasStore.getState().snapshot.nodes.find((node) => node.type === 'group')
    expect(group).toBeDefined()
    expect(canvasStore.getState().selectedNodeIds).toEqual([group!.id])
    expect(canvasStore.getState().snapshot.nodes.filter((node) => node.parentId === group!.id).map((node) => node.id))
      .toEqual(['node-1', 'node-2'])
    expect(withBulkLease).toHaveBeenLastCalledWith(['node-1', 'node-2'], expect.any(Function))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', [modifier]: true, shiftKey: true }))
    expect(canvasStore.getState().snapshot.nodes.some((node) => node.type === 'group')).toBe(false)
    expect(canvasStore.getState().snapshot.nodes.map((node) => ({ id: node.id, position: node.position, parentId: node.parentId })))
      .toEqual([
        { id: 'node-1', position: { x: 0, y: 0 }, parentId: undefined },
        { id: 'node-2', position: { x: 200, y: 0 }, parentId: undefined },
      ])
  })

  it('leaves selected nodes unchanged when the group lease is refused', () => {
    canvasStore.getState().selectNodes(['node-1', 'node-2'])
    const before = canvasStore.getState().snapshot
    withBulkLease.mockImplementationOnce(() => undefined)
    renderHook(() => useAppHotkeys({
      hydrated: true, collaborationControllerRef: controllerRef,
      setActiveTool, performUndo, performRedo, copySelectedNodes, withBulkLease, notify,
    }))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }))

    expect(canvasStore.getState().snapshot).toBe(before)
    expect(canvasStore.getState().selectedNodeIds).toEqual(['node-1', 'node-2'])
  })

  it('ignores shortcuts when typing inside an input or textarea', () => {
    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
      }),
    )

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', bubbles: true }),
    )
    expect(setActiveTool).not.toHaveBeenCalled()

    document.body.removeChild(input)
  })
})
