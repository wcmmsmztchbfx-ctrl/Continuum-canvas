// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }),
    )
    expect(performRedo).toHaveBeenCalled()
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
    input.remove()
  })

  it('switches tool with F, R, T, U and ignores P', () => {
    const onAddNode = vi.fn()
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
        onAddNode,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    expect(setActiveTool).toHaveBeenCalledWith('frame')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))
    expect(setActiveTool).toHaveBeenCalledWith('shape')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
    expect(setActiveTool).toHaveBeenCalledWith('text')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u' }))
    expect(onAddNode).toHaveBeenCalledWith('upload')

    // P (Pen) is deliberately excluded
    setActiveTool.mockClear()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
    expect(setActiveTool).not.toHaveBeenCalled()
  })

  it('triggers redo with Ctrl+Y', () => {
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
      new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }),
    )
    expect(performRedo).toHaveBeenCalled()
  })

  it('toggles layers sidebar with Ctrl+\\', () => {
    const toggleLayers = vi.fn()
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
        toggleLayers,
      }),
    )

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }),
    )
    expect(toggleLayers).toHaveBeenCalled()
  })

  it('fits canvas view with Shift+1', () => {
    const fitView = vi.fn()
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
        fitView,
      }),
    )

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', shiftKey: true }),
    )
    expect(fitView).toHaveBeenCalled()
  })

  it('nudges selected nodes with arrow keys by 1px and Shift+arrows by 10px', () => {
    canvasStore.getState().selectNode('node-1')
    const initialPos = canvasStore.getState().snapshot.nodes.find((n) => n.id === 'node-1')!.position

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

    // ArrowRight (1px)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(
      canvasStore.getState().snapshot.nodes.find((n) => n.id === 'node-1')!.position.x,
    ).toBe(initialPos.x + 1)

    // Shift + ArrowDown (10px)
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }),
    )
    expect(
      canvasStore.getState().snapshot.nodes.find((n) => n.id === 'node-1')!.position.y,
    ).toBe(initialPos.y + 10)
  })

  it('ignores shortcuts when modal is open or IME is composing', () => {
    const toggleLayers = vi.fn()
    renderHook(() =>
      useAppHotkeys({
        hydrated: true,
        modalOpen: true,
        collaborationControllerRef: controllerRef,
        setActiveTool,
        performUndo,
        performRedo,
        copySelectedNodes,
        withBulkLease,
        notify,
        toggleLayers,
      }),
    )

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))
    expect(setActiveTool).not.toHaveBeenCalled()

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }),
    )
    expect(toggleLayers).not.toHaveBeenCalled()
  })
})
